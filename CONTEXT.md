# Project context — read this first

This file lets a new chat session pick up work without re-discovering
everything. Keep it honest: when you change something structural (a new
file, a changed contract, a new gotcha), update this file in the same
sitting. A stale context file is worse than none.

## What this is

**Agentic Commerce Ledger** — Razorpay Buildathon Track 01, "AI Growth &
Agentic Commerce." A merchant any AI agent can transact with end to end,
under a user-signed spending mandate, over a hash-chained tamper-evident
ledger. Near-zero cost: Groq free tier, Razorpay test mode, no paid infra.

This is **v2**. v1 was a solid conversational checkout with an
HMAC-signed mandate and an append-only JSONL log. v2 rebuilt the trust
core and the agent layer — see "What changed from v1" at the bottom.

## Architecture

Two services:

- **`catalog-server/`** (:4100) — real MCP server (Streamable HTTP,
  JSON-RPC 2.0). 5 tools + `catalog://full` resource. No secrets.
  Plain `/debug/set-stock` route for the failure demo (never an MCP tool).
- **`commerce-agent/`** (:4200) — shopper agent + checkout engine +
  **merchant Commerce MCP endpoint** (`/mcp`, where external AI buyers
  connect) + ledger + serves `dashboard/`. Only service with secrets.

Data flow: shopper agent (or external MCP buyer) → catalog MCP tools to
browse → checkout engine (`checkout.js`) is the only path to money →
Razorpay test-mode payment link → hash-chained ledger → Trust Console
live over SSE.

## File-by-file (`commerce-agent/src/`)

- `canonical.js` — deterministic JSON serialisation + sha256. Everything
  signed or hash-chained goes through `canonicalJson()` / `hashObject()`.
- `keys.js` — Ed25519 keyrings for three roles: `user` (issues Intent
  Mandates), `merchant` (issues Cart/Payment Mandates, verifies Intent),
  `agent` (identity). Private keys in `data/keys.json` (gitignored),
  generated on first boot. `resolvePublicKey(kid)` is the trusted-issuer
  registry. `publicKeyDirectory()` served at `/.well-known/agent-keys`.
- `mandate.js` — the AP2-aligned chain. `issueIntentMandate` (user-signed),
  `issueCartMandate` (merchant-signed, freezes price 10 min, bound by
  hash to the intent), `issuePaymentMandate`. `verifyIntentMandate` /
  `verifyCartMandate` check *presented* credentials, not local copies.
  `encodeToken`/`decodeToken` → `acl_<b64url>` strings. `tamperWithMandate`
  powers the live tamper demo. Cart nonces are single-use
  (`spentCartNonces`) — consumed only at the point a payment proceeds,
  NOT on a needs_confirmation.
- `wallet.js` — **the one simulated piece**. In-process stand-in for the
  shopper's device wallet. `issueSeedMandates()` (clears + reissues the 3
  personas; called at boot and on reset), `issueForAgent()` (ad-hoc
  mandate for an external agent). `AGENT_ID = "shopper-agent-01"`.
- `gate.js` — `checkGate()`: verify credential → positive-integer amount
  → category scope → per-order limit → **available balance** (cap −
  settled − held) → unattended-spend threshold. Returns
  `approved`/`blocked`/`needs_confirmation` with a specific reason string.
  A mandate may *tighten* the threshold, never loosen it.
- `ledger.js` — `reserve` (hold) → `commit` (hold→spend) → `release`
  (hold→available) → `reverse` (refund). All idempotent by order id.
  Holds auto-expire after 15 min (`setExpiryHandler` writes an audit
  event). `balance(mandate)` = {cap, held, spent, available}.
- `audit.js` — hash-chained log. Each event: `seq`, `prev_hash`, `hash`
  (sha256 of canonical body). `verifyChain()` walks from genesis, returns
  `broken_at` seq. `resetLedger()` truncates (demo only). SSE-broadcast
  via EventEmitter.
- `idempotency.js` — `once(scope, key, fn, shouldCache?)`. `shouldCache`
  matters: confirm only caches `awaiting_payment`/`paid`, so an approved
  retry after a needs_confirmation actually re-runs.
