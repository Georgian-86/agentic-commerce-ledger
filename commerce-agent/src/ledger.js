// The spend ledger: authorisation hold, then capture.
//
// The naive version of this system decremented a mandate's budget the
// moment a payment link was created. That is wrong in a way payments
// people notice immediately: if the shopper never pays, the budget is
// gone forever, and if confirm is called twice the budget is spent
// twice for one order.
//
// So the ledger models what card rails actually do:
//
//   reserve(order)  — place a hold. Funds are unavailable but not spent.
//   commit(order)   — the payment settled. Hold becomes spend.
//   release(order)  — checkout failed, expired, or was abandoned. The
//                     hold is returned to the available balance.
//
// Every transition is idempotent by order id, and holds expire on
// their own so an abandoned checkout self-heals instead of leaking
// budget until restart.
import { formatPaise } from "./money.js";

const HOLD_TTL_MS = 15 * 60 * 1000;

// mandate_id -> { cap_paise, spent_paise, holds: Map<order_id, hold> }
const accounts = new Map();
// order_id -> mandate_id, so commit/release don't need the caller to
// remember which mandate a hold belongs to.
const holdIndex = new Map();

let onExpire = null;
/** Let the app observe auto-expiry so it can write an audit event. */
export function setExpiryHandler(fn) {
  onExpire = fn;
}

function account(mandate) {
  let acct = accounts.get(mandate.mandate_id);
  if (!acct) {
    acct = { cap_paise: mandate.constraints.max_amount_paise, spent_paise: 0, holds: new Map() };
    accounts.set(mandate.mandate_id, acct);
  }
  // A mandate is a bearer credential: its cap is whatever the signed
  // credential says. Re-reading it each time means a *legitimately*
  // reissued mandate with a new cap is honoured, while a tampered one
  // never reaches here — verifyIntentMandate rejects it first.
  acct.cap_paise = mandate.constraints.max_amount_paise;
  return acct;
}

function sweepExpired(acct, mandate_id) {
  const now = Date.now();
  for (const [order_id, hold] of acct.holds) {
    if (hold.expires_at > now) continue;
    acct.holds.delete(order_id);
    holdIndex.delete(order_id);
    onExpire?.({
      mandate_id,
      order_id,
      amount_paise: hold.amount_paise,
      reason: `Authorisation hold of ${formatPaise(hold.amount_paise)} on order ${order_id} expired after 15 minutes without payment — the budget has been returned to the mandate.`,
    });
  }
}

/** Current position for a mandate: cap, held, spent, available. */
export function balance(mandate) {
  const acct = account(mandate);
  sweepExpired(acct, mandate.mandate_id);
  const held_paise = [...acct.holds.values()].reduce((sum, h) => sum + h.amount_paise, 0);
  return {
    mandate_id: mandate.mandate_id,
    cap_paise: acct.cap_paise,
    held_paise,
    spent_paise: acct.spent_paise,
    available_paise: acct.cap_paise - acct.spent_paise - held_paise,
    open_holds: acct.holds.size,
  };
}

/**
 * Place a hold. Idempotent: reserving the same order twice returns the
 * existing hold instead of double-charging the mandate. That single
 * property is what makes a retried confirm_checkout safe.
 */
export function reserve(mandate, order_id, amount_paise) {
  const acct = account(mandate);
  sweepExpired(acct, mandate.mandate_id);

  const existing = acct.holds.get(order_id);
  if (existing) {
    return { ok: true, replayed: true, hold: existing, balance: balance(mandate) };
  }

  const current = balance(mandate);
  if (amount_paise > current.available_paise) {
    return {
      ok: false,
      reason_code: "insufficient_available",
      reason: `${formatPaise(amount_paise)} exceeds the ${formatPaise(current.available_paise)} still available on this mandate (cap ${formatPaise(current.cap_paise)}, ${formatPaise(current.held_paise)} on hold, ${formatPaise(current.spent_paise)} already settled).`,
      balance: current,
    };
  }

  const hold = { order_id, amount_paise, created_at: Date.now(), expires_at: Date.now() + HOLD_TTL_MS };
  acct.holds.set(order_id, hold);
  holdIndex.set(order_id, mandate.mandate_id);
  return { ok: true, replayed: false, hold, balance: balance(mandate) };
}

/** Settle a hold into spend. Idempotent and safe to call from a
 *  replayed webhook — a second call is a no-op, not a double count. */
export function commit(order_id) {
  const mandate_id = holdIndex.get(order_id);
  if (!mandate_id) return { ok: false, reason_code: "no_hold", reason: `No open authorisation hold for order ${order_id}.` };
  const acct = accounts.get(mandate_id);
  const hold = acct?.holds.get(order_id);
  if (!hold) return { ok: false, reason_code: "no_hold", reason: `No open authorisation hold for order ${order_id}.` };

  acct.holds.delete(order_id);
  holdIndex.delete(order_id);
  acct.spent_paise += hold.amount_paise;
  return { ok: true, mandate_id, amount_paise: hold.amount_paise };
}

/** Return a hold to the available balance. Idempotent. */
export function release(order_id, reason = "released") {
  const mandate_id = holdIndex.get(order_id);
  if (!mandate_id) return { ok: false, reason_code: "no_hold" };
  const acct = accounts.get(mandate_id);
  const hold = acct?.holds.get(order_id);
  if (!hold) return { ok: false, reason_code: "no_hold" };

  acct.holds.delete(order_id);
  holdIndex.delete(order_id);
  return { ok: true, mandate_id, amount_paise: hold.amount_paise, reason };
}

/** Reverse a settled spend (refund). Returns budget to the mandate. */
export function reverse(mandate_id, amount_paise) {
  const acct = accounts.get(mandate_id);
  if (!acct) return { ok: false, reason_code: "unknown_mandate" };
  acct.spent_paise = Math.max(0, acct.spent_paise - amount_paise);
  return { ok: true, mandate_id, amount_paise };
}

export function snapshot() {
  return [...accounts.entries()].map(([mandate_id, acct]) => {
    const held_paise = [...acct.holds.values()].reduce((s, h) => s + h.amount_paise, 0);
    return {
      mandate_id,
      cap_paise: acct.cap_paise,
      held_paise,
      spent_paise: acct.spent_paise,
      available_paise: acct.cap_paise - acct.spent_paise - held_paise,
    };
  });
}

/** Wipe all ledger state — used only by the demo reset script. */
export function resetLedger() {
  accounts.clear();
  holdIndex.clear();
}
