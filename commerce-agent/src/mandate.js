// The mandate chain — this project's trust primitive.
//
// Modelled on AP2's three-mandate structure, which is the emerging
// answer to "how does a merchant know an AI agent is actually allowed
// to spend this money?":
//
//   IntentMandate   signed by the USER's wallet key.
//                   "This agent may spend up to ₹X, in these
//                    categories, at these merchants, until T."
//                   The merchant verifies it and can never mint one.
//
//   CartMandate     signed by the MERCHANT's key.
//                   "This exact basket costs exactly this much, and
//                    it is bound to that specific IntentMandate."
//                   Freezes the price so the agent cannot be shown one
//                   total and charged another.
//
//   PaymentMandate  signed by the MERCHANT, binding both hashes to the
//                   payment reference that actually went to Razorpay.
//                   This is the non-repudiable record: given the audit
//                   ledger, anyone can reconstruct who authorised what,
//                   under which limits, for which payment.
//
// Mandates travel as detached, presentable credentials — base64url
// JSON with a signature block — not as rows in a table the verifier
// also owns. That is the whole point: an external buyer agent (Claude
// Desktop, MCP Inspector, anything) holds the credential and presents
// it, and the merchant's gate verifies what was presented.
//
// Deviations from AP2, stated plainly rather than glossed:
//   - Ed25519 instead of ECDSA P-256 (see keys.js).
//   - JSON + detached signature instead of full W3C Verifiable
//     Credential / JSON-LD framing.
//   - The user's wallet is simulated in-process (issueIntentMandate
//     below) rather than being a separate device with hardware-backed
//     keys. The signing role is genuinely separate; the *device* is not.
import { randomUUID, randomBytes } from "node:crypto";
import { canonicalJson, hashObject, b64url, fromB64url } from "./canonical.js";
import { signAs, keyId, verifyWithKeyId } from "./keys.js";

export const MANDATE_VERSION = "acl/0.2";
export const MERCHANT_ID = "merchant_agentic_bazaar";
export const MERCHANT_NAME = "Agentic Bazaar";

// Cart Mandates are short-lived on purpose: a frozen price that never
// expires is a price the merchant is obliged to honour forever.
const CART_MANDATE_TTL_MS = 10 * 60 * 1000;

// Nonces of Cart Mandates already spent. One cart, one checkout —
// this is what stops a replayed CartMandate from buying twice.
const spentCartNonces = new Set();

function nonce() {
  return b64url(randomBytes(12));
}

function nowIso() {
  return new Date().toISOString();
}

/** Attach a detached signature block to a mandate body. */
function seal(role, body) {
  const proof = {
    alg: "Ed25519",
    key_id: keyId(role),
    created: nowIso(),
  };
  // The proof metadata is signed alongside the body, so an attacker
  // can't swap key_id to a key they control and keep the signature.
  const signature = signAs(role, canonicalJson({ body, proof }));
  return { ...body, proof: { ...proof, signature } };
}

/** Verify a sealed mandate's signature and that it came from `role`. */
function unseal(mandate, expectedRole) {
  if (!mandate || typeof mandate !== "object" || !mandate.proof?.signature) {
    return { ok: false, reason_code: "malformed", reason: "Mandate has no signature block." };
  }
  const { proof, ...body } = mandate;
  const { signature, ...proofMeta } = proof;
  if (!String(proof.key_id || "").startsWith(`${expectedRole}:`)) {
    return {
      ok: false,
      reason_code: "wrong_issuer",
      reason: `Mandate was signed by "${proof.key_id}" but a ${expectedRole}-issued mandate was required.`,
    };
  }
  const ok = verifyWithKeyId(proof.key_id, canonicalJson({ body, proof: proofMeta }), signature);
  if (!ok) {
    return {
      ok: false,
      reason_code: "bad_signature",
      reason: `Signature check failed against ${proof.key_id} — this mandate was altered after it was issued, or signed by a key this merchant does not trust.`,
    };
  }
  return { ok: true, body };
}

/* ------------------------------------------------------------------ */
/*  Token encoding — what actually gets passed around                  */
/* ------------------------------------------------------------------ */

/** Encode a mandate as a single pasteable string. */
export function encodeToken(mandate) {
  return `acl_${b64url(Buffer.from(canonicalJson(mandate)))}`;
}

