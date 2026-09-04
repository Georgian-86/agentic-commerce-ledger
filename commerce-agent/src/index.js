import { config as loadEnv } from "dotenv";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load the monorepo root .env by absolute path, not process.cwd().
// `npm run dev -w commerce-agent` runs this file with cwd set to
// commerce-agent/, so a bare `dotenv/config` would look for
// commerce-agent/.env, find nothing, and leave every secret undefined
// with no error at all.
//
// This has to be a plain function call, not `import "dotenv/config"` —
// ES module import declarations are hoisted and evaluated before any
// ordinary statement in the file, no matter where the statement sits.
// So every sibling module that reads process.env at its own top level
// is loaded below with `await import(...)`, a real function call, which
// runs strictly after loadEnv() has populated the environment.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "..", ".env") });

// Resolve the public origin BEFORE any sibling module is imported —
// shopperAgent.js and checkout.js read PUBLIC_BASE_URL at their own top
// level, so it has to be correct in the environment by now. Render sets
// RENDER_EXTERNAL_URL; Railway sets RAILWAY_PUBLIC_DOMAIN; Fly/others must
// set PUBLIC_BASE_URL explicitly. Real Razorpay payments will not verify
// if this is wrong, since it builds the callback URL.
const RESOLVED_PORT = Number(process.env.PORT || process.env.COMMERCE_AGENT_PORT || 4200);
if (!process.env.PUBLIC_BASE_URL) {
  process.env.PUBLIC_BASE_URL =
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "") ||
    `http://localhost:${RESOLVED_PORT}`;
}

// ---- Single-service mode --------------------------------------------------
// In production we run the catalog MCP server inside this process, bound to
// loopback, and point the MCP client at it. Two things stay exactly as they
// were: the shopper agent still reaches the catalog only over MCP-over-HTTP
// (the architecture claim holds), and `npm run dev` still runs catalog-server
// as its own process. EMBED_CATALOG defaults on unless explicitly "false".
const EMBED_CATALOG = String(process.env.EMBED_CATALOG ?? "true").toLowerCase() !== "false";
if (EMBED_CATALOG) {
  const catalogPort = Number(process.env.CATALOG_SERVER_PORT || 4100);
  process.env.CATALOG_SERVER_URL ||= `http://127.0.0.1:${catalogPort}/mcp`;
  const { startCatalogServer } = await import("../../catalog-server/src/index.js");
  await startCatalogServer({ port: catalogPort, host: "127.0.0.1" });
}

const { issueSeedMandates, listIssued, getIssued, AGENT_ID } = await import("./wallet.js");
const { startSession, runTurn, humanConfirm, getSession } = await import("./shopperAgent.js");
const { listEvents, onEvent, recordEvent, verifyChain, chainHead } = await import("./audit.js");
const { metrics } = await import("./growth.js");
const { llmUsage } = await import("./llmClient.js");
const {
  verifyPaymentLinkSignature,
  verifyWebhookSignature,
  parsePaymentLinkWebhook,
  buildDemoCallback,
  buildDemoWebhook,
  isDemoMode,
  rail,
} = await import("./razorpay.js");
const { findByReferenceOrLinkId, getDraft, listDrafts } = await import("./orders.js");
const { draftOrder, confirmCheckout, settlePayment, abandonCheckout, refundOrder } = await import("./checkout.js");
const { debugSetStock } = await import("./mcpClient.js");
const ledger = await import("./ledger.js");
const { balance, snapshot, setExpiryHandler } = ledger;
const { encodeToken, decodeToken, tamperWithMandate, MERCHANT_ID } = await import("./mandate.js");
const { publicKeyDirectory } = await import("./keys.js");
const { merchantProfile } = await import("./merchantProfile.js");
const { handleMerchantMcpRequest, handleMerchantMcpSessionRequest, mcpSessionCount } = await import("./merchantMcp.js");
const { onTraceEvent, recentTraces } = await import("./agent/trace.js");
const memory = await import("./agent/memory.js");
const { formatPaise } = await import("./money.js");
const { seen } = await import("./idempotency.js");