- `checkout.js` — `draftOrder` / `confirmCheckout` / `settlePayment` /
  `abandonCheckout` / `refundOrder`. The single money chokepoint. Cart
  nonce consumed once, right before `ledger.reserve`. `human_confirmed`
  flows in only from `humanConfirm` (dashboard button) or the MCP
  elicitation path — never from the model.
- `razorpay.js` — only file touching Razorpay. `createPaymentLink`,
  `createRefund`, `verifyPaymentLinkSignature` (redirect callback),
  `verifyWebhookSignature` (raw body, constant-time), `parsePaymentLinkWebhook`,
  `buildDemoCallback` / `buildDemoWebhook`. `DEMO_MODE` mocks only the
  network call.
- `merchantProfile.js` — machine-readable "how to transact with me",
  including `refuses[]`. Served at `/.well-known/merchant-profile` and as
  the `get_merchant_profile` MCP tool.
- `merchantMcp.js` — the external-buyer MCP server. **Stateful** transport
  (session map, `mcp-session-id` header) — required because elicitation
  is a server→client request answered in a separate HTTP call, so a
  per-request server has no memory of it. Tools: `get_merchant_profile`,
  `request_mandate`, `search_products`, `get_product`, `get_policies`,
  `check_mandate_balance`, `draft_order`, `confirm_checkout`,
  `get_order_status`. `DRAFT_OUTPUT_SCHEMA` / `CONFIRM_OUTPUT_SCHEMA` must
  list every field on every branch or the SDK rejects the tool's own
  output. `out()` strips `undefined` before it hits `structuredContent`.
- `growth.js` — P&L: `settled_gmv_paise` (on verified payment only),
  upsell `uplift_pct` (with sample note), `refused_spend_paise` (Gate
  blocks), conversion. `bestUpsell` = `margin_pct + 10`, rationale
  attached.
- `agent/trace.js` — span tracing. `startTrace()` → `.span(name,{type})`
  → `.end()`. Types: reason/model/tool/reflect/step. SSE-broadcast as
  `trace` events; dashboard renders a waterfall.
- `agent/planner.js` — `makePlan()` classifies the turn into an intent
  (`browse`/`draft`/`purchase`/`support`/`smalltalk`). `toolsForIntent()`
  is enforced — a tool absent from the intent's list is never offered to
  the model AND is refused if the model somehow names it. Deterministic
  keyword fallback if the planning LLM call fails.
- `agent/critic.js` — `createCritic()`. `.observe(tool, result)` learns
  real prices/SKUs and scans for injection strings. `.review(reply)`
  blocks ungrounded ₹ figures / SKU ids, checks a block's reason is
  relayed, flags Markdown. A block → one correction round trip.
- `agent/memory.js` — episodic memory keyed on mandate `issued_to.subject`,
  persisted to `data/memory.json`. Facts are *derived deterministically*
  from events (price ceilings, category interest, purchases, walk-aways,
  budget hits), never model-summarised. Each fact carries its evidence.
  Kept across demo resets on purpose.
- `agent/policy.js` — buyer-side rules (`min_return_window_days`,
  `require_signed_cart`, …) checked against the merchant's declared
  policy. `check_merchant_policy` tool.
- `shopperAgent.js` — the orchestrator. Per turn: PLAN (classify, gate
  tools) → ACT (tool loop, budgets: 6 steps, 10 tool calls) → OBSERVE
  (critic sees every result) → REFLECT (grounding check, 1 correction).
  `runTurn` returns `{reply, plan, critique, draft, confirmation,
  trace_id, trace, policy, memory, termination}`. `humanConfirm()` is the
  only place `human_confirmed: true` is set.
