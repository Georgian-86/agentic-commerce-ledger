// The checkout engine — the single chokepoint for money.
//
// Everything that can cause a payment goes through these functions:
// the in-app shopper agent, the external MCP endpoint that third-party
// AI buyers connect to, and the plain HTTP routes the test suite drives.
// There is one implementation of "may this spend happen", not three
// that drift apart.
//
// The flow, and why each step exists:
//
//   draftOrder      verify the presented Intent Mandate → price the
//                   basket from live inventory → run the Gate → issue a
//                   merchant-signed Cart Mandate that freezes the price
//   confirmCheckout verify the Cart Mandate is ours, unexpired, unspent
//                   and bound to this Intent → re-check stock (things
//                   sell out between drafting and paying) → run the Gate
//                   again in confirm mode → place a ledger hold →
//                   create the payment link → issue a Payment Mandate
//   settlePayment   verify the signature → commit the hold to spend →
//                   record growth metrics. Idempotent, because this is
//                   reached from both the browser redirect and the
//                   webhook, and either can arrive twice.
import { catalog } from "./mcpClient.js";
import { checkGate } from "./gate.js";
import { formatPaise } from "./money.js";
import {
  verifyIntentMandate,
  verifyCartMandate,
  issueCartMandate,
  issuePaymentMandate,
  encodeToken,
} from "./mandate.js";
import * as ledger from "./ledger.js";
import { createDraft, getDraft, updateDraft, findByReferenceOrLinkId } from "./orders.js";
import { createPaymentLink, createRefund, isDemoMode, rail } from "./razorpay.js";
import { recordEvent } from "./audit.js";
import { once } from "./idempotency.js";
import { bestUpsell, recordCompletedOrder, recordBlockedSpend, recordRefund } from "./growth.js";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.COMMERCE_AGENT_PORT || 4200}`;

/* ------------------------------------------------------------------ */
/*  Inventory resolution                                               */
/* ------------------------------------------------------------------ */

async function resolveItems(items) {
  const resolved = [];
  const unavailable = [];
  for (const { product_id, qty } of items) {
    const wanted = Number.isInteger(qty) && qty > 0 ? qty : 1;
    const product = await catalog.getProduct(product_id).catch(() => null);
    if (!product) {
      unavailable.push({ product_id, reason: "not_found" });
      continue;
    }
    const inv = await catalog.checkInventory(product_id, wanted);
    if (!inv.available) {
      unavailable.push({ product_id, name: product.name, reason: "out_of_stock", stock_qty: inv.stock_qty, wanted });
      continue;
    }
    resolved.push({
      product_id,
      name: product.name,
      category: product.category,
      price_paise: product.price_paise,
      qty: wanted,
      line_total_paise: product.price_paise * wanted,
    });
  }
  return { resolved, unavailable };
}

/* ------------------------------------------------------------------ */
/*  Draft                                                              */
/* ------------------------------------------------------------------ */

export async function draftOrder({ mandate, items, agent_id = null, trace_id = null }) {
  const verification = verifyIntentMandate(mandate, { agent_id });
  if (!verification.ok) {
    recordEvent({
      actor: agent_id || "checkout_agent",
      event_type: "mandate_rejected",
      decision: "blocked",
      reason: verification.reason,
      trace_id,
      raw_context: { reason_code: verification.reason_code, stage: "draft" },
    });
    return { status: "blocked", decision: "blocked", reason: verification.reason, reason_code: verification.reason_code };
  }
  const verified = verification.mandate;

  if (!Array.isArray(items) || items.length === 0) {
    return { status: "error", reason: "An order needs at least one item.", reason_code: "empty_order" };
  }

  const { resolved, unavailable } = await resolveItems(items);
  if (unavailable.length) {
    const failed = unavailable[0];
    const alternative = await bestUpsell(failed.product_id).catch(() => null);
    recordEvent({
      actor: "checkout_agent",
      mandate_id: verified.mandate_id,
      event_type: "draft_unavailable",
      decision: "failed",
      reason:
        failed.reason === "not_found"
          ? `No product with id "${failed.product_id}" exists in this catalog.`
          : `${failed.name} has ${failed.stock_qty} in stock but ${failed.wanted} were requested — the order could not be priced.`,
      trace_id,
      raw_context: { unavailable },
    });
    return {
      status: "unavailable",
      unavailable_items: unavailable,
      alternative: alternative ? { product_id: alternative.id, name: alternative.name, price_paise: alternative.price_paise } : null,
      reason:
        failed.reason === "not_found"
          ? `No product with id "${failed.product_id}" exists in this catalog.`
          : `${failed.name} only has ${failed.stock_qty} left, and ${failed.wanted} were requested.`,
    };
  }

  const total_paise = resolved.reduce((sum, i) => sum + i.line_total_paise, 0);
  const categories = [...new Set(resolved.map((i) => i.category))];

  const gateResult = checkGate({ mandate: verified, categories, amount_paise: total_paise, agent_id, isConfirmStep: false });

  const draft = createDraft({
    mandate_id: verified.mandate_id,
    items: resolved,
    categories,
    total_paise,
    baseline_paise: total_paise,
    trace_id,
    agent_id,
  });
  updateDraft(draft.id, { status: gateResult.decision === "approved" ? "drafted" : gateResult.decision });

  // A merchant-signed Cart Mandate is only issued for carts that could
  // actually proceed. Signing a blocked cart would be the merchant
  // attesting to a price it has already refused to honour.
  let cartMandate = null;
  if (gateResult.decision !== "blocked") {
    cartMandate = issueCartMandate({ intentMandate: verified, items: resolved, total_paise, order_draft_id: draft.id });
    updateDraft(draft.id, { cart_mandate: cartMandate });
  } else {
    recordBlockedSpend(total_paise);
  }

  recordEvent({
    actor: "checkout_agent",
    mandate_id: verified.mandate_id,
    order_draft_id: draft.id,
    event_type: "order_drafted",
    decision: gateResult.decision,
    reason: gateResult.reason,
    trace_id,
    raw_context: {
      items: resolved,
      total_paise,
      categories,
      cart_id: cartMandate?.cart_id || null,
      balance: gateResult.balance || null,
    },
  });

  let upsell_suggestion = null;
  if (gateResult.decision !== "blocked") {
    const best = await bestUpsell(resolved[0].product_id).catch(() => null);
    // Only suggest something the mandate could actually afford on top
    // of the current cart — suggesting an unaffordable add-on is just
    // setting up a block the shopper didn't ask for.
    if (best) {
      const headroom = (gateResult.balance?.available_paise ?? 0) - total_paise;
      if (best.price_paise <= headroom) {
        updateDraft(draft.id, { upsell_product_id: best.id });
        upsell_suggestion = {
          product_id: best.id,
          name: best.name,
          price_paise: best.price_paise,
          reason: best.reason,
          rationale: best.rationale,
        };
      }
    }
  }

  return {
    status: gateResult.decision === "approved" ? "drafted" : gateResult.decision,
    order_draft_id: draft.id,
    items: resolved,
    total: formatPaise(total_paise),
    total_paise,
    decision: gateResult.decision,
    reason: gateResult.reason,
    reason_code: gateResult.reason_code,
    balance: gateResult.balance || null,
    threshold_paise: gateResult.threshold_paise ?? null,
    cart_mandate: cartMandate,
    cart_mandate_token: cartMandate ? encodeToken(cartMandate) : null,
    upsell_suggestion,
  };
}

/* ------------------------------------------------------------------ */
/*  Confirm                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {object}  p
 * @param {object}  p.mandate            presented Intent Mandate
 * @param {string}  p.order_draft_id
 * @param {object}  [p.cart_mandate]     the merchant-signed cart, if the caller is an
 *                                       external agent presenting it back to us
 * @param {boolean} [p.accept_upsell]
 * @param {boolean} [p.human_confirmed]  set only by a path that genuinely obtained a
 *                                       human's explicit approval (the dashboard's
 *                                       Confirm & Pay button, or an MCP elicitation
 *                                       the client answered "accept" to)
 */
export async function confirmCheckout({
  mandate,
  order_draft_id,
  cart_mandate = null,
  accept_upsell = false,
  agent_id = null,
  trace_id = null,
  human_confirmed = false,
}) {
  // Idempotency is keyed on the order, so a retried confirm returns the
  // first result rather than creating a second payment link and a
  // second ledger hold for the same basket.
  //
  // Only an outcome that actually held budget and minted a payment link
  // is worth caching. A needs_confirmation must NOT be — the whole
  // point of it is that the caller goes and gets a human, then comes
  // back. Cache it and the approved retry gets handed the refusal that
  // sent it away in the first place, and the order can never complete.
  const { replayed, value } = await once(
    "confirm",
    order_draft_id,
    () => confirmCheckoutInner({ mandate, order_draft_id, cart_mandate, accept_upsell, agent_id, trace_id, human_confirmed }),
    (result) => result?.status === "awaiting_payment" || result?.status === "paid"
  );
  if (replayed && value?.status === "awaiting_payment") {
    recordEvent({
      actor: agent_id || "checkout_agent",
      mandate_id: value.mandate_id || null,
      order_draft_id,
      event_type: "confirm_replayed",
      decision: "approved",
      reason: `Duplicate confirm_checkout for order ${order_draft_id} — returned the original payment link instead of creating a second one. No additional funds were held.`,
      trace_id,
      raw_context: { idempotent: true },
    });
  }
  return { ...value, replayed };
}

async function confirmCheckoutInner({ mandate, order_draft_id, cart_mandate, accept_upsell, agent_id, trace_id, human_confirmed }) {
  const verification = verifyIntentMandate(mandate, { agent_id });
  if (!verification.ok) {
    recordEvent({
      actor: agent_id || "checkout_agent",
      order_draft_id,
      event_type: "mandate_rejected",
      decision: "blocked",
      reason: verification.reason,
      trace_id,
      raw_context: { reason_code: verification.reason_code, stage: "confirm" },
    });
    return { status: "blocked", reason: verification.reason, reason_code: verification.reason_code };
  }
  const verified = verification.mandate;

  const draft = getDraft(order_draft_id);
  if (!draft) {
    return { status: "error", reason: `No order draft with id "${order_draft_id}".`, reason_code: "unknown_order" };
  }
  if (draft.mandate_id !== verified.mandate_id) {
    const reason = `Order ${order_draft_id} was drafted under mandate ${draft.mandate_id}, but mandate ${verified.mandate_id} was presented to confirm it.`;
    recordEvent({
      actor: agent_id || "checkout_agent",
      mandate_id: verified.mandate_id,
      order_draft_id,
      event_type: "checkout_blocked",
      decision: "blocked",
      reason,
      trace_id,
    });
    return { status: "blocked", reason, reason_code: "mandate_order_mismatch" };
  }
  if (draft.status === "paid") {
    return { status: "paid", reason: `Order ${order_draft_id} has already been paid.`, order_draft_id, total_paise: draft.total_paise };
  }

  // Verify the merchant-signed cart. If the caller presented one back
  // to us (external agent flow) we check that exact document; otherwise
  // we check the one we stored when drafting.
  const presentedCart = cart_mandate || draft.cart_mandate;
  if (!presentedCart) {
    return {
      status: "blocked",
      reason: `Order ${order_draft_id} has no signed cart mandate — it was blocked at draft time and was never priced.`,
      reason_code: "no_cart_mandate",
    };
  }

  // Validity check only — consume: false. The cart's nonce is a
  // one-time authorisation for one payment, so it must not be burned
  // here: this same call can still return needs_confirmation, and the
  // caller will come back with a human's approval expecting the same
  // cart to still be valid. The nonce is spent at the single point
  // below where a payment actually proceeds.
  const upsellRequested = Boolean(accept_upsell && draft.upsell_product_id && !draft.upsell_accepted);
  let activeCart = presentedCart;
  const cartCheck = verifyCartMandate(activeCart, verified, { consume: false, order_draft_id });
  if (!cartCheck.ok) {
    recordEvent({
      actor: agent_id || "checkout_agent",
      mandate_id: verified.mandate_id,
      order_draft_id,
      event_type: "cart_mandate_rejected",
      decision: "blocked",
      reason: cartCheck.reason,
      trace_id,
      raw_context: { reason_code: cartCheck.reason_code },
    });
    return { status: "blocked", reason: cartCheck.reason, reason_code: cartCheck.reason_code };
  }

  // Accepting an upsell changes the basket, so the frozen price no
  // longer describes what is being bought. Re-price and re-sign rather
  // than quietly charging more than the signed cart said.
  let items = [...draft.items];
  let total_paise = draft.total_paise;
  if (upsellRequested) {
    const upsellProduct = await catalog.getProduct(draft.upsell_product_id).catch(() => null);
    const inv = upsellProduct ? await catalog.checkInventory(draft.upsell_product_id, 1) : { available: false };
    if (upsellProduct && inv.available) {
      items.push({
        product_id: upsellProduct.id,
        name: upsellProduct.name,
        category: upsellProduct.category,
        price_paise: upsellProduct.price_paise,
        qty: 1,
        line_total_paise: upsellProduct.price_paise,
      });
      total_paise += upsellProduct.price_paise;
      updateDraft(order_draft_id, { items, total_paise, upsell_accepted: true });
      const reissued = issueCartMandate({ intentMandate: verified, items, total_paise, order_draft_id });
      updateDraft(order_draft_id, { cart_mandate: reissued });
      activeCart = reissued; // the frozen price now reflects the new basket
      recordEvent({
        actor: "checkout_agent",
        mandate_id: verified.mandate_id,
        order_draft_id,
        event_type: "cart_repriced",
        decision: "approved",
        reason: `Upsell accepted — ${upsellProduct.name} added and the cart re-signed at ${formatPaise(total_paise)}. The previous signed total no longer applies.`,
        trace_id,
        raw_context: { cart_id: reissued.cart_id, total_paise },
      });
    }
  }

  // Stock can vanish between drafting and confirming. This is the seam
  // the live failure-rehearsal moment hooks into.
  const { unavailable } = await resolveItems(items.map((i) => ({ product_id: i.product_id, qty: i.qty })));
  if (unavailable.length) {
    const failed = unavailable[0];
    updateDraft(order_draft_id, { status: "failed" });
    ledger.release(order_draft_id, "checkout_failed");
    const alternative = await bestUpsell(failed.product_id).catch(() => null);
    const reason = `${failed.name || failed.product_id} sold out between drafting and confirmation (${failed.stock_qty ?? 0} left, ${failed.wanted ?? 1} needed) — the order was stopped before any payment was created.`;
    recordEvent({
      actor: "checkout_agent",
      mandate_id: verified.mandate_id,
      order_draft_id,
      event_type: "checkout_failed",
      decision: "failed",
      reason,
      trace_id,
      raw_context: { unavailable },
    });
    return {
      status: "failed",
      order_draft_id,
      reason,
      reason_code: "out_of_stock",
      alternative: alternative
        ? { product_id: alternative.id, name: alternative.name, price_paise: alternative.price_paise, reason: alternative.reason }
        : null,
    };
  }

  const categories = [...new Set(items.map((i) => i.category))];
  const gateResult = checkGate({
    mandate: verified,
    categories,
    amount_paise: total_paise,
    agent_id,
    isConfirmStep: human_confirmed,
  });

  if (gateResult.decision === "blocked") {
    updateDraft(order_draft_id, { status: "blocked" });
    recordBlockedSpend(total_paise);
    recordEvent({
      actor: "checkout_agent",
      mandate_id: verified.mandate_id,
      order_draft_id,
      event_type: "checkout_blocked",
      decision: "blocked",
      reason: gateResult.reason,
      trace_id,
      raw_context: { total_paise, reason_code: gateResult.reason_code },
    });
    return { status: "blocked", order_draft_id, reason: gateResult.reason, reason_code: gateResult.reason_code };
  }

  if (gateResult.decision === "needs_confirmation") {
    updateDraft(order_draft_id, { status: "needs_confirmation" });
    recordEvent({
      actor: "checkout_agent",
      mandate_id: verified.mandate_id,
      order_draft_id,
      event_type: "confirmation_required",
      decision: "needs_confirmation",
      reason: gateResult.reason,
      trace_id,
      raw_context: { total_paise, threshold_paise: gateResult.threshold_paise },
    });
    return {
      status: "needs_confirmation",
      order_draft_id,
      reason: gateResult.reason,
      reason_code: gateResult.reason_code,
      total_paise,
      total: formatPaise(total_paise),
      threshold_paise: gateResult.threshold_paise,
    };
  }

  // This is the point of no return: the gate approved, a human (if one
  // was required) said yes, and stock is confirmed. Burn the cart's
  // one-time nonce now, so nothing can replay this exact signed cart
  // against a second payment. `consume: true` here is the only place
  // it happens.
  const consumed = verifyCartMandate(activeCart, verified, { consume: true, order_draft_id });
  if (!consumed.ok) {
    return { status: "blocked", order_draft_id, reason: consumed.reason, reason_code: consumed.reason_code };
  }

  // Place the hold BEFORE calling Razorpay. If the payment link call
  // fails we release; if we called Razorpay first we could end up with
  // a live payment link and no reserved budget behind it.
  const hold = ledger.reserve(verified, order_draft_id, total_paise);
  if (!hold.ok) {
    updateDraft(order_draft_id, { status: "blocked" });
    recordBlockedSpend(total_paise);
    recordEvent({
      actor: "checkout_agent",
      mandate_id: verified.mandate_id,
      order_draft_id,
      event_type: "checkout_blocked",
      decision: "blocked",
      reason: hold.reason,
      trace_id,
      raw_context: { reason_code: hold.reason_code },
    });
    return { status: "blocked", order_draft_id, reason: hold.reason, reason_code: hold.reason_code };
  }

  let link;
  try {
    link = await createPaymentLink({
      amount_paise: total_paise,
      description: items.map((i) => `${i.qty}x ${i.name}`).join(", "),
      reference_id: order_draft_id,
      callback_url: `${PUBLIC_BASE_URL}/payment-callback`,
      notes: { mandate_id: verified.mandate_id, cart_id: cartCheck.cart.cart_id },
    });
  } catch (err) {
    ledger.release(order_draft_id, "payment_link_failed");
    updateDraft(order_draft_id, { status: "failed" });
    const reason = `Razorpay declined to create a payment link for ${formatPaise(total_paise)}: ${String(err?.error?.description || err?.message || err)}. The ${formatPaise(total_paise)} hold on this mandate has been released.`;
    recordEvent({
      actor: "checkout_agent",
      mandate_id: verified.mandate_id,
      order_draft_id,
      event_type: "payment_link_failed",
      decision: "failed",
      reason,
      trace_id,
      raw_context: { error: String(err?.message || err) },
    });
    return { status: "failed", order_draft_id, reason, reason_code: "payment_link_failed" };
  }

  const paymentMandate = issuePaymentMandate({
    intentMandate: verified,
    cartMandate: getDraft(order_draft_id).cart_mandate,
    payment_reference: link.id,
    amount_paise: total_paise,
    rail: rail(),
  });

  updateDraft(order_draft_id, { status: "awaiting_payment", payment_link: link, payment_mandate: paymentMandate });

  recordEvent({
    actor: "checkout_agent",
    mandate_id: verified.mandate_id,
    order_draft_id,
    event_type: "checkout_approved",
    decision: "approved",
    reason: `${gateResult.reason} ${formatPaise(total_paise)} is now held against the mandate and a ${isDemoMode() ? "simulated" : "test-mode"} Razorpay payment link has been issued. The hold becomes a spend only when a signed payment confirmation arrives.`,
    trace_id,
    raw_context: {
      payment_link_id: link.id,
      total_paise,
      payment_mandate_id: paymentMandate.payment_mandate_id,
      rail: rail(),
      balance: ledger.balance(verified),
    },
  });

  return {
    status: "awaiting_payment",
    order_draft_id,
    mandate_id: verified.mandate_id,
    total: formatPaise(total_paise),
    total_paise,
    payment_link: link.short_url,
    payment_link_id: link.id,
    payment_mandate: paymentMandate,
    demo_mode: isDemoMode(),
    balance: ledger.balance(verified),
  };
}

/* ------------------------------------------------------------------ */
/*  Settlement                                                         */
/* ------------------------------------------------------------------ */

/**
 * Commit a verified payment. Reached from both the browser redirect and
 * the webhook, and both can fire for the same payment — so this is
 * idempotent on the order id, and a second arrival is recorded as a
 * recognised duplicate rather than silently double-counting revenue.
 */
export async function settlePayment({ order_draft_id, payment_id, source, trace_id = null }) {
  const { replayed, value } = await once("settle", order_draft_id, async () => {
    const draft = getDraft(order_draft_id);
    if (!draft) return { ok: false, reason: `No order draft "${order_draft_id}" for this payment.` };

    const commit = ledger.commit(order_draft_id);
    updateDraft(order_draft_id, { status: "paid", payment_id });
    recordCompletedOrder({
      baseline_paise: draft.baseline_paise,
      actual_paise: draft.total_paise,
      upsell_accepted: draft.upsell_accepted,
    });

    recordEvent({
      actor: "checkout_agent",
      mandate_id: draft.mandate_id,
      order_draft_id,
      event_type: "payment_verified",
      decision: "approved",
      reason: `Signature verified via ${source}. Payment ${payment_id} captured for ${formatPaise(draft.total_paise)} — the authorisation hold on mandate ${draft.mandate_id} is now a settled spend.`,
      trace_id,
      raw_context: {
        payment_id,
        source,
        committed_paise: commit.ok ? commit.amount_paise : null,
        payment_mandate_id: draft.payment_mandate?.payment_mandate_id || null,
      },
    });
    return { ok: true, order_draft_id, payment_id, total_paise: draft.total_paise, mandate_id: draft.mandate_id };
  });

  if (replayed) {
    const draft = getDraft(order_draft_id);
    recordEvent({
      actor: "checkout_agent",
      mandate_id: draft?.mandate_id || null,
      order_draft_id,
      event_type: "payment_duplicate_ignored",
      decision: "approved",
      reason: `Duplicate payment confirmation for order ${order_draft_id} arrived via ${source} and was recognised as a replay. Revenue was counted once; the ledger was not touched a second time.`,
      trace_id,
      raw_context: { payment_id, source, idempotent: true },
    });
  }

  return { ...value, replayed };
}

/** Release a hold on an abandoned or cancelled checkout. */
export function abandonCheckout(order_draft_id, reason) {
  const draft = getDraft(order_draft_id);
  if (!draft || draft.status === "paid") return { ok: false };
  const released = ledger.release(order_draft_id, "abandoned");
  updateDraft(order_draft_id, { status: "expired" });
  if (released.ok) {
    recordEvent({
      actor: "checkout_agent",
      mandate_id: draft.mandate_id,
      order_draft_id,
      event_type: "hold_released",
      decision: "approved",
      reason: `${reason} ${formatPaise(released.amount_paise)} has been returned to mandate ${draft.mandate_id}'s available balance.`,
      raw_context: { amount_paise: released.amount_paise },
    });
  }
  return released;
}