export function decodeToken(token) {
  if (typeof token !== "string" || !token.startsWith("acl_")) return null;
  try {
    return JSON.parse(fromB64url(token.slice(4)).toString("utf-8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Intent Mandate — issued by the user's wallet                       */
/* ------------------------------------------------------------------ */

/**
 * Simulates the shopper's wallet issuing a scoped spending
 * authorisation to a named agent. In production this call happens on
 * the user's device and this process never sees the private key.
 */
export function issueIntentMandate({
  label,
  issued_to,
  max_amount_paise,
  max_per_order_paise = null,
  allowed_categories,
  allowed_merchants = [MERCHANT_ID],
  requires_confirmation_above_paise = null,
  ttl_hours = 48,
}) {
  const issued_at = nowIso();
  const body = {
    type: "IntentMandate",
    version: MANDATE_VERSION,
    mandate_id: `im_${randomUUID().slice(0, 12)}`,
    label,
    issued_at,
    expires_at: new Date(Date.now() + ttl_hours * 3600 * 1000).toISOString(),
    nonce: nonce(),
    issued_to,
    constraints: {
      currency: "INR",
      max_amount_paise,
      max_per_order_paise,
      allowed_categories,
      allowed_merchants,
      requires_confirmation_above_paise,
    },
  };
  return seal("user", body);
}

/**
 * Verify a *presented* Intent Mandate. Everything checked here is
 * checked against the credential itself, not against a trusted local
 * copy — that is what makes this meaningful when the presenter is an
 * agent we do not control.
 */
export function verifyIntentMandate(mandateOrToken, { agent_id = null } = {}) {
  const mandate = typeof mandateOrToken === "string" ? decodeToken(mandateOrToken) : mandateOrToken;
  if (!mandate) {
    return { ok: false, reason_code: "malformed", reason: "Could not decode the presented mandate token." };
  }
  if (mandate.type !== "IntentMandate") {
    return { ok: false, reason_code: "wrong_type", reason: `Expected an IntentMandate, got "${mandate.type}".` };
  }

  const opened = unseal(mandate, "user");
  if (!opened.ok) return opened;

  if (new Date(mandate.expires_at).getTime() < Date.now()) {
    return {
      ok: false,
      reason_code: "expired",
      reason: `Mandate ${mandate.mandate_id} expired at ${mandate.expires_at} and can no longer authorise spending.`,
    };
  }

  // Agent binding: a mandate issued to one agent cannot be replayed by
  // another that happens to get hold of the token.
  if (agent_id && mandate.issued_to?.agent_id && mandate.issued_to.agent_id !== agent_id) {
    return {
      ok: false,
      reason_code: "agent_mismatch",
      reason: `Mandate ${mandate.mandate_id} was issued to agent "${mandate.issued_to.agent_id}", but "${agent_id}" presented it.`,
    };
  }

  if (!mandate.constraints?.allowed_merchants?.includes(MERCHANT_ID)) {
    return {
      ok: false,
      reason_code: "merchant_not_allowed",
      reason: `Mandate ${mandate.mandate_id} does not list ${MERCHANT_ID} among its allowed merchants.`,
    };
  }

  return { ok: true, mandate };
}

/* ------------------------------------------------------------------ */
/*  Cart Mandate — issued by the merchant, freezes the price           */
/* ------------------------------------------------------------------ */

export function issueCartMandate({ intentMandate, items, total_paise, order_draft_id }) {
  const body = {
    type: "CartMandate",
    version: MANDATE_VERSION,
    cart_id: `cm_${randomUUID().slice(0, 12)}`,
    order_draft_id,
    intent_mandate_id: intentMandate.mandate_id,
    intent_mandate_hash: hashObject(intentMandate),
    merchant: { merchant_id: MERCHANT_ID, name: MERCHANT_NAME },
    currency: "INR",
    items: items.map((i) => ({
      product_id: i.product_id,
      name: i.name,
      category: i.category,
      qty: i.qty,
      unit_price_paise: i.price_paise,
      line_total_paise: i.line_total_paise,
    })),
    total_paise,
    issued_at: nowIso(),
    expires_at: new Date(Date.now() + CART_MANDATE_TTL_MS).toISOString(),
    nonce: nonce(),
  };
  return seal("merchant", body);
}

/**
 * Verify a presented Cart Mandate against the Intent Mandate it claims
 * to be bound to. `consume` marks its nonce spent so the same signed
 * cart can never be checked out twice.
 */
export function verifyCartMandate(cartOrToken, intentMandate, { consume = false, order_draft_id = null } = {}) {
  const cart = typeof cartOrToken === "string" ? decodeToken(cartOrToken) : cartOrToken;
  if (!cart) {
    return { ok: false, reason_code: "malformed", reason: "Could not decode the presented cart mandate." };
  }
  if (cart.type !== "CartMandate") {
    return { ok: false, reason_code: "wrong_type", reason: `Expected a CartMandate, got "${cart.type}".` };
  }

  const opened = unseal(cart, "merchant");
  if (!opened.ok) return opened;

  if (new Date(cart.expires_at).getTime() < Date.now()) {
    return {
      ok: false,
      reason_code: "cart_expired",
      reason: `Cart ${cart.cart_id} expired at ${cart.expires_at}. Prices are only frozen for 10 minutes — re-draft the order to get a current total.`,
    };
  }

  // A cart authorises exactly one order. Without this check, a cart
  // signed for a cheap order could be presented to pay for a different,
  // more expensive one — the merchant's own signature vouching for a
  // price that belongs to some other basket entirely.
  if (order_draft_id && cart.order_draft_id !== order_draft_id) {
    return {
      ok: false,
      reason_code: "cart_order_mismatch",
      reason: `Cart ${cart.cart_id} was signed for order ${cart.order_draft_id}, but was presented to complete order ${order_draft_id}. A signed cart authorises one specific order and no other.`,
    };
  }

  // The cart must be bound to *this* intent mandate, by id and by
  // content hash. Binding on the hash means swapping in a different
  // intent with the same id doesn't work either.
  if (cart.intent_mandate_id !== intentMandate.mandate_id) {
    return {
      ok: false,
      reason_code: "cart_intent_mismatch",
      reason: `Cart ${cart.cart_id} is bound to mandate ${cart.intent_mandate_id}, not to the presented mandate ${intentMandate.mandate_id}.`,
    };
  }
  if (cart.intent_mandate_hash !== hashObject(intentMandate)) {
    return {
      ok: false,
      reason_code: "cart_intent_altered",
      reason: `Cart ${cart.cart_id} was issued against a different version of mandate ${intentMandate.mandate_id} — the mandate has been modified since this cart was priced.`,
    };
  }

  if (spentCartNonces.has(cart.nonce)) {
    return {
      ok: false,
      reason_code: "cart_replayed",
      reason: `Cart ${cart.cart_id} has already been checked out. A signed cart authorises exactly one payment.`,
    };
  }
  if (consume) spentCartNonces.add(cart.nonce);

  return { ok: true, cart };
}

/* ------------------------------------------------------------------ */
/*  Payment Mandate — the settlement record                            */
/* ------------------------------------------------------------------ */

export function issuePaymentMandate({ intentMandate, cartMandate, payment_reference, amount_paise, rail }) {
  const body = {
    type: "PaymentMandate",
    version: MANDATE_VERSION,
    payment_mandate_id: `pm_${randomUUID().slice(0, 12)}`,
    intent_mandate_id: intentMandate.mandate_id,
    intent_mandate_hash: hashObject(intentMandate),
    cart_id: cartMandate.cart_id,
    cart_mandate_hash: hashObject(cartMandate),
    merchant_id: MERCHANT_ID,
    rail,
    payment_reference,
    amount_paise,
    currency: "INR",
    issued_at: nowIso(),
  };
  return seal("merchant", body);
}

/* ------------------------------------------------------------------ */
/*  Helpers used by the dashboard's live tamper demo                   */
/* ------------------------------------------------------------------ */

/**
 * Return a copy of a mandate with one field altered but the original
 * signature left in place — exactly what an attacker who intercepted a
 * credential would try. Used by the dashboard's "tamper" button so the
 * rejection can be shown live rather than asserted in a slide.
 */
export function tamperWithMandate(mandate, { field = "max_amount_paise", value = 99999900 } = {}) {
  const clone = JSON.parse(JSON.stringify(mandate));
  if (field in (clone.constraints || {})) clone.constraints[field] = value;
  else clone[field] = value;
  return clone;
}