const DASHBOARD_DIR = join(__dirname, "..", "..", "dashboard");
const PORT = RESOLVED_PORT;
const HOST = process.env.HOST || "0.0.0.0";

// An expired authorisation hold has to leave a trace — otherwise budget
// silently reappears and nobody can explain why.
setExpiryHandler(({ mandate_id, order_id, reason }) => {
  recordEvent({
    actor: "checkout_agent",
    mandate_id,
    order_draft_id: order_id,
    event_type: "hold_expired",
    decision: "approved",
    reason,
    raw_context: { auto: true },
  });
});

issueSeedMandates();

const app = express();
// Behind a PaaS load balancer, trust the first proxy hop so req.protocol
// and the client IP are the real ones (matters for correct callback URLs).
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cors());

/* ------------------------------------------------------------------ */
/*  Razorpay webhook — MUST be mounted before express.json()           */
/* ------------------------------------------------------------------ */
// The signature is computed over the raw request bytes. If the JSON
// parser touches the body first, re-serialising it produces different
// bytes and every signature fails. So this route takes the raw buffer
// and parses it itself, after verification.
app.post("/webhooks/razorpay", express.raw({ type: "*/*" }), async (req, res) => {
  const signature = req.get("x-razorpay-signature");
  const eventId = req.get("x-razorpay-event-id") || null;

  if (!verifyWebhookSignature(req.body, signature)) {
    recordEvent({
      actor: "checkout_agent",
      event_type: "webhook_rejected",
      decision: "blocked",
      severity: "critical",
      reason: `A webhook arrived with an X-Razorpay-Signature that did not verify against this account's webhook secret. It was rejected without being parsed — an unverified webhook is an unauthenticated stranger asking us to mark an order paid.`,
      raw_context: { event_id: eventId, bytes: req.body?.length ?? 0 },
    });
    return res.status(400).json({ ok: false, error: "signature_verification_failed" });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf-8"));
  } catch {
    return res.status(400).json({ ok: false, error: "malformed_json" });
  }

  // Razorpay's own docs say webhooks may be delivered more than once
  // and out of order, and give x-razorpay-event-id as the dedupe key.
  if (eventId && seen("webhook", eventId)) {
    recordEvent({
      actor: "checkout_agent",
      event_type: "webhook_duplicate_ignored",
      decision: "approved",
      reason: `Webhook ${eventId} (${event.event}) had already been processed and was ignored. Razorpay documents at-least-once delivery, so this is expected traffic, not an error.`,
      raw_context: { event_id: eventId, event: event.event },
    });
    return res.json({ ok: true, duplicate: true });
  }

  const parsed = parsePaymentLinkWebhook(event);
  if (!parsed || parsed.event_type !== "payment_link.paid") {
    recordEvent({
      actor: "checkout_agent",
      event_type: "webhook_received",
      decision: "approved",
      reason: `Webhook ${event.event} verified and acknowledged. No action is defined for this event type.`,
      raw_context: { event: event.event, event_id: eventId },
    });
    return res.json({ ok: true, handled: false });
  }

  const draft = findByReferenceOrLinkId(parsed.reference_id) || findByReferenceOrLinkId(parsed.payment_link_id);
  if (!draft) {
    recordEvent({
      actor: "checkout_agent",
      event_type: "webhook_orphaned",
      decision: "failed",
      reason: `Webhook ${eventId} reported ${parsed.payment_link_id} paid, but no order draft matches reference "${parsed.reference_id}". Acknowledged so Razorpay stops retrying; not treated as a payment.`,
      raw_context: parsed,
    });
    return res.json({ ok: true, handled: false });
  }

  // Amount check: the webhook must agree with what we asked for. A
  // payment for less than the order total is not a completed order.
  if (parsed.amount_paise != null && parsed.amount_paise !== draft.total_paise) {
    recordEvent({
      actor: "checkout_agent",
      mandate_id: draft.mandate_id,
      order_draft_id: draft.id,
      event_type: "webhook_amount_mismatch",
      decision: "failed",
      severity: "critical",
      reason: `Webhook reports ${formatPaise(parsed.amount_paise)} paid against order ${draft.id}, which was drafted at ${formatPaise(draft.total_paise)}. The order was NOT marked paid.`,
      raw_context: parsed,
    });
    return res.status(202).json({ ok: true, handled: false, reason: "amount_mismatch" });
  }

  await settlePayment({ order_draft_id: draft.id, payment_id: parsed.payment_id, source: "razorpay webhook" });
  if (eventId) seen("webhook", eventId);
  res.json({ ok: true, handled: true });
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(DASHBOARD_DIR));

/* ------------------------------------------------------------------ */
/*  Merchant Commerce MCP — where external AI buyers connect           */
/* ------------------------------------------------------------------ */
app.post("/mcp", handleMerchantMcpRequest);
// GET opens the server→client notification stream (this is how an
// elicitation prompt reaches the buyer); DELETE closes the session.
app.get("/mcp", handleMerchantMcpSessionRequest);
app.delete("/mcp", handleMerchantMcpSessionRequest);

/* ------------------------------------------------------------------ */
/*  Discovery                                                          */
/* ------------------------------------------------------------------ */
app.get("/.well-known/agent-keys", (_req, res) => res.json(publicKeyDirectory()));
app.get("/.well-known/merchant-profile", (_req, res) => res.json(merchantProfile()));

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "commerce-agent",
    demo_mode: isDemoMode(),
    rail: rail(),
    merchant_id: MERCHANT_ID,
    mcp_endpoint: "/mcp",
    external_agents_connected: mcpSessionCount(),
    chain: chainHead(),
  })
);

