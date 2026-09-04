// Buyer-side policy — the other half of agent-to-agent commerce.
//
// "Agent-readable catalog" is usually demonstrated one-way: the
// merchant publishes structured data and an agent reads it. That isn't
// a negotiation, it's a feed.
//
// The buyer here carries its own rules, set by the shopper, and checks
// them against what the merchant declares before it commits money. If
// the merchant's return window is shorter than the shopper will accept,
// the agent says so and stops — even though the mandate would have
// allowed the spend and the merchant was perfectly willing to sell.
//
// Two independent parties, each with policy, reaching agreement or
// declining to. That is the thing the track is actually about.
const DEFAULT_POLICY = {
  min_return_window_days: 14,
  require_warranty_statement: true,
  require_signed_cart: true,
  max_price_delta_pct: 0, // a re-priced cart above what was quoted is refused outright
  blocked_merchants: [],
};

/** Parse "…within 14 days…" style policy prose into a number of days. */
function extractDays(text) {
  if (!text) return null;
  const match = String(text).match(/(\d{1,3})\s*[- ]?\s*(?:calendar\s*)?days?/i);
  return match ? Number(match[1]) : null;
}

/**
 * Evaluate a merchant against the buyer's own rules.
 *
 * @param {object} merchantProfile  from get_merchant_profile
 * @param {object} policies         { returns, shipping, warranty } prose
 * @returns {{ok, findings, summary}}
 */
export function evaluateMerchant({ merchantProfile, policies, policy = DEFAULT_POLICY }) {
  const findings = [];

  if (policy.blocked_merchants.includes(merchantProfile?.merchant_id)) {
    findings.push({
      rule: "blocked_merchants",
      severity: "block",
      detail: `${merchantProfile?.merchant_id} is on this shopper's do-not-buy list.`,
    });
  }

  const returnDays = extractDays(policies?.returns);
  if (returnDays === null) {
    findings.push({
      rule: "min_return_window_days",
      severity: "warn",
      detail: "The merchant's returns policy doesn't state a window in days, so it can't be checked automatically.",
    });
  } else if (returnDays < policy.min_return_window_days) {
    findings.push({
      rule: "min_return_window_days",
      severity: "block",
      detail: `Merchant offers a ${returnDays}-day return window; this shopper's policy requires at least ${policy.min_return_window_days} days.`,
    });
  } else {
    findings.push({
      rule: "min_return_window_days",
      severity: "pass",
      detail: `Return window is ${returnDays} days, meeting the ${policy.min_return_window_days}-day minimum.`,
    });
  }

  if (policy.require_warranty_statement) {
    const hasWarranty = Boolean(policies?.warranty && String(policies.warranty).trim().length > 20);
    findings.push({
      rule: "require_warranty_statement",
      severity: hasWarranty ? "pass" : "block",
      detail: hasWarranty
        ? "Merchant publishes a warranty statement."
        : "Merchant publishes no usable warranty statement, which this shopper's policy requires before buying.",
    });
  }

  if (policy.require_signed_cart) {
    const signs = merchantProfile?.capabilities?.includes("signed_cart_mandate");
    findings.push({
      rule: "require_signed_cart",
      severity: signs ? "pass" : "block",
      detail: signs
        ? "Merchant signs its carts, so the quoted price is cryptographically bound and can't be changed after the fact."
        : "Merchant does not sign carts, so a quoted price isn't binding. This shopper's policy requires a signed cart.",
    });
  }

  const blocking = findings.filter((f) => f.severity === "block");
  return {
    ok: blocking.length === 0,
    findings,
    summary: blocking.length
      ? `Buyer policy check failed: ${blocking.map((f) => f.detail).join(" ")}`
      : `Buyer policy check passed — ${findings.filter((f) => f.severity === "pass").length} rules satisfied against ${merchantProfile?.name || "this merchant"}.`,
  };
}

/** A re-quoted cart that costs more than the buyer agreed to is refused. */
export function checkPriceIntegrity({ quoted_paise, final_paise, policy = DEFAULT_POLICY }) {
  if (final_paise <= quoted_paise) return { ok: true };
  const deltaPct = ((final_paise - quoted_paise) / quoted_paise) * 100;
  if (deltaPct <= policy.max_price_delta_pct) return { ok: true };
  return {
    ok: false,
    reason: `Final total ₹${Math.round(final_paise / 100).toLocaleString("en-IN")} is above the ₹${Math.round(quoted_paise / 100).toLocaleString("en-IN")} the merchant signed for. Buyer policy allows a ${policy.max_price_delta_pct}% variance; this is ${deltaPct.toFixed(1)}%.`,
  };
}

export { DEFAULT_POLICY };