/* ------------------------------------------------------------------ */
/*  Refund                                                             */
/* ------------------------------------------------------------------ */

export async function refundOrder({ order_draft_id, reason, agent_id = null, trace_id = null }) {
  const draft = getDraft(order_draft_id);
  if (!draft) return { status: "error", reason: `No order "${order_draft_id}".` };
  if (draft.status !== "paid") {
    return { status: "error", reason: `Order ${order_draft_id} is "${draft.status}" — only a captured payment can be refunded.` };
  }

  const { value } = await once("refund", order_draft_id, async () => {
    const refund = await createRefund({
      payment_id: draft.payment_id,
      amount_paise: draft.total_paise,
      order_draft_id,
      reason,
    });
    ledger.reverse(draft.mandate_id, draft.total_paise);
    recordRefund(draft.total_paise);
    updateDraft(order_draft_id, { status: "refunded" });
    recordEvent({
      actor: agent_id || "checkout_agent",
      mandate_id: draft.mandate_id,
      order_draft_id,
      event_type: "payment_refunded",
      decision: "approved",
      reason: `Refund ${refund.id} issued for ${formatPaise(draft.total_paise)} against payment ${draft.payment_id}. ${formatPaise(draft.total_paise)} has been returned to mandate ${draft.mandate_id}'s budget. Stated reason: ${reason}`,
      trace_id,
      raw_context: { refund_id: refund.id, amount_paise: draft.total_paise, demo: refund.demo },
    });
    return { status: "refunded", refund_id: refund.id, amount_paise: draft.total_paise, order_draft_id };
  });
  return value;
}

export { resolveItems, findByReferenceOrLinkId };
