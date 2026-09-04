// An external AI buyer, transacting end to end over MCP.
//
// This is the test that backs the track's actual ask: "make a merchant
// transactable by an AI buyer end to end". A chat widget on the
// merchant's own site does not demonstrate that, because the merchant
// wrote the buyer.
//
// So this file is a *separate* MCP client. It shares no code and no
// memory with the server — it speaks JSON-RPC over Streamable HTTP,
// exactly as Claude Desktop or the MCP Inspector would. It discovers
// the merchant, obtains a signed mandate, browses, drafts, and pays,
// and it declares the elicitation capability so the server can ask a
// human before a large spend.
//
// Anything this test can do, any MCP client can do.
//
//   npm run dev          (one terminal)
//   npm run test:buyer   (another)
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const MERCHANT_MCP = process.env.MERCHANT_MCP_URL || "http://localhost:4200/mcp";
const BASE = process.env.COMMERCE_AGENT_URL || "http://localhost:4200";
const AGENT_ID = "external-buyer-bot";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${String(err.message).split("\n")[0]}`);
  }
}

const json = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);

// What the buyer's "human" will answer when the merchant asks for
// approval. Flipped between tests to prove both branches.
let humanWillApprove = true;
const elicitations = [];

async function connect() {
  const client = new Client(
    { name: "external-buyer-bot", version: "1.0.0" },
    // Declaring elicitation is what lets the merchant reach a human.
    // A client without it cannot be asked, and the merchant refuses
    // rather than assuming consent.
    { capabilities: { elicitation: {} } }
  );

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    elicitations.push(request.params.message);
    console.log(`\n        [human-in-the-loop] merchant asks:\n        ${request.params.message.split("\n").join("\n        ")}`);
    console.log(`        [human-in-the-loop] answering: ${humanWillApprove ? "APPROVE" : "DECLINE"}\n`);
    return humanWillApprove ? { action: "accept", content: { approve: true } } : { action: "decline" };
  });

  await client.connect(new StreamableHTTPClientTransport(new URL(MERCHANT_MCP)));
  return client;
}

async function main() {
  console.log("\nEXTERNAL AI BUYER — a client the merchant did not write\n");

  await fetch(`${BASE}/debug/reset-demo`, { method: "POST" });
  await fetch(`${BASE}/debug/set-stock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ product_id: "sku-019", qty: 40 }),
  });

  const client = await connect();
  console.log("Connected to the merchant over Streamable HTTP MCP.\n");

  let mandateToken;
  let orderId;
  let cartToken;

  console.log("1. Discovery");
  console.log("------------");

  await test("the merchant advertises tools with honest annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ["get_merchant_profile", "request_mandate", "search_products", "draft_order", "confirm_checkout"]) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
    const search = tools.find((t) => t.name === "search_products");
    assert.equal(search.annotations.readOnlyHint, true, "a search tool must declare itself read-only");

    const confirm = tools.find((t) => t.name === "confirm_checkout");
    assert.equal(confirm.annotations.idempotentHint, true, "confirm_checkout claims idempotency — the trust suite proves it");
  });

  await test("the merchant profile states what it refuses to do", async () => {
    const profile = json(await client.callTool({ name: "get_merchant_profile", arguments: {} }));
    assert.equal(profile.merchant_id, "merchant_agentic_bazaar");
    assert.ok(profile.capabilities.includes("signed_cart_mandate"));
    assert.ok(profile.refuses.length >= 4, "a merchant should publish its limits, not just its catalog");
    assert.ok(profile.mandate_protocol.verification_key_id.startsWith("merchant:"));
  });

  console.log("\n2. Buying without a credential");
  console.log("------------------------------");

  await test("drafting with no mandate returns a payment-required refusal, not an error", async () => {
    const result = await client.callTool({
      name: "draft_order",
      arguments: { mandate_token: "", agent_id: AGENT_ID, items: [{ product_id: "sku-019", qty: 1 }] },
    });
    const body = json(result);
    assert.equal(body.error, "payment_mandate_required");
    assert.equal(body.http_analogue, 402);
    assert.ok(body.how_to_obtain.tool, "the refusal must tell a competent agent how to fix itself");
  });

  console.log("\n3. Obtaining a mandate and buying");
  console.log("---------------------------------");

  await test("the buyer obtains a signed Intent Mandate", async () => {
    const body = json(
      await client.callTool({
        name: "request_mandate",
        arguments: {
          agent_id: AGENT_ID,
          agent_name: "External Buyer Bot",
          max_amount_paise: 800000,
          allowed_categories: ["gifting", "home"],
          ttl_hours: 1,
        },
      })
    );
    mandateToken = body.mandate_token;
    assert.ok(mandateToken?.startsWith("acl_"), "expected a presentable credential token");
    assert.ok(body.signed_by.startsWith("user:"), "the mandate must be signed by the wallet, not the merchant");
    assert.equal(body.constraints.max_amount_paise, 800000);
  });

  await test("the buyer browses real inventory", async () => {
    const body = json(await client.callTool({ name: "search_products", arguments: { query: "candle", category: "gifting" } }));
    assert.ok(body.count > 0, "the catalog should return gifting results");
    assert.ok(body.results.every((p) => typeof p.price_paise === "number"));
  });

  await test("a mandate bound to one agent cannot be used by another", async () => {
    const body = json(
      await client.callTool({
        name: "draft_order",
        arguments: { mandate_token: mandateToken, agent_id: "some-other-agent", items: [{ product_id: "sku-019", qty: 1 }] },
      })
    );
    assert.equal(body.error, "agent_mismatch", `expected agent binding to be enforced, got ${JSON.stringify(body)}`);
  });

  await test("a small order drafts and returns a merchant-signed cart", async () => {
    const body = json(
      await client.callTool({
        name: "draft_order",
        arguments: { mandate_token: mandateToken, agent_id: AGENT_ID, items: [{ product_id: "sku-019", qty: 1 }] },
      })
    );
    assert.equal(body.decision, "approved", body.reason);
    assert.ok(body.cart_mandate_token?.startsWith("acl_"), "an approved cart must come back signed");
    orderId = body.order_draft_id;
    cartToken = body.cart_mandate_token;
  });

  await test("an out-of-scope category is refused to the external agent too", async () => {
    const body = json(
      await client.callTool({
        name: "draft_order",
        arguments: { mandate_token: mandateToken, agent_id: AGENT_ID, items: [{ product_id: "sku-012", qty: 1 }] },
      })
    );
    assert.equal(body.decision, "blocked");
    assert.equal(body.reason, body.reason);
    assert.match(body.reason, /apparel/, "the refusal should name the category it rejected");
  });

  await test("the buyer pays, below the threshold, with no human needed", async () => {
    const body = json(
      await client.callTool({
        name: "confirm_checkout",
        arguments: { mandate_token: mandateToken, agent_id: AGENT_ID, order_draft_id: orderId, cart_mandate_token: cartToken },
      })
    );
    assert.equal(body.status, "awaiting_payment", JSON.stringify(body));
    assert.ok(body.payment_link, "a payment link should be returned to the agent");
    assert.equal(elicitations.length, 0, "₹899 is under the threshold — a human should not have been interrupted");
  });

  await test("retrying confirm_checkout is safe", async () => {
    const body = json(
      await client.callTool({
        name: "confirm_checkout",
        arguments: { mandate_token: mandateToken, agent_id: AGENT_ID, order_draft_id: orderId, cart_mandate_token: cartToken },
      })
    );
    assert.equal(body.replayed, true, "the annotation says idempotent; this proves it");
  });

  console.log("\n4. Human-in-the-loop across the trust boundary");
  console.log("----------------------------------------------");

  await test("a large order asks the buyer's human, and proceeds when approved", async () => {
    humanWillApprove = true;
    const draft = json(
      await client.callTool({
        name: "draft_order",
        arguments: { mandate_token: mandateToken, agent_id: AGENT_ID, items: [{ product_id: "sku-017", qty: 1 }] },
      })
    );
    assert.equal(draft.decision, "needs_confirmation", `₹1,999 is above the ₹1,500 threshold: ${draft.reason}`);

    const before = elicitations.length;
    const body = json(
      await client.callTool({
        name: "confirm_checkout",
        arguments: {
          mandate_token: mandateToken,
          agent_id: AGENT_ID,
          order_draft_id: draft.order_draft_id,
          cart_mandate_token: draft.cart_mandate_token,
        },
      })
    );
    assert.equal(elicitations.length, before + 1, "the merchant should have asked the buyer's human");
    assert.equal(body.status, "awaiting_payment", JSON.stringify(body));
  });

  await test("declining the prompt stops the payment", async () => {
    humanWillApprove = false;
    await fetch(`${BASE}/debug/set-stock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id: "sku-020", qty: 50 }),
    });

    const draft = json(
      await client.callTool({
        name: "draft_order",
        arguments: { mandate_token: mandateToken, agent_id: AGENT_ID, items: [{ product_id: "sku-020", qty: 2 }] },
      })
    );
    assert.equal(draft.decision, "needs_confirmation", draft.reason);

    const body = json(
      await client.callTool({
        name: "confirm_checkout",
        arguments: {
          mandate_token: mandateToken,
          agent_id: AGENT_ID,
          order_draft_id: draft.order_draft_id,
          cart_mandate_token: draft.cart_mandate_token,
        },
      })
    );
    assert.equal(body.status, "declined_by_human", JSON.stringify(body));

    const status = json(await client.callTool({ name: "get_order_status", arguments: { order_draft_id: draft.order_draft_id } }));
    assert.notEqual(status.status, "awaiting_payment", "a declined order must not have a live payment link");
  });

  await test("the human's decision is recorded in the merchant's ledger", async () => {
    const events = await (await fetch(`${BASE}/audit`)).json();
    assert.ok(events.some((e) => e.event_type === "human_approved"), "an approval should be auditable");
    assert.ok(events.some((e) => e.event_type === "human_declined"), "a refusal should be auditable");
  });

  console.log("\n5. Budget accounting from the buyer's side");
  console.log("------------------------------------------");

  await test("the buyer can read its own remaining balance", async () => {
    const body = json(await client.callTool({ name: "check_mandate_balance", arguments: { mandate_token: mandateToken, agent_id: AGENT_ID } }));
    assert.equal(body.cap_paise, 800000);
    assert.ok(body.held_paise > 0, "unpaid orders should show as held");
    assert.equal(body.cap_paise, body.spent_paise + body.held_paise + body.available_paise, "the ledger must balance");
  });

  await test("spending past the cap is refused even with a valid mandate", async () => {
    // 10 x ₹1,999 = ₹19,990, well past the ₹8,000 cap no matter what
    // is already on hold.
    const body = json(
      await client.callTool({
        name: "draft_order",
        arguments: { mandate_token: mandateToken, agent_id: AGENT_ID, items: [{ product_id: "sku-017", qty: 10 }] },
      })
    );
    assert.equal(body.decision, "blocked", `expected over-budget block, got ${body.decision}: ${body.reason}`);
    assert.equal(body.reason_code, "over_budget");
    assert.ok(body.reason.includes("₹"), "the block must quote real figures");
  });

  await client.close();

  console.log(`\n${"=".repeat(58)}`);
  if (failures.length) {
    console.error(`${passed} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error(`  ${f.name}\n    ${f.err.message}\n`);
    process.exit(1);
  }
  console.log(`All ${passed} external-buyer checks passed.`);
  console.log("An MCP client that shares no code with this merchant bought from it,");
  console.log("was held to a signed mandate, and had to ask a human before a large spend.");
  console.log(`${"=".repeat(58)}\n`);
}

main().catch((err) => {
  console.error("\nSUITE CRASHED:", err);
  process.exit(1);
});