- `index.js` — Express. Loads root `.env` by absolute path (see gotcha
  #1). `/webhooks/razorpay` mounted with `express.raw()` **before**
  `express.json()`. `/mcp` POST + GET + DELETE. `/mandates/:id/tamper`,
  `/audit/verify`, `/debug/reset-demo`, `/debug/replay-webhook`.

## Current state

Fully built and verified against real Razorpay test-mode credentials and
a real Groq key. All three test suites pass:
- `test:trust` — 21 checks (mandate credentials, the Gate, hold/capture
  ledger, webhooks, hash chain, graceful failure).
- `test:buyer` — 15 checks (a real separate MCP client buys end to end,
  including the human-in-the-loop elicitation both accepting and
  declining).
- `test:e2e` — 3 scenarios (within-budget completes, over-budget blocked,
  stock-out graceful).

The dashboard is now a **multi-view vanilla-JS app** under `dashboard/`
(shell `index.html` + `css/` + `js/`), not a single file. Hash router,
5 views (landing / console / ledger / mandates / agents), a first-run
intro modal + skippable guided spotlight tour, hand-rolled 3D hash-chain
canvas, modals / toasts / skeletons / page transitions, dark+light theme.
Zero runtime dependencies still. Old single-file version kept at
`dashboard/_legacy-index.html.bak`. See [[project-dashboard-rebuild]] for
the file map and rendering gotchas (the big one: `.shell` is the scroll
container, not the document). Verified in-browser end to end: session →
plan card → trace waterfall → cart → confirm → hold on the balance strip;
ledger verify + break modal; mandate tamper demo; onboarding + tour.

Real secrets live in `.env` on the user's machine (Groq key, Razorpay
test Key ID + Secret). **Never echo these into chat or this file.**
`data/keys.json` holds real Ed25519 private keys — gitignored,
regenerated if absent.

Not built (documented future work): the campaign orchestrator (P5 stretch
goal). Everything else in the original build plan is done or superseded.

## Known gotchas

1. **`.env` loading.** `index.js` does NOT use `import "dotenv/config"`.
   `npm run dev -w commerce-agent` sets cwd to `commerce-agent/`, so a
   bare dotenv import finds nothing and every secret is `undefined` with
   no error. Fix in place: resolve `.env` path from `import.meta.url`,
   call `loadEnv()` as a function, then `await import(...)` every sibling
   that reads `process.env` at its top level. Don't "clean this up" to a
   plain top-level import — static imports are hoisted above it.
2. **Groq model drift + free-tier rate limits.** Hosted model catalogues
   change (`llama-3.3-70b-versatile` was retired mid-v1). `llmClient.js`
   now has a fallback chain (`LLM_FALLBACK_MODELS`), retry-with-backoff on
   429/5xx, and a 30s timeout. Repeated test runs WILL hit Groq's free
   rate limit — run `DEMO_MODE=true` for those; it only mocks the
   Razorpay network call, not the LLM. If chat degrades to "couldn't
   reach my reasoning model", that's the rate limiter, not a bug — the
   draft/tool result is still in the response.
3. **Webhook signature is over the RAW body.** `/webhooks/razorpay` uses
   `express.raw()` and is mounted before `express.json()`. Parsing first
   changes the bytes and every signature fails. Don't reorder.
