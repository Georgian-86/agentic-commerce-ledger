// The Merchant Commerce MCP server — the part that makes the claim true.
//
// The track asks for a merchant that is "transactable by an AI buyer
// end to end". A chat widget on the merchant's own site does not prove
// that: the merchant wrote the buyer.
//
// This endpoint is the real version. Any MCP client — Claude Desktop,
// the MCP Inspector, another team's agent — connects to
// POST /mcp on this service, discovers the merchant, obtains or
// presents a signed mandate, and buys something. The buyer is code we
// did not write, running in a process we do not control, and the trust
// layer holds anyway, because it never depended on trusting the buyer.
//
// Two MCP features are doing real work here, not decorating:
//
//   Elicitation — when an order is above the unattended-spend
//   threshold, the server sends elicitation/create back to the client
//   and blocks. The buyer's *human* sees a confirmation form in their
//   own client and answers. That is genuine human-in-the-loop across a
//   trust boundary: the merchant obtains consent from a person it has
//   no UI with. If the client doesn't support elicitation, the order
//   comes back needs_confirmation rather than proceeding — degrade
//   closed, never open.
//
//   Tool annotations — readOnlyHint / destructiveHint / idempotentHint
//   are set honestly, so a well-behaved client can decide for itself
//   which calls need supervision. confirm_checkout is marked idempotent
//   because it genuinely is, not because it sounds better.
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { catalog } from "./mcpClient.js";
import { merchantProfile } from "./merchantProfile.js";
import { draftOrder, confirmCheckout } from "./checkout.js";
import { getDraft } from "./orders.js";
import { decodeToken, encodeToken, verifyIntentMandate, MERCHANT_ID } from "./mandate.js";
import { issueForAgent } from "./wallet.js";
import { balance } from "./ledger.js";
import { formatPaise } from "./money.js";
import { recordEvent } from "./audit.js";
import { publicKeyDirectory } from "./keys.js";

const CATEGORIES = ["audio", "home", "apparel", "gifting"];

// Declared output schemas are enforced by the SDK against what the tool
// actually returns, which is the point of them — but it also means an
// incomplete schema breaks the tool rather than merely under-describing
// it. These list every field on every branch, including the refusal
// branches, so a client can rely on the shape it's told to expect.
const DRAFT_OUTPUT_SCHEMA = {
  status: z.string().describe('"drafted" | "needs_confirmation" | "blocked" | "unavailable" | "refused"'),
  decision: z.string().optional().describe('Gate verdict: "approved" | "needs_confirmation" | "blocked"'),
  reason: z.string().optional().describe("Plain-English explanation, authored by the Gate. Relay it verbatim."),
  reason_code: z.string().optional(),
  order_draft_id: z.string().optional(),
  total: z.string().optional().describe("Formatted total, e.g. ₹1,999"),
  total_paise: z.number().optional(),
  items: z.array(z.any()).optional(),
  balance: z.any().optional().describe("cap / held / spent / available on the presented mandate"),
  cart_mandate_token: z.string().nullable().optional().describe("Merchant-signed cart. Present it back on confirm_checkout."),
  upsell_suggestion: z.any().nullable().optional(),
  alternative: z.any().nullable().optional(),
  unavailable_items: z.array(z.any()).optional(),
  next_step: z.string().optional(),
  error: z.string().optional(),
  http_analogue: z.number().optional().describe("402 when a mandate is required but absent or invalid."),
  how_to_obtain: z.any().optional(),
};

const CONFIRM_OUTPUT_SCHEMA = {
  status: z.string().describe('"awaiting_payment" | "needs_confirmation" | "blocked" | "failed" | "declined_by_human" | "paid" | "refused"'),
  reason: z.string().optional(),
  reason_code: z.string().optional(),
  order_draft_id: z.string().optional(),
  total: z.string().optional(),
  total_paise: z.number().optional(),
  payment_link: z.string().optional().describe("Open this to pay."),
  payment_link_id: z.string().optional(),
  payment_mandate_id: z.string().optional(),
  demo_mode: z.boolean().optional(),
  replayed: z.boolean().optional().describe("True when this call was recognised as a retry of one already handled."),
  balance: z.any().optional(),
  alternative: z.any().nullable().optional(),
  message: z.string().optional(),
  next_step: z.string().optional(),
  error: z.string().optional(),
  http_analogue: z.number().optional(),
  how_to_obtain: z.any().optional(),
};

/** Wrap a value as MCP tool output: structured content plus the
 *  serialised text block the spec asks for on backwards-compat grounds. */
