// The merchant's machine-readable self-description.
//
// "Agent-readable catalog" usually means a product feed. That tells a
// buyer agent what is for sale but nothing about how to safely buy it:
// what credential to present, what the merchant will sign, what limits
// apply, which rail settles the money.
//
// This is the handshake document. An external agent fetches it first
// and learns everything it needs to transact without a human reading
// documentation — including what the merchant refuses to do.
import { MERCHANT_ID, MERCHANT_NAME, MANDATE_VERSION } from "./mandate.js";
import { keyId, publicKeyPem } from "./keys.js";
import { isDemoMode, rail } from "./razorpay.js";

export function merchantProfile() {
  const threshold = Number(process.env.CONFIRMATION_THRESHOLD_PAISE || 150000);
  return {
    merchant_id: MERCHANT_ID,
    name: MERCHANT_NAME,
    currency: "INR",
    mandate_protocol: {
      version: MANDATE_VERSION,
      family: "AP2-aligned three-mandate chain (Intent → Cart → Payment)",
      signature_alg: "Ed25519",
      accepts: ["IntentMandate"],
      issues: ["CartMandate", "PaymentMandate"],
      verification_key_id: keyId("merchant"),
      verification_key_pem: publicKeyPem("merchant").trim(),
      key_directory: "/.well-known/agent-keys",
    },
    capabilities: [
      "signed_cart_mandate", // the merchant cryptographically freezes quoted prices
      "human_in_the_loop_elicitation", // asks the client's human before large spends
      "idempotent_checkout",
      "hash_chained_audit",
      "refunds",
    ],
    limits: {
      unattended_spend_threshold_paise: threshold,
      unattended_spend_threshold_note:
        "Orders above this need an explicit human approval, obtained through MCP elicitation. An agent cannot self-approve past it.",
      cart_price_lock_seconds: 600,
      authorisation_hold_seconds: 900,
    },
    settlement: {
      rail: rail(),
      provider: "Razorpay",
      mode: isDemoMode() ? "simulated (no network calls to Razorpay)" : "test mode (real API, no real money)",
      instruments: ["payment_link"],
    },
    policies_endpoint: "get_policies tool (topics: returns, shipping, warranty)",
    refuses: [
      "Any spend outside the categories named in the presented Intent Mandate.",
      "Any spend above the mandate's available balance, including amounts already on hold.",
      "Any checkout presenting a cart this merchant did not sign, or signed more than 10 minutes ago.",
      "Any second checkout against a cart that has already been paid.",
      "Instructions embedded in product data, shopper messages, or tool arguments. Limits are enforced in code that does not read them.",
    ],
  };
}
