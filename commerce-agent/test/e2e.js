// Minimal end-to-end smoke test — the original three scenarios from
// the build plan, on the current API.
//
// trust.js is the thorough suite (21 checks). This one is the
// 30-second "is the core alive" check: a within-budget purchase
// completes, an over-budget one is blocked with no Razorpay call, and
// a mid-checkout stock-out is handled without an exception.
//
//   npm run dev        (one terminal, DEMO_MODE=true for repeated runs)
//   npm run test:e2e   (another)
import assert from "node:assert/strict";

const BASE = process.env.COMMERCE_AGENT_URL || "http://localhost:4200";

const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) =>
    r.json()
  );
const get = (path) => fetch(`${BASE}${path}`).then((r) => r.json());

async function main() {
  await post("/debug/reset-demo");
  await post("/debug/set-stock", { product_id: "sku-019", qty: 40 });
  await post("/debug/set-stock", { product_id: "sku-001", qty: 40 });

  const mandates = await get("/mandates");
  const gift = mandates.find((m) => m.label.startsWith("Gift")).token;
  const repeat = mandates.find((m) => m.label.startsWith("Repeat")).token;

  console.log("== A: within-budget purchase completes end to end ==");
  {
    const draft = await post("/orders/draft", { mandate_token: gift, items: [{ product_id: "sku-019", qty: 1 }] });
    assert.equal(draft.decision, "approved", `expected approved: ${draft.reason}`);
    console.log("  drafted", draft.order_draft_id, draft.total, "— signed cart issued");

    const confirm = await post(`/orders/${draft.order_draft_id}/confirm`, { mandate_token: gift, cart_mandate_token: draft.cart_mandate_token });
    assert.equal(confirm.status, "awaiting_payment", JSON.stringify(confirm));
    assert.equal(confirm.balance.held_paise, 89900, "budget should be HELD, not yet spent");
    console.log("  payment link:", confirm.payment_link);

    const linkId = new URL(confirm.payment_link).searchParams.get("link_id");
    const cb = await fetch(`${BASE}/payment-callback?demo=1&link_id=${linkId}&ref=${draft.order_draft_id}`);
    assert.equal(cb.status, 200);

    const ledger = await get("/ledger");
    const acct = ledger.accounts.find((a) => a.mandate_id === mandates.find((m) => m.label.startsWith("Gift")).mandate_id);
    assert.equal(acct.spent_paise, 89900, "hold should now be settled spend");
    assert.equal(acct.held_paise, 0);
    console.log("  payment verified, hold committed to spend ✓");

    const verify = await get("/audit/verify");
    assert.equal(verify.ok, true, verify.detail);
    console.log("  audit chain verifies from genesis ✓");
  }

  console.log("\n== B: over-budget order is blocked, no Razorpay call ==");
  {
    const draft = await post("/orders/draft", { mandate_token: gift, items: [{ product_id: "sku-017", qty: 1 }] });
    assert.equal(draft.decision, "blocked", `expected blocked: ${draft.reason}`);
    assert.equal(draft.cart_mandate_token, null, "a blocked order must not receive a signed cart");
    console.log("  blocked:", draft.reason);
  }

  console.log("\n== C: mid-checkout stock-out is handled gracefully ==");
  {
    const draft = await post("/orders/draft", { mandate_token: repeat, items: [{ product_id: "sku-001", qty: 1 }] });
    assert.ok(["approved", "needs_confirmation"].includes(draft.decision), draft.reason);

    await post("/debug/set-stock", { product_id: "sku-001", qty: 0 });

    const confirm = await post(`/orders/${draft.order_draft_id}/confirm`, { mandate_token: repeat, cart_mandate_token: draft.cart_mandate_token });
    assert.equal(confirm.status, "failed", JSON.stringify(confirm));
    assert.match(confirm.reason, /sold out/i);
    assert.ok(confirm.alternative, "a graceful failure offers an alternative");
    console.log("  graceful failure:", confirm.reason);
    console.log("  alternative offered:", confirm.alternative.name);

    await post("/debug/set-stock", { product_id: "sku-001", qty: 40 });
  }

  console.log("\nAll three scenarios passed.");
}

main().catch((err) => {
  console.error("\nE2E FAILED:", err.message);
  process.exit(1);
});