function out(value, isError = false) {
  // Strip undefined before it reaches structuredContent: the SDK
  // validates that object against the declared output schema, and an
  // explicitly-undefined property is a present key with no valid type.
  const clean = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
    : value;
  return {
    content: [{ type: "text", text: JSON.stringify(clean, null, 2) }],
    structuredContent: clean,
    isError,
  };
}

/**
 * Resolve a presented mandate token into a verified mandate, or return
 * a payment-required-shaped refusal. The 402 framing is deliberate: an
 * agent that arrives without a credential is not experiencing an error,
 * it is being told what it needs to obtain. That's the x402 idea, and
 * it makes the failure self-healing for a competent client.
 */
function requireMandate(token, agent_id) {
  const decoded = decodeToken(token);
  if (!decoded) {
    return {
      ok: false,
      payload: {
        status: "refused",
        error: "payment_mandate_required",
        http_analogue: 402,
        reason:
          "No valid Intent Mandate was presented. Call request_mandate to obtain one, then pass its token as `mandate_token` on every subsequent call.",
        how_to_obtain: { tool: "request_mandate", required: ["max_amount_paise", "allowed_categories"] },
      },
    };
  }
  const verification = verifyIntentMandate(decoded, { agent_id });
  if (!verification.ok) {
    return {
      ok: false,
      payload: {
        status: "refused",
        error: verification.reason_code,
        http_analogue: 402,
        reason: verification.reason,
      },
    };
  }
  return { ok: true, mandate: verification.mandate };
}

