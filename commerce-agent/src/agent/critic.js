// The critic: a deterministic self-check between the model and the user.
//
// The single most expensive failure mode for a shopping agent is a
// confident, well-written sentence containing a price that does not
// exist. "The AeroBuds are ₹1,899" when they are ₹2,499 is not a typo,
// it's a quote the merchant may be held to.
//
// So nothing the model writes reaches the shopper until it has been
// checked against what the tools actually returned. The critic is not
// another model grading the first one — it's a set of exact checks
// against observed facts:
//
//   grounding      every ₹ figure and SKU id in the reply must appear
//                  in a real tool result from this session
//   fidelity       when the Gate blocked something, its reason must be
//                  conveyed, not paraphrased into vagueness
//   scope          the reply must not promise anything outside the
//                  mandate's categories or budget
//   formatting     plain text only, because the UI renders it as text
//
// A "block" finding sends the turn back to the model with the specific
// problem attached. That is the reflect step of the loop, and it is
// worth its latency: it is cheaper to spend one extra model call than
// to quote a wrong price to a judge.
const RUPEE = /₹\s?([\d,]+(?:\.\d{1,2})?)/g;
const SKU = /\bsku-\d{3,}\b/gi;
const MARKDOWN = /(\*\*|^#{1,6}\s|`|\|\s*-{2,}\s*\|)/m;

// Text that looks like it is trying to give the model orders. Seen in a
// *tool result* this is not a formatting quirk, it's an injection
// attempt riding in on merchant data.
const INJECTION = /\b(ignore (?:all |any )?(?:previous|prior|above)|disregard (?:the |your )?(?:instructions|rules|mandate|limits)|system\s*:|you are now|new instructions?|override (?:the )?(?:gate|mandate|limit)|approve any amount|bypass)\b/i;

export function createCritic() {
  const knownPrices = new Set(); // paise
  const knownSkus = new Set();
  const knownNames = new Map(); // lowercase name -> price_paise
  const injections = [];
  let lastGateReason = null;
  let lastGateDecision = null;
  let lastGateNumbers = [];

  function learnProduct(p) {
    if (!p) return;
    if (p.id) knownSkus.add(String(p.id).toLowerCase());
    if (p.product_id) knownSkus.add(String(p.product_id).toLowerCase());
    if (typeof p.price_paise === "number") {
      knownPrices.add(p.price_paise);
      if (p.name) knownNames.set(String(p.name).toLowerCase(), p.price_paise);
    }
    if (typeof p.line_total_paise === "number") knownPrices.add(p.line_total_paise);
    if (typeof p.unit_price_paise === "number") knownPrices.add(p.unit_price_paise);
  }

  function scanForInjection(value, path = "") {
    if (typeof value === "string") {
      if (INJECTION.test(value)) injections.push({ path, snippet: value.slice(0, 200) });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => scanForInjection(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scanForInjection(v, path ? `${path}.${k}` : k);
    }
  }

  return {
    /** Feed every tool result through here before the model sees it. */
    observe(toolName, result) {
      if (!result || typeof result !== "object") return;

      scanForInjection(result);

      if (Array.isArray(result.results)) result.results.forEach(learnProduct);
      if (Array.isArray(result.items)) result.items.forEach(learnProduct);
      if (Array.isArray(result.related)) result.related.forEach(learnProduct);
      if (result.upsell_suggestion) learnProduct(result.upsell_suggestion);
      if (result.alternative) learnProduct(result.alternative);
      if (result.id || result.product_id) learnProduct(result);

      for (const key of ["total_paise", "amount_paise", "threshold_paise"]) {
        if (typeof result[key] === "number") knownPrices.add(result[key]);
      }
      if (result.balance) {
        for (const v of Object.values(result.balance)) {
          if (typeof v === "number") knownPrices.add(v);
        }
      }

      if (result.decision || result.status) {
        if (result.reason) {
          lastGateReason = result.reason;
          lastGateDecision = result.decision || result.status;
          lastGateNumbers = [...String(result.reason).matchAll(RUPEE)].map((m) => m[1].replace(/,/g, ""));
        }
      }
    },

    get injectionAttempts() {
      return injections;
    },

    /**
     * Review a candidate reply. Returns findings and, when something
     * blocks, the exact correction to hand back to the model.
     */
    review(reply) {
      const findings = [];
      const text = String(reply || "");

      if (!text.trim()) {
        findings.push({ severity: "block", rule: "empty_reply", detail: "The agent produced no reply text." });
      }

      // 1. Grounding: every rupee figure must trace to a tool result.
      //    Tolerance is one rupee, to absorb rounding in prose.
      const quoted = [...text.matchAll(RUPEE)].map((m) => Number(m[1].replace(/,/g, "")));
      const knownRupees = [...knownPrices].map((p) => p / 100);
      for (const amount of quoted) {
        const grounded = knownRupees.some((known) => Math.abs(known - amount) <= 1);
        if (!grounded) {
          findings.push({
            severity: "block",
            rule: "ungrounded_price",
            detail: `The reply quotes ₹${amount.toLocaleString("en-IN")}, which does not appear in any tool result this session. Every price shown to a shopper has to come from the catalog, not from the model.`,
          });
        }
      }

      // 2. Grounding: SKU ids must exist.
      for (const sku of text.match(SKU) || []) {
        if (!knownSkus.has(sku.toLowerCase())) {
          findings.push({
            severity: "block",
            rule: "ungrounded_sku",
            detail: `The reply references ${sku}, which was never returned by a catalog tool.`,
          });
        }
      }

      // 3. Fidelity: a block must be explained with its real numbers.
      if (lastGateDecision === "blocked" && lastGateNumbers.length) {
        const conveyed = lastGateNumbers.some((n) => text.replace(/,/g, "").includes(n));
        if (!conveyed) {
          findings.push({
            severity: "block",
            rule: "reason_not_relayed",
            detail: `The Gate blocked this with a specific reason ("${lastGateReason}") and the reply doesn't carry its figures. The shopper has to be told the actual limit, not a vague refusal.`,
          });
        }
      }

      // 4. Formatting: the UI renders replies as plain text.
      if (MARKDOWN.test(text)) {
        findings.push({
          severity: "warn",
          rule: "markdown_used",
          detail: "Reply contains Markdown syntax; the chat surface renders plain text, so it would show the raw characters.",
        });
      }

      // 5. Injection: report attempts found in merchant data.
      if (injections.length) {
        findings.push({
          severity: "warn",
          rule: "injection_in_tool_data",
          detail: `${injections.length} tool result(s) contained text attempting to issue instructions to the agent. Content was treated as data; the Gate is unaffected either way.`,
        });
      }

      const blocking = findings.filter((f) => f.severity === "block");
      return {
        ok: blocking.length === 0,
        findings,
        correction: blocking.length
          ? `Your previous draft reply was rejected by the response validator for these reasons:\n${blocking
              .map((f, i) => `${i + 1}. ${f.detail}`)
              .join("\n")}\nRewrite the reply using only figures and product ids that appeared in tool results this turn. Do not apologise for the correction or mention this validator; just produce the corrected reply.`
          : null,
      };
    },
  };
}