/* ------------------------------------------------------------------ */
/*  Mandates & ledger                                                  */
/* ------------------------------------------------------------------ */
app.get("/mandates", (_req, res) => {
  res.json(
    listIssued().map(({ mandate, token }) => ({
      mandate_id: mandate.mandate_id,
      label: mandate.label,
      issued_to: mandate.issued_to,
      constraints: mandate.constraints,
      expires_at: mandate.expires_at,
      signed_by: mandate.proof.key_id,
      token,
      balance: balance(mandate),
    }))
  );
});

/** The raw signed credential, for inspection on screen. */
app.get("/mandates/:id/credential", (req, res) => {
  const record = getIssued(req.params.id);
  if (!record) return res.status(404).json({ error: "unknown_mandate" });
  res.json({ mandate: record.mandate, token: record.token });
});

/**
 * The live tamper demo: take a real signed mandate, change the cap,
 * leave the signature untouched, and present it exactly as an attacker
 * would. Nothing here is special-cased — it goes through the same Gate
 * as every other order.
 */
app.post("/mandates/:id/tamper", async (req, res) => {
  const record = getIssued(req.params.id);
  if (!record) return res.status(404).json({ error: "unknown_mandate" });

  const forged = tamperWithMandate(record.mandate, {
    field: req.body?.field || "max_amount_paise",
    value: req.body?.value ?? 99999900,
  });

  const result = await draftOrder({
    mandate: forged,
    items: req.body?.items || [{ product_id: "sku-014", qty: 1 }],
    agent_id: AGENT_ID,
  });

  res.json({
    attempted: {
      original_cap_paise: record.mandate.constraints.max_amount_paise,
      forged_cap_paise: forged.constraints.max_amount_paise,
      signature_unchanged: forged.proof.signature === record.mandate.proof.signature,
    },
    result,
  });
});

app.get("/ledger", (_req, res) => res.json({ accounts: snapshot(), orders: listDrafts().map(summariseDraft) }));

function summariseDraft(d) {
  return {
    id: d.id,
    mandate_id: d.mandate_id,
    status: d.status,
    total_paise: d.total_paise,
    items: d.items.length,
    cart_id: d.cart_mandate?.cart_id || null,
    payment_mandate_id: d.payment_mandate?.payment_mandate_id || null,
    created_at: d.created_at,
  };
}

