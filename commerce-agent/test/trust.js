// Trust-core test suite.
//
// These are the properties a payments engineer will actually poke at,
// and every one of them was a real defect in the first version of this
// project. They run against a live server, entirely without the LLM —
// a broken gate, a replayable payment or a leaking budget fails here,
// loudly, and not for the first time on stage.
//
//   npm run dev        (one terminal)
//   npm run test:trust  (another)
import assert from "node:assert/strict";

const BASE = process.env.COMMERCE_AGENT_URL || "http://localhost:4200";

let passed = 0;
const failures = [];

async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, opts);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
const get = (path) => api(path);
const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message.split("\n")[0]}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

/** Simulate Razorpay redirecting back after a successful payment. The
 *  signature is generated the same way Razorpay generates it, so this
 *  exercises the real verification path, not a bypass. */
async function payViaCallback(linkId, orderId) {
  return fetch(`${BASE}/payment-callback?demo=1&link_id=${encodeURIComponent(linkId)}&ref=${encodeURIComponent(orderId)}`);
}

async function main() {
  console.log("\nTRUST CORE — verifying the properties that protect money\n");

  await post("/debug/reset-demo");
  await post("/debug/set-stock", { product_id: "sku-019", qty: 40 });
  await post("/debug/set-stock", { product_id: "sku-001", qty: 40 });

  const mandates = (await get("/mandates")).body;
  const gift = mandates.find((m) => m.label.startsWith("Gift"));
  const repeat = mandates.find((m) => m.label.startsWith("Repeat"));
  const cautious = mandates.find((m) => m.label.startsWith("Cautious"));
  assert.ok(gift && repeat && cautious, "all three seed mandates should be issued at boot");

  /* ---------------------------------------------------------------- */
  section("1. Mandate credentials");

  await test("a mandate is signed by the user key, not the merchant's", async () => {
    assert.ok(gift.signed_by.startsWith("user:"), `expected a user-signed mandate, got ${gift.signed_by}`);
  });

  await test("a tampered cap is rejected and no order is priced", async () => {
    const res = await post(`/mandates/${gift.mandate_id}/tamper`, {
      field: "max_amount_paise",
      value: 99999900,
      items: [{ product_id: "sku-017", qty: 1 }],
    });
    assert.equal(res.body.attempted.signature_unchanged, true, "the demo must reuse the original signature");
    assert.equal(res.body.result.decision, "blocked");
    assert.equal(res.body.result.reason_code, "bad_signature");
    assert.ok(!res.body.result.cart_mandate_token, "a rejected mandate must not receive a signed cart");
  });

  await test("an unknown mandate id is refused", async () => {
    const res = await post("/orders/draft", { mandate_token: "acl_not-a-real-token", items: [{ product_id: "sku-019", qty: 1 }] });
    assert.ok(res.status >= 400 || res.body.decision === "blocked", "a garbage token must not draft an order");
  });

  /* ---------------------------------------------------------------- */
  section("2. The Gate");

  await test("an out-of-scope category is blocked", async () => {
    const res = await post("/orders/draft", { mandate_token: gift.token, items: [{ product_id: "sku-001", qty: 1 }] });
    assert.equal(res.body.decision, "blocked");
    assert.equal(res.body.reason_code, "category_not_allowed");
    assert.match(res.body.reason, /gifting/, "the reason should name what IS allowed");
  });

  await test("an over-budget order is blocked with the real numbers", async () => {
    const res = await post("/orders/draft", { mandate_token: gift.token, items: [{ product_id: "sku-017", qty: 2 }] });
    assert.equal(res.body.decision, "blocked");
    assert.equal(res.body.reason_code, "over_budget");
    assert.match(res.body.reason, /₹/, "a block reason must quote actual amounts");
  });

  await test("a blocked order never receives a signed cart", async () => {
    const res = await post("/orders/draft", { mandate_token: gift.token, items: [{ product_id: "sku-017", qty: 2 }] });
    assert.equal(res.body.cart_mandate_token, null);
  });

  await test("a per-order limit is enforced separately from the total cap", async () => {
    // Cautious mandate: ₹5,000 total but ₹1,000 per order.
    const res = await post("/orders/draft", { mandate_token: cautious.token, items: [{ product_id: "sku-001", qty: 1 }] });
    assert.equal(res.body.decision, "blocked");
    assert.equal(res.body.reason_code, "over_per_order_limit");
  });

  await test("above the threshold, the agent path returns needs_confirmation", async () => {
    const draft = (await post("/orders/draft", { mandate_token: repeat.token, items: [{ product_id: "sku-001", qty: 1 }] })).body;
    assert.equal(draft.decision, "needs_confirmation", `₹2,499 is over the ₹1,500 threshold: ${draft.reason}`);
    assert.ok(draft.cart_mandate_token, "a confirmable order still gets a signed cart");
  });

  /* ---------------------------------------------------------------- */
  section("3. The ledger — hold, then capture");

  let orderId, linkId;

  await test("a within-budget order drafts, holds budget, and issues a payment link", async () => {
    const draft = (await post("/orders/draft", { mandate_token: gift.token, items: [{ product_id: "sku-019", qty: 1 }] })).body;
    assert.equal(draft.decision, "approved", draft.reason);
    orderId = draft.order_draft_id;

    const confirm = (await post(`/orders/${orderId}/confirm`, { mandate_token: gift.token })).body;
    assert.equal(confirm.status, "awaiting_payment", JSON.stringify(confirm));
    assert.ok(confirm.payment_link, "a payment link should exist");
    linkId = confirm.payment_link_id;

    assert.equal(confirm.balance.held_paise, 89900, "the ₹899 should be HELD, not spent");
    assert.equal(confirm.balance.spent_paise, 0, "nothing settles before payment");
  });

  await test("a duplicate confirm returns the SAME link and holds no extra budget", async () => {
    const again = (await post(`/orders/${orderId}/confirm`, { mandate_token: gift.token })).body;
    assert.equal(again.replayed, true, "the second confirm must be recognised as a replay");
    assert.equal(again.payment_link_id, linkId, "a retry must not mint a second payment link");
    assert.equal(again.balance.held_paise, 89900, "a retry must not double-hold the budget");
  });

  await test("payment converts the hold into a settled spend", async () => {
    const res = await payViaCallback(linkId, orderId);
    assert.equal(res.status, 200);

    const ledger = (await get("/ledger")).body;
    const account = ledger.accounts.find((a) => a.mandate_id === gift.mandate_id);
    assert.equal(account.spent_paise, 89900, "the hold should now be a spend");
    assert.equal(account.held_paise, 0, "no hold should remain");
  });

  await test("replaying the payment callback does not double-count revenue", async () => {
    const before = (await get("/metrics")).body;
    await payViaCallback(linkId, orderId);
    await payViaCallback(linkId, orderId);
    const after = (await get("/metrics")).body;

    assert.equal(after.settled_gmv_paise, before.settled_gmv_paise, "GMV moved on a replayed callback");
    assert.equal(after.orders_settled, before.orders_settled, "order count moved on a replayed callback");

    const events = (await get("/audit")).body;
    assert.ok(
      events.some((e) => e.event_type === "payment_duplicate_ignored"),
      "the replay should be recorded, not silently swallowed"
    );
  });

  await test("a signed cart cannot be checked out twice", async () => {
    const draft = (await post("/orders/draft", { mandate_token: gift.token, items: [{ product_id: "sku-018", qty: 1 }] })).body;
    assert.equal(draft.decision, "approved", draft.reason);
    const first = (await post(`/orders/${draft.order_draft_id}/confirm`, { mandate_token: gift.token })).body;
    assert.equal(first.status, "awaiting_payment");

    // Present the same signed cart against a brand new order.
    const other = (await post("/orders/draft", { mandate_token: gift.token, items: [{ product_id: "sku-018", qty: 1 }] })).body;
    const replay = await api(`/orders/${other.order_draft_id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mandate_token: gift.token, cart_mandate_token: draft.cart_mandate_token }),
    });
    assert.notEqual(replay.body.status, "awaiting_payment", "a spent cart must not authorise a second payment");
  });

  await test("abandoning a checkout returns the held budget", async () => {
    const draft = (await post("/orders/draft", { mandate_token: repeat.token, items: [{ product_id: "sku-004", qty: 1 }] })).body;
    const confirm = (await post(`/orders/${draft.order_draft_id}/confirm`, { mandate_token: repeat.token })).body;
    assert.equal(confirm.status, "awaiting_payment");
    const heldBefore = confirm.balance.held_paise;
    assert.ok(heldBefore > 0);

    await post(`/orders/${draft.order_draft_id}/abandon`);
    const ledger = (await get("/ledger")).body;
    const account = ledger.accounts.find((a) => a.mandate_id === repeat.mandate_id);
    assert.equal(account.held_paise, 0, "abandoning must release the hold, not strand the budget");
    assert.equal(account.spent_paise, 0, "an abandoned order must never count as spend");
  });

  /* ---------------------------------------------------------------- */
  section("4. Webhooks");

  await test("an unsigned webhook is rejected without being parsed", async () => {
    const res = await fetch(`${BASE}/webhooks/razorpay`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": "deadbeef" },
      body: JSON.stringify({ event: "payment_link.paid", payload: {} }),
    });
    assert.equal(res.status, 400);
    const events = (await get("/audit")).body;
    assert.ok(events.some((e) => e.event_type === "webhook_rejected"));
  });

  await test("a duplicate webhook delivery is recognised, not double-counted", async () => {
    const draft = (await post("/orders/draft", { mandate_token: gift.token, items: [{ product_id: "sku-018", qty: 1 }] })).body;
    const confirm = (await post(`/orders/${draft.order_draft_id}/confirm`, { mandate_token: gift.token })).body;
    assert.equal(confirm.status, "awaiting_payment", JSON.stringify(confirm));

    const before = (await get("/metrics")).body;
    const replay = (await post("/debug/replay-webhook", { order_draft_id: draft.order_draft_id, times: 3 })).body;
    const after = (await get("/metrics")).body;

    assert.equal(replay.delivered, 3);
    assert.equal(
      after.orders_settled,
      before.orders_settled + 1,
      "three identical deliveries of one event should settle exactly one order"
    );
  });

  /* ---------------------------------------------------------------- */
  section("5. The audit chain");

  await test("the hash chain verifies from genesis", async () => {
    const result = (await get("/audit/verify")).body;
    assert.equal(result.ok, true, result.detail);
    assert.ok(result.length > 10, `expected a populated chain, got ${result.length} events`);
  });

  await test("every event carries a specific reason, never a generic one", async () => {
    const events = (await get("/audit")).body;
    for (const event of events) {
      assert.ok(event.reason && event.reason.length > 25, `event ${event.event_type} has a thin reason: "${event.reason}"`);
      assert.ok(
        !/^(error|failed|something went wrong)\.?$/i.test(event.reason),
        `event ${event.event_type} has a generic reason`
      );
    }
  });

  await test("every event is linked to the one before it", async () => {
    const events = (await get("/audit")).body;
    for (let i = 1; i < events.length; i++) {
      assert.equal(events[i].prev_hash, events[i - 1].hash, `chain break between seq ${events[i - 1].seq} and ${events[i].seq}`);
      assert.equal(events[i].seq, events[i - 1].seq + 1, "sequence numbers must be contiguous");
    }
  });

  await test("the refused-spend metric counts what the Gate declined", async () => {
    const m = (await get("/metrics")).body;
    assert.ok(m.refused_spend_paise > 0, "the blocked orders above should be counted as refused spend");
    assert.ok(m.blocked_attempts >= 3);
  });

  /* ---------------------------------------------------------------- */
  section("6. Graceful failure");

  await test("a mid-checkout stock-out fails cleanly and offers an alternative", async () => {
    await post("/debug/set-stock", { product_id: "sku-003", qty: 5 });
    const draft = (await post("/orders/draft", { mandate_token: repeat.token, items: [{ product_id: "sku-003", qty: 1 }] })).body;
    assert.ok(["approved", "needs_confirmation"].includes(draft.decision), draft.reason);

    await post("/debug/set-stock", { product_id: "sku-003", qty: 0 });

    const confirm = (await post(`/orders/${draft.order_draft_id}/confirm`, { mandate_token: repeat.token })).body;
    assert.equal(confirm.status, "failed", JSON.stringify(confirm));
    assert.match(confirm.reason, /sold out/i);
    assert.ok(confirm.alternative, "a failure should offer a real alternative, not just an apology");

    const ledger = (await get("/ledger")).body;
    const account = ledger.accounts.find((a) => a.mandate_id === repeat.mandate_id);
    assert.equal(account.held_paise, 0, "a failed checkout must not leave budget stranded on hold");

    await post("/debug/set-stock", { product_id: "sku-003", qty: 25 });
  });

  /* ---------------------------------------------------------------- */
  console.log(`\n${"=".repeat(58)}`);
  if (failures.length) {
    console.error(`${passed} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error(`  ${f.name}\n    ${f.err.message}\n`);
    process.exit(1);
  }
  console.log(`All ${passed} trust-core checks passed.`);
  console.log(`${"=".repeat(58)}\n`);
}

main().catch((err) => {
  console.error("\nSUITE CRASHED:", err);
  process.exit(1);
});