export function buildMerchantMcpServer() {
  const server = new McpServer(
    { name: "agentic-bazaar-commerce", version: "0.2.0" },
    {
      instructions: `You are connected to ${merchantProfile().name}, a merchant that sells to AI agents.

Start by calling get_merchant_profile. It tells you what credential this merchant accepts and what it refuses to do.

To buy something:
  1. request_mandate — obtain a signed Intent Mandate scoped to a budget and categories. Keep the returned token; every later call needs it.
  2. search_products / get_product — browse real inventory.
  3. draft_order — price a basket. Returns a merchant-SIGNED cart with a frozen total. Nothing is charged.
  4. confirm_checkout — pay. Above this merchant's unattended-spend threshold you will be asked to confirm with your human first.

Spending limits are enforced server-side against the signed mandate. Asking differently will not change them.`,
    }
  );

  /* ---------------- Discovery ---------------- */

  server.registerTool(
    "get_merchant_profile",
    {
      title: "Get merchant profile",
      description:
        "Machine-readable description of this merchant: which mandate protocol it speaks, what it signs, its spending limits, its settlement rail, and what it refuses to do. Call this first.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => out({ ...merchantProfile(), keys: publicKeyDirectory() })
  );

  /* ---------------- Credential issuance ---------------- */

  server.registerTool(
    "request_mandate",
    {
      title: "Request a spending mandate",
      description:
        "Obtain a signed Intent Mandate authorising this agent to spend up to a stated cap in stated categories. In production this request goes to the shopper's own wallet for approval; here the wallet is simulated in-process and says so. Returns a token to present on every later call.",
      inputSchema: {
        agent_id: z.string().min(3).max(64).describe("Stable identifier for the calling agent. The mandate is bound to it."),
        agent_name: z.string().max(120).optional(),
        max_amount_paise: z.number().int().min(10000).max(2000000).describe("Total spending cap in paise. Capped at ₹20,000 for demo safety."),
        allowed_categories: z.array(z.enum(CATEGORIES)).min(1),
        max_per_order_paise: z.number().int().positive().optional(),
        ttl_hours: z.number().int().min(1).max(24).default(2),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ agent_id, agent_name, max_amount_paise, allowed_categories, max_per_order_paise, ttl_hours }) => {
      const record = issueForAgent({
        agent_id,
        agent_name,
        subject: agent_id,
        max_amount_paise,
        allowed_categories,
        max_per_order_paise: max_per_order_paise ?? null,
        ttl_hours,
      });

      recordEvent({
        actor: agent_id,
        mandate_id: record.mandate.mandate_id,
        event_type: "mandate_issued",
        decision: "approved",
        reason: `External agent "${agent_id}" was issued Intent Mandate ${record.mandate.mandate_id}: ${formatPaise(max_amount_paise)} cap, categories ${allowed_categories.join(", ")}, expiring ${record.mandate.expires_at}. Signed by the shopper wallet key ${record.mandate.proof.key_id}, which this merchant can verify but cannot mint.`,
        raw_context: { agent_id, max_amount_paise, allowed_categories, external: true },
      });

      return out({
        mandate_token: record.token,
        mandate_id: record.mandate.mandate_id,
        expires_at: record.mandate.expires_at,
        constraints: record.mandate.constraints,
        signed_by: record.mandate.proof.key_id,
        note: "Present `mandate_token` on every draft_order and confirm_checkout call. It is bound to your agent_id — another agent cannot use it.",
      });
    }
  );

  /* ---------------- Catalog (read-only) ---------------- */

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Search live inventory by free text, optional category, optional maximum price in paise.",
      inputSchema: {
        query: z.string().default(""),
        category: z.enum(CATEGORIES).optional(),
        max_price_paise: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => out(await catalog.search(args))
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product detail",
      description: "Full detail for one product, including related SKUs.",
      inputSchema: { product_id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ product_id }) => {
      const product = await catalog.getProduct(product_id).catch(() => null);
      if (!product) return out({ error: "not_found", product_id }, true);
      return out(product);
    }
  );

  server.registerTool(
    "get_policies",
    {
      title: "Get merchant policy",
      description: "The merchant's returns, shipping, or warranty policy in plain text.",
      inputSchema: { topic: z.enum(["returns", "shipping", "warranty"]) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ topic }) => out(await catalog.getPolicy(topic))
  );

  server.registerTool(
    "check_mandate_balance",
    {
      title: "Check mandate balance",
      description: "How much of a presented mandate is still available, and how much is held against unpaid orders.",
      inputSchema: { mandate_token: z.string(), agent_id: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ mandate_token, agent_id }) => {
      const gate = requireMandate(mandate_token, agent_id);
      if (!gate.ok) return out(gate.payload, true);
      const position = balance(gate.mandate);
      return out({
        ...position,
        cap: formatPaise(position.cap_paise),
        available: formatPaise(position.available_paise),
        held: formatPaise(position.held_paise),
        spent: formatPaise(position.spent_paise),
      });
    }
  );

  /* ---------------- Checkout ---------------- */

  server.registerTool(
    "draft_order",
    {
      title: "Draft an order",
      description:
        "Price a basket against live inventory and check it against your signed mandate. Moves no money. On success returns a merchant-signed Cart Mandate whose total is cryptographically frozen for 10 minutes.",
      inputSchema: {
        mandate_token: z.string().describe("The Intent Mandate token from request_mandate."),
        agent_id: z.string().optional(),
        items: z
          .array(z.object({ product_id: z.string(), qty: z.number().int().min(1).max(20) }))
          .min(1)
          .max(10),
      },
      outputSchema: DRAFT_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ mandate_token, agent_id, items }) => {
      const gate = requireMandate(mandate_token, agent_id);
      if (!gate.ok) return out(gate.payload, true);

      const result = await draftOrder({
        mandate: gate.mandate,
        items,
        agent_id: agent_id || gate.mandate.issued_to?.agent_id || "external-agent",
      });

      return out({
        status: result.status,
        order_draft_id: result.order_draft_id,
        decision: result.decision,
        reason: result.reason,
        reason_code: result.reason_code,
        total: result.total,
        total_paise: result.total_paise,
        items: result.items,
        balance: result.balance,
        cart_mandate_token: result.cart_mandate_token ?? null,
        upsell_suggestion: result.upsell_suggestion,
        alternative: result.alternative,
        unavailable_items: result.unavailable_items,
        next_step:
          result.decision === "blocked"
            ? "This basket cannot be bought under the presented mandate. Adjust it or request a different mandate."
            : result.status === "unavailable"
              ? "One or more items are not available at the requested quantity. Try the suggested alternative."
              : "Call confirm_checkout with this order_draft_id and cart_mandate_token to pay.",
      });
    }
  );

  server.registerTool(
    "confirm_checkout",
    {
      title: "Confirm checkout and pay",
      description:
        "Complete a drafted order and create a Razorpay payment link. Above this merchant's unattended-spend threshold you will be asked to confirm with your human before anything is charged. Safe to retry: a repeated call returns the original payment link rather than charging twice.",
      inputSchema: {
        mandate_token: z.string(),
        order_draft_id: z.string(),
        cart_mandate_token: z.string().optional().describe("The signed cart from draft_order. Presenting it back proves the price you agreed to."),
        agent_id: z.string().optional(),
        accept_upsell: z.boolean().default(false),
      },
      outputSchema: CONFIRM_OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Genuinely true: idempotency.js keys on order_draft_id, so a
        // retry returns the first result and never creates a second
        // payment link or a second ledger hold.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ mandate_token, order_draft_id, cart_mandate_token, agent_id, accept_upsell }, extra) => {
      const gate = requireMandate(mandate_token, agent_id);
      if (!gate.ok) return out(gate.payload, true);

      const cart = cart_mandate_token ? decodeToken(cart_mandate_token) : null;
      const callerId = agent_id || gate.mandate.issued_to?.agent_id || "external-agent";

      // First pass with human_confirmed=false. If the Gate says this is
      // within budget but above the unattended threshold, we go and get
      // a human — we do not decide on their behalf.
      let result = await confirmCheckout({
        mandate: gate.mandate,
        order_draft_id,
        cart_mandate: cart,
        accept_upsell,
        agent_id: callerId,
        human_confirmed: false,
      });

      if (result.status === "needs_confirmation") {
        const approval = await elicitHumanApproval({ server, extra, result, callerId, mandate: gate.mandate, order_draft_id });
        if (!approval.granted) return out(approval.payload, approval.isError);

        result = await confirmCheckout({
          mandate: gate.mandate,
          order_draft_id,
          cart_mandate: cart,
          accept_upsell,
          agent_id: callerId,
          human_confirmed: true,
        });
      }

      return out({
        status: result.status,
        order_draft_id: result.order_draft_id ?? order_draft_id,
        reason: result.reason,
        reason_code: result.reason_code,
        total: result.total,
        total_paise: result.total_paise,
        payment_link: result.payment_link,
        payment_link_id: result.payment_link_id,
        payment_mandate_id: result.payment_mandate?.payment_mandate_id,
        demo_mode: result.demo_mode,
        replayed: result.replayed,
        alternative: result.alternative,
        balance: result.balance,
        message: result.message,
        next_step:
          result.status === "awaiting_payment"
            ? "Open payment_link to complete payment. Poll get_order_status until it reports \"paid\"."
            : undefined,
      });
    }
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Get order status",
      description: "Current status of an order draft: drafted, needs_confirmation, blocked, awaiting_payment, paid, failed, expired or refunded.",
      inputSchema: { order_draft_id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ order_draft_id }) => {
      const draft = getDraft(order_draft_id);
      if (!draft) return out({ error: "unknown_order", order_draft_id }, true);
      return out({
        order_draft_id: draft.id,
        status: draft.status,
        total_paise: draft.total_paise,
        total: formatPaise(draft.total_paise),
        items: draft.items,
        payment_link: draft.payment_link?.short_url || null,
        payment_id: draft.payment_id,
        cart_id: draft.cart_mandate?.cart_id || null,
        payment_mandate_id: draft.payment_mandate?.payment_mandate_id || null,
      });
    }
  );

  /* ---------------- Resources ---------------- */

  server.registerResource(
    "merchant-profile",
    "merchant://profile",
    { title: "Merchant profile", description: "How to transact with this merchant.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(merchantProfile(), null, 2) }],
    })
  );

  server.registerResource(
    "trust-keys",
    "merchant://keys",
    { title: "Verification keys", description: "Public keys for verifying this merchant's signatures.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(publicKeyDirectory(), null, 2) }],
    })
  );

  return server;
}

