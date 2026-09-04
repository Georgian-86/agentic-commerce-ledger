// The Gate: policy-as-code between an agent's intention and a payment.
//
// This is the only place a purchase can be authorised, and it is plain
// deterministic control flow. No model output reaches it; no prompt can
// change its behaviour. An agent that argues, insists, cites authority,
// or presents a document claiming the limits were lifted gets the same
// answer as an agent that asks nicely, because none of those things are
// inputs to any function below.
//
// Each check returns a specific reason string. That string is written
// once, here, and is what the audit ledger stores, what the dashboard
// shows, and what the shopper-facing agent is required to relay. There
// is exactly one authored explanation per decision, and the model is
// never its author.
import { formatPaise } from "./money.js";
import { verifyIntentMandate } from "./mandate.js";
import { balance } from "./ledger.js";

const DEFAULT_CONFIRMATION_THRESHOLD_PAISE = 150000;

function threshold(mandate) {
  // A mandate may tighten the confirmation threshold below the server
  // default, but never loosen it — the user's own credential is allowed
  // to be more cautious than the merchant, not less.
  const serverDefault = Number(process.env.CONFIRMATION_THRESHOLD_PAISE || DEFAULT_CONFIRMATION_THRESHOLD_PAISE);
  const fromMandate = mandate?.constraints?.requires_confirmation_above_paise;
  if (typeof fromMandate === "number" && fromMandate > 0) return Math.min(serverDefault, fromMandate);
  return serverDefault;
}

/**
 * @param {object} params
 * @param {object|string} params.mandate      the presented Intent Mandate (credential or token)
 * @param {string[]}      params.categories   every category present in the order
 * @param {number}        params.amount_paise
 * @param {string}        [params.agent_id]   who is presenting the mandate
 * @param {boolean}       [params.isConfirmStep] true when a prior needs_confirmation
 *                                            has been explicitly satisfied
 * @returns {{decision, reason, reason_code, mandate?, balance?, threshold_paise}}
 */
export function checkGate({ mandate, categories, amount_paise, agent_id = null, isConfirmStep = false }) {
  // 1. Is the credential real, unexpired, and bound to this agent?
  const verification = verifyIntentMandate(mandate, { agent_id });
  if (!verification.ok) {
    return { decision: "blocked", reason: verification.reason, reason_code: verification.reason_code };
  }
  const verified = verification.mandate;
  const constraints = verified.constraints;

  // 2. Sanity: amounts must be positive integers in paise. A negative
  //    or fractional amount is not a small bug here, it is a refund
  //    disguised as a purchase.
  if (!Number.isInteger(amount_paise) || amount_paise <= 0) {
    return {
      decision: "blocked",
      reason: `Rejected: order amount must be a positive whole number of paise, got ${amount_paise}.`,
      reason_code: "invalid_amount",
      mandate: verified,
    };
  }

  // 3. Category scope.
  const disallowed = categories.filter((c) => !constraints.allowed_categories.includes(c));
  if (disallowed.length) {
    return {
      decision: "blocked",
      reason: `Blocked: categor${disallowed.length > 1 ? "ies" : "y"} "${disallowed.join(", ")}" ${disallowed.length > 1 ? "are" : "is"} outside this mandate's scope (allowed: ${constraints.allowed_categories.join(", ")}).`,
      reason_code: "category_not_allowed",
      mandate: verified,
    };
  }

  // 4. Per-order ceiling, if the user set one.
  if (constraints.max_per_order_paise && amount_paise > constraints.max_per_order_paise) {
    return {
      decision: "blocked",
      reason: `Blocked: ${formatPaise(amount_paise)} exceeds this mandate's per-order limit of ${formatPaise(constraints.max_per_order_paise)}, even though the overall budget could cover it.`,
      reason_code: "over_per_order_limit",
      mandate: verified,
    };
  }

  // 5. Available balance = cap − already settled − currently on hold.
  //    Checking against *available* rather than against the raw cap is
  //    what stops two concurrent checkouts from each passing.
  const position = balance(verified);
  if (amount_paise > position.available_paise) {
    return {
      decision: "blocked",
      reason: `Blocked: ${formatPaise(amount_paise)} exceeds the ${formatPaise(position.available_paise)} still available on mandate ${verified.mandate_id} (cap ${formatPaise(position.cap_paise)}, ${formatPaise(position.spent_paise)} settled, ${formatPaise(position.held_paise)} on hold for orders awaiting payment).`,
      reason_code: "over_budget",
      mandate: verified,
      balance: position,
    };
  }

  // 6. Human-in-the-loop threshold. Within budget is not the same as
  //    unattended: past this line the agent must stop and get an
  //    explicit second authorisation before anything reaches Razorpay.
  const limit = threshold(verified);
  if (amount_paise > limit && !isConfirmStep) {
    return {
      decision: "needs_confirmation",
      reason: `${formatPaise(amount_paise)} is within budget but above the ${formatPaise(limit)} unattended-spend threshold — a human has to approve this one explicitly before it reaches Razorpay.`,
      reason_code: "above_threshold",
      mandate: verified,
      balance: position,
      threshold_paise: limit,
    };
  }

  return {
    decision: "approved",
    reason: `Approved: ${formatPaise(amount_paise)} is within mandate ${verified.mandate_id}'s available balance of ${formatPaise(position.available_paise)}, in an allowed category, and ${amount_paise > limit ? "explicitly confirmed by a human" : `at or below the ${formatPaise(limit)} unattended-spend threshold`}.`,
    reason_code: "within_bounds",
    mandate: verified,
    balance: position,
    threshold_paise: limit,
  };
}

export { formatPaise };