4. **The merchant MCP transport is stateful, on purpose.** Elicitation is
   a server→client request whose answer arrives as a separate HTTP call.
   A per-request server (like catalog-server's stateless pattern) has no
   memory of the question. `merchantMcp.js` keeps a session map keyed on
   `mcp-session-id`.
5. **MCP `outputSchema` is enforced against your own tool's output.** An
   incomplete schema *breaks* the tool (`-32602`), it doesn't just
   under-document it. `DRAFT_OUTPUT_SCHEMA` / `CONFIRM_OUTPUT_SCHEMA`
   list every field on every branch. `out()` strips `undefined` keys.
6. **Cart nonce timing.** A Cart Mandate's single-use nonce is consumed
   only immediately before `ledger.reserve` — NOT during the cart's
   validity check. Consume it on the check and a `needs_confirmation`
   burns it, so the human-approved retry fails as `cart_replayed`.
7. **`issueSeedMandates` clears first.** It's called at boot and on every
   `/debug/reset-demo`. Without the `issued.clear()` it stacks duplicate
   persona mandates and the dashboard picker fills with stale entries.
8. **Idempotency `shouldCache`.** `confirmCheckout` only caches terminal
   outcomes (`awaiting_payment`/`paid`). Caching `needs_confirmation`
   means the approved retry gets handed the stale refusal forever.
9. **Sandboxed shell:** prefer `Stop-Process -Name node` / port-scoped
   kills over `pkill -f`.

## Environment (`.env`, project root — never commit, never paste to chat)

```
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=<groq key>
LLM_MODEL=openai/gpt-oss-120b
LLM_FALLBACK_MODELS=llama-3.3-70b-versatile,llama-3.1-8b-instant
RAZORPAY_KEY_ID=<razorpay test key id>
RAZORPAY_KEY_SECRET=<razorpay test key secret>
RAZORPAY_WEBHOOK_SECRET=<optional; set when you configure a dashboard webhook>
CONFIRMATION_THRESHOLD_PAISE=150000
CATALOG_SERVER_PORT=4100
COMMERCE_AGENT_PORT=4200
CATALOG_SERVER_URL=http://localhost:4100/mcp
PUBLIC_BASE_URL=http://localhost:4200
DEMO_MODE=false
```

## Running it

```
npm install
npm run dev                        # :4100 + :4200
npm run test:all                   # 2nd terminal (use DEMO_MODE=true for repeats)
npm run demo:reset                 # clean feed before a demo (keeps keys + memory)
npm run verify:ledger              # chain check from disk, no server
```

Open http://localhost:4200.

## Prompt to paste into a new chat session

---

I'm continuing work on the Agentic Commerce Ledger (v2), a Razorpay
Buildathon submission. Before anything else:

1. Read `CONTEXT.md` at the project root in full.
2. Skim the real source under `commerce-agent/src/` (especially
   `checkout.js`, `mandate.js`, `gate.js`, `ledger.js`, `merchantMcp.js`,
   `shopperAgent.js`) to confirm this map still matches. Code is the
   source of truth.
3. Don't assume anything not stated here or verifiable in the code. If
   CONTEXT.md looks stale, say so before proceeding.
4. Never echo real `.env` values or `data/keys.json` into chat.
5. For repeated test runs, use `DEMO_MODE=true` — Groq's free tier
   rate-limits and Razorpay test mode does too.

Then: [describe the task]

---

## What changed from v1

v1 was already good — real MCP, real signature verification, a gate in
code. v2 addressed what a payments judge would actually poke at, and
rebuilt the agent from a chat loop into a plan/act/observe/reflect agent.

**Trust core**
- Mandate went from a single server-side HMAC (merchant signing its own
  permission slip) to an **Ed25519 detached credential signed by a
  separate `user` key** the merchant verifies but can't mint. Added the
  AP2-style **Cart** and **Payment** mandates. Live tamper demo.
- Audit log went from plain JSONL to a **hash chain** with
  `GET /audit/verify` and a from-disk verifier.
- Money path went from decrement-on-intent to **authorisation
  hold → capture**, with idempotent confirm / callback / webhook and
  hold release on abandon/expiry/failure. Fixed: replayable callback,
  non-idempotent confirm, permanently-consumed budget on abandon.
- Added the **Razorpay webhook** path (raw-body signature, event-id
  dedupe, amount check) alongside the redirect callback.
- Added **refunds** (`refundOrder`, reverses the ledger).

**Agent layer**
- **Planner**: every turn is classified into an intent that *gates the
  tool surface* — enforcement, not a prompt hint.
- **Critic**: deterministic grounding check on every reply; an invented
  price is bounced back to the model once, and logged.
- **Trace**: span tracing for the whole loop, streamed to a live
  waterfall in the console.
- **Memory**: episodic, cross-session, derived deterministically from
  events (not model-summarised), each fact carrying its evidence.
- **Buyer-side policy**: the buyer checks the merchant against its own
  rules before committing — two-way negotiation, not a one-way feed.

**Making the track's actual claim true**
- **`/mcp` merchant endpoint**: external AI buyers (Claude Desktop, MCP
  Inspector, any client) transact end to end. `test:buyer` is a real
  separate MCP client proving it.
- **MCP elicitation**: above the threshold the merchant asks the buyer's
  *human* for approval, across the trust boundary. Degrades closed.
- **Planted prompt injection** in the seed catalog, defeated three ways.

**Metrics** reframed from one soft uplift % to a merchant P&L: settled
GMV, upsell uplift (with n), and refused spend.