/**
 * Ask the connected client's human to approve a spend, over MCP
 * elicitation. Declining, cancelling, or connecting a client with no
 * elicitation support all lead to the same place: the payment does not
 * happen. There is no branch here that proceeds without an answer.
 */
async function elicitHumanApproval({ server, extra, result, callerId, mandate, order_draft_id }) {
  const supportsElicitation = Boolean(server.server.getClientCapabilities()?.elicitation);

  if (!supportsElicitation) {
    recordEvent({
      actor: callerId,
      mandate_id: mandate.mandate_id,
      order_draft_id,
      event_type: "confirmation_unavailable",
      decision: "blocked",
      reason: `Order ${order_draft_id} for ${result.total} needs human approval, but the connected client declared no elicitation capability — there is no way to ask a person. The order was left unpaid rather than approved by default.`,
      raw_context: { total_paise: result.total_paise },
    });
    return {
      granted: false,
      isError: false,
      payload: {
        status: "needs_confirmation",
        order_draft_id,
        reason: result.reason,
        message:
          "This order needs a human approval and your client does not support MCP elicitation, so there was no way to ask. Approve it in the merchant dashboard, or reconnect with a client that supports elicitation.",
      },
    };
  }

  const draft = getDraft(order_draft_id);
  const lines = (draft?.items || []).map((i) => `${i.qty} x ${i.name} — ${formatPaise(i.line_total_paise)}`).join("\n");

  let response;
  try {
    response = await server.server.elicitInput({
      message: `Approve this purchase?\n\n${lines}\n\nTotal: ${result.total}\nMerchant: ${MERCHANT_ID}\nMandate: ${mandate.mandate_id}\n\n${result.reason}`,
      requestedSchema: {
        type: "object",
        properties: {
          approve: {
            type: "boolean",
            title: `Charge ${result.total}?`,
            description: "Tick to authorise this payment. Leaving it unticked cancels the order.",
            default: false,
          },
        },
        required: ["approve"],
      },
    });
  } catch (err) {
    recordEvent({
      actor: callerId,
      mandate_id: mandate.mandate_id,
      order_draft_id,
      event_type: "confirmation_failed",
      decision: "blocked",
      reason: `Human approval could not be obtained for order ${order_draft_id} (${result.total}): ${String(err?.message || err)}. No payment was created.`,
    });
    return {
      granted: false,
      isError: true,
      payload: { status: "needs_confirmation", order_draft_id, message: "Could not reach a human to approve this spend. Nothing was charged." },
    };
  }

  const granted = response?.action === "accept" && response?.content?.approve === true;

  recordEvent({
    actor: "human",
    mandate_id: mandate.mandate_id,
    order_draft_id,
    event_type: granted ? "human_approved" : "human_declined",
    decision: granted ? "approved" : "blocked",
    reason: granted
      ? `A human approved ${result.total} for order ${order_draft_id} through an MCP elicitation prompt in the buyer's own client. The agent could not have granted this itself.`
      : `A human ${response?.action === "decline" ? "declined" : "dismissed"} the approval prompt for ${result.total} on order ${order_draft_id}. No payment was created.`,
    raw_context: { action: response?.action, total_paise: result.total_paise, via: "mcp_elicitation" },
  });

  if (!granted) {
    return {
      granted: false,
      isError: false,
      payload: {
        status: "declined_by_human",
        order_draft_id,
        message: "The human declined this purchase. Nothing was charged and the order was not created.",
      },
    };
  }
  return { granted: true };
}