/* ------------------------------------------------------------------ */
/*  Chat                                                               */
/* ------------------------------------------------------------------ */
app.post("/session", (req, res) => {
  try {
    const { mandate_id, mandate_token } = req.body || {};
    const { sessionId, mandate } = startSession({ mandate_id, mandate_token });
    res.json({
      sessionId,
      mandate: {
        mandate_id: mandate.mandate_id,
        label: mandate.label,
        constraints: mandate.constraints,
        signed_by: mandate.proof.key_id,
      },
      memory: memory.recall(mandate.issued_to?.subject),
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/chat", async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || !message) return res.status(400).json({ error: "sessionId and message are required" });
  try {
    res.json(await runTurn(sessionId, message));
  } catch (err) {
    console.error("[commerce-agent] /chat error:", err);
    res.status(500).json({ error: "The shopper agent hit an internal error.", detail: String(err.message || err) });
  }
});

/* ------------------------------------------------------------------ */
/*  Checkout — plain HTTP twins of the agent's tools                   */
/* ------------------------------------------------------------------ */
app.post("/orders/draft", async (req, res) => {
  const { mandate_id, mandate_token, items } = req.body || {};
  const mandate = mandate_token ? decodeToken(mandate_token) : getIssued(mandate_id)?.mandate;
  if (!mandate) return res.status(400).json({ error: "a known mandate_id or a mandate_token is required" });
  if (!Array.isArray(items)) return res.status(400).json({ error: "items[] is required" });
  try {
    res.json(await draftOrder({ mandate, items, agent_id: AGENT_ID }));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

/**
 * A human pressing Confirm & Pay. This is the ONLY HTTP route that
 * passes human_confirmed — it exists because a real person clicked a
 * button describing a specific amount. The chat model reaches
 * confirmCheckout through a different path that cannot set it.
 */
app.post("/orders/:id/confirm", async (req, res) => {
  const { mandate_id, mandate_token, cart_mandate_token, accept_upsell, sessionId } = req.body || {};
  try {
    if (sessionId && getSession(sessionId)) {
      return res.json(await humanConfirm(sessionId, { order_draft_id: req.params.id, accept_upsell }));
    }
    const mandate = mandate_token ? decodeToken(mandate_token) : getIssued(mandate_id)?.mandate;
    if (!mandate) return res.status(400).json({ error: "a known mandate_id, mandate_token, or live sessionId is required" });
    res.json(
      await confirmCheckout({
        mandate,
        order_draft_id: req.params.id,
        // A caller may present the signed cart back to us. When they do,
        // that exact document is what gets verified — not the copy we
        // happen to have stored against the order.
        cart_mandate: cart_mandate_token ? decodeToken(cart_mandate_token) : null,
        accept_upsell: Boolean(accept_upsell),
        agent_id: AGENT_ID,
        human_confirmed: true,
      })
    );
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/orders/:id/abandon", (req, res) => {
  res.json(abandonCheckout(req.params.id, "Checkout abandoned before payment."));
});

app.post("/orders/:id/refund", async (req, res) => {
  try {
    res.json(await refundOrder({ order_draft_id: req.params.id, reason: req.body?.reason || "Requested by shopper." }));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get("/orders/:id", (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "unknown_order" });
  res.json(draft);
});

/* ------------------------------------------------------------------ */
/*  Audit ledger                                                       */
/* ------------------------------------------------------------------ */
app.get("/audit", (req, res) =>
  res.json(
    listEvents({
      mandate_id: req.query.mandate_id,
      since_seq: req.query.since ? Number(req.query.since) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    })
  )
);

/** Walk the hash chain. Edit the JSONL file and this reports exactly
 *  which event broke — the point of a ledger you can falsify. */
app.get("/audit/verify", (_req, res) => res.json(verifyChain()));

app.get("/audit/stream", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");
  const offAudit = onEvent((event) => res.write(`event: audit\ndata: ${JSON.stringify(event)}\n\n`));
  const offTrace = onTraceEvent((event) => res.write(`event: trace\ndata: ${JSON.stringify(event)}\n\n`));
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    offAudit();
    offTrace();
    clearInterval(heartbeat);
  });
});

app.get("/traces", (_req, res) => res.json(recentTraces(20)));
app.get("/metrics", (_req, res) => res.json({ ...metrics(), llm: llmUsage(), chain: chainHead(), demo_mode: isDemoMode() }));
app.get("/memory/:subject", (req, res) => res.json(memory.recall(req.params.subject)));

/* ------------------------------------------------------------------ */
/*  Payment surfaces                                                   */
/* ------------------------------------------------------------------ */
app.get("/demo-pay", (req, res) => {
  const { link_id, ref } = req.query;
  res.send(`<!doctype html><meta charset="utf-8"><title>Demo payment</title>
  <body style="font-family:system-ui;max-width:440px;margin:4rem auto;text-align:center;line-height:1.6;">
    <p style="color:#b8862b;font-weight:600;letter-spacing:.04em;">DEMO MODE — NO REAL PAYMENT</p>
    <h2 style="font-weight:600;">Confirm test payment</h2>
    <p style="color:#555;">Order ${escapeHtml(ref)}</p>
    <form method="get" action="/payment-callback">
      <input type="hidden" name="demo" value="1" />
      <input type="hidden" name="link_id" value="${escapeHtml(link_id)}" />
      <input type="hidden" name="ref" value="${escapeHtml(ref)}" />
      <button style="font-size:1rem;padding:.75rem 1.5rem;cursor:pointer;border-radius:6px;border:1px solid #333;background:#111;color:#fff;">Pay (simulated)</button>
    </form>
    <p style="color:#888;font-size:.85rem;margin-top:2rem;">The signature on this callback is generated and verified exactly as a real one is. Only the network call to Razorpay is skipped.</p>
  </body>`);
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

app.get("/payment-callback", async (req, res) => {
  const params =
    req.query.demo === "1"
      ? buildDemoCallback({ payment_link_id: req.query.link_id, reference_id: req.query.ref })
      : {
          razorpay_payment_id: req.query.razorpay_payment_id,
          razorpay_payment_link_id: req.query.razorpay_payment_link_id,
          razorpay_payment_link_reference_id: req.query.razorpay_payment_link_reference_id,
          razorpay_payment_link_status: req.query.razorpay_payment_link_status,
          razorpay_signature: req.query.razorpay_signature,
        };

  const valid = verifyPaymentLinkSignature({
    payment_link_id: params.razorpay_payment_link_id,
    payment_link_reference_id: params.razorpay_payment_link_reference_id,
    payment_link_status: params.razorpay_payment_link_status,
    payment_id: params.razorpay_payment_id,
    signature: params.razorpay_signature,
  });

  const draft =
    findByReferenceOrLinkId(params.razorpay_payment_link_reference_id) ||
    findByReferenceOrLinkId(params.razorpay_payment_link_id);

  if (!valid || !draft) {
    recordEvent({
      actor: "checkout_agent",
      order_draft_id: draft?.id || null,
      event_type: "payment_verification",
      decision: "failed",
      severity: "critical",
      reason: !valid
        ? "A payment callback arrived whose signature did not verify against the Razorpay key secret. Rejected as untrusted — anyone can construct this URL, only Razorpay can sign it."
        : `Payment callback verified, but no order draft matches reference "${params.razorpay_payment_link_reference_id}".`,
      raw_context: params,
    });
    return res.status(400).send("Payment verification failed.");
  }

  // Reloading this page replays a valid, correctly-signed callback.
  // settlePayment is idempotent, so the second arrival is recorded as a
  // recognised duplicate and revenue is counted exactly once.
  const settlement = await settlePayment({
    order_draft_id: draft.id,
    payment_id: params.razorpay_payment_id,
    source: "browser redirect",
  });

  res.send(`<!doctype html><meta charset="utf-8"><title>Payment complete</title>
  <body style="font-family:system-ui;max-width:460px;margin:4rem auto;text-align:center;line-height:1.6;">
    <h2 style="font-weight:600;">Payment verified ✓</h2>
    <p>Order ${escapeHtml(draft.id)} — ${escapeHtml(formatPaise(draft.total_paise))}</p>
    <p style="color:#666;font-size:.9rem;">Signature checked server-side before this page rendered.${
      settlement.replayed
        ? " This confirmation had already been processed; it was recognised as a replay and counted once."
        : ""
    }</p>
    <p style="color:#888;font-size:.82rem;">Try refreshing this page — the ledger will record a duplicate and the revenue figure will not move.</p>
    <p><a href="/">Back to the console</a></p>
  </body>`);
});

/* ------------------------------------------------------------------ */
/*  Demo controls — admin-only, never exposed as agent tools           */
/* ------------------------------------------------------------------ */
app.post("/debug/set-stock", async (req, res) => {
  const { product_id, qty } = req.body || {};
  res.json(await debugSetStock(product_id, qty));
});

/** Fire a correctly-signed webhook at ourselves, to rehearse the
 *  webhook path (and its duplicate handling) without Razorpay. */
app.post("/debug/replay-webhook", async (req, res) => {
  const draft = getDraft(req.body?.order_draft_id);
  if (!draft?.payment_link) return res.status(400).json({ error: "order has no payment link" });
  const { raw, signature, event_id } = buildDemoWebhook({
    payment_link_id: draft.payment_link.id,
    reference_id: draft.id,
    amount_paise: draft.total_paise,
  });
  const times = Math.min(3, Number(req.body?.times) || 1);
  const results = [];
  for (let i = 0; i < times; i++) {
    const response = await fetch(`http://localhost:${PORT}/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": event_id, // deliberately the same id each time
      },
      body: raw,
    });
    results.push(await response.json());
  }
  res.json({ delivered: times, results, note: "Same event id each time — Razorpay documents at-least-once delivery." });
});

app.post("/debug/reset-demo", async (_req, res) => {
  const { resetGrowth } = await import("./growth.js");
  const { resetOrders } = await import("./orders.js");
  const { resetIdempotency } = await import("./idempotency.js");
  const { resetTraces } = await import("./agent/trace.js");
  const { resetLedger: resetAudit } = await import("./audit.js");

  resetAudit();
  ledger.resetLedger();
  resetOrders();
  resetGrowth();
  resetIdempotency();
  resetTraces();
  issueSeedMandates();

  recordEvent({
    actor: "operator",
    event_type: "demo_reset",
    decision: "approved",
    reason: "Demo state was reset: audit chain truncated to genesis, ledger cleared, orders dropped, metrics zeroed and mandates reissued. Shopper memory was deliberately kept.",
  });
  res.json({ ok: true, chain: chainHead() });
});

// SPA fallback: the dashboard is hash-routed, so a browser hitting a
// deep path directly (no "#") should still get index.html and boot.
// All real API routes are already registered above; this only catches
// unmatched GETs that want HTML and aren't asset requests.
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.includes(".") || !req.accepts("html")) return next();
  res.sendFile(join(DASHBOARD_DIR, "index.html"));
});

const server = app.listen(PORT, HOST, () => {
  const shown = process.env.PUBLIC_BASE_URL;
  console.log(`\n[commerce-agent] listening on ${HOST}:${PORT}  (public: ${shown})`);
  console.log(`[commerce-agent] merchant MCP endpoint  →  ${shown}/mcp`);
  console.log(`[commerce-agent] public keys            →  ${shown}/.well-known/agent-keys`);
  console.log(`[commerce-agent] settlement rail        →  ${rail()}`);
  console.log(`[commerce-agent] catalog                →  ${EMBED_CATALOG ? "embedded (in-process, loopback)" : process.env.CATALOG_SERVER_URL}`);
  console.log(`[commerce-agent] audit chain head       →  seq ${chainHead().seq}`);
  console.log(`[commerce-agent] mandates issued        →  ${listIssued().map((m) => m.mandate.mandate_id).join(", ")}\n`);
});

// Graceful shutdown so a redeploy / SIGTERM closes SSE streams cleanly.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[commerce-agent] ${sig} — closing server`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