/* ------------------------------------------------------------------ */
/*  Transport                                                          */
/* ------------------------------------------------------------------ */
//
// Sessions are stateful here, deliberately. The stateless pattern —
// a fresh server per request — is simpler and it is what the catalog
// server uses, because that server only answers questions.
//
// It cannot work for this one. Elicitation is a request travelling
// server → client mid-tool-call, and the client's answer arrives as a
// separate HTTP request. A server rebuilt per request has no memory of
// the question it just asked, so the answer lands nowhere. Human
// approval requires the connection to persist.

const sessions = new Map(); // session_id -> { transport, server, last_seen }
const SESSION_TTL_MS = 30 * 60 * 1000;

function sweepSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, record] of sessions) {
    if (record.last_seen >= cutoff) continue;
    sessions.delete(id);
    try {
      record.transport.close();
      record.server.close();
    } catch {
      // A session that has already gone away is exactly what we wanted.
    }
  }
}

export async function handleMerchantMcpRequest(req, res) {
  sweepSessions();
  const sessionId = req.get("mcp-session-id");

  try {
    if (sessionId && sessions.has(sessionId)) {
      const record = sessions.get(sessionId);
      record.last_seen = Date.now();
      return await record.transport.handleRequest(req, res, req.body);
    }

    if (sessionId) {
      return res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unknown or expired MCP session. Re-initialize to continue." },
        id: null,
      });
    }

    if (!isInitializeRequest(req.body)) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: send an initialize request first, or include the mcp-session-id header." },
        id: null,
      });
    }

    const server = buildMerchantMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, last_seen: Date.now() });
        console.log(`[merchant-mcp] external buyer connected — session ${id.slice(0, 8)}…`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[merchant-mcp] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
}

/** GET opens the server→client SSE stream; DELETE tears the session down. */
export async function handleMerchantMcpSessionRequest(req, res) {
  const sessionId = req.get("mcp-session-id");
  const record = sessionId ? sessions.get(sessionId) : null;
  if (!record) {
    return res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unknown or expired MCP session." },
      id: null,
    });
  }
  record.last_seen = Date.now();
  await record.transport.handleRequest(req, res);
}

export function mcpSessionCount() {
  sweepSessions();
  return sessions.size;
}

export { encodeToken };
