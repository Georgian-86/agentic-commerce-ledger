# Agentic Commerce Ledger

**Razorpay Buildathon · Track 01 — AI Growth & Agentic Commerce**

**Live: [agentic-bazaar.onrender.com](https://agentic-bazaar.onrender.com)** —
deployed on Render, running real Razorpay **test-mode** payments end to
end (webhook included). Free plan: sleeps after 15 min idle, so the first
load can take ~30s to wake; the ledger and keys are ephemeral and reset
on redeploy, so a fresh visit always opens on a clean, honest empty state.

A merchant that any AI agent can transact with, end to end, without a human
in the loop for small purchases and *with* one for large ones — held to a
signed spending mandate the merchant can verify but never mint, over a
tamper-evident ledger anyone can check.

The track asks for two things: grow a merchant's revenue, and make the
merchant transactable by an AI buyer. This does both, around one idea:

> **Mandate → Gate → Ledger.** An agent never holds unbounded spending
> power. It holds a scoped, *user-signed* credential. Every purchase is
> checked against that credential by server-side code no prompt can talk
> around. Every decision is written to a hash-chained ledger in plain
> English, live, in front of the judge.

---

## What makes this more than a chatbot with a checkout button

| | This build |
|---|---|
| **The AI buyer** | An external MCP client — Claude Desktop, the MCP Inspector, another team's agent — connects to `/mcp` and buys. It shares no code with the merchant. `commerce-agent/test/external-buyer.js` is exactly this: a separate MCP client that discovers the merchant, gets a mandate, and pays. |
| **The mandate** | A detached, presentable credential (AP2-aligned Intent → Cart → Payment chain), signed **Ed25519 by the shopper's wallet key**, not by the merchant. Change one digit of the cap and the Gate rejects it — there's a button in the console that does this live. |
| **Human-in-the-loop** | Above the unattended-spend threshold, the merchant sends an **MCP elicitation** back to the buyer's client and blocks. The buyer's *human* approves in their own UI. An agent cannot self-approve past it, and a client with no elicitation support is refused, not waved through. |
| **The agent loop** | Every turn is **plan → act → observe → reflect**. The plan is shown before execution and its classified intent *gates the tool surface* — a "browse" turn physically cannot call `confirm_checkout`. A deterministic **grounding critic** checks every reply against real tool results and bounces any invented price back to the model. |
| **The ledger** | Hash-chained. `GET /audit/verify` walks it from genesis and names the exact record that broke. Edit one character of `data/audit-log.jsonl` and refresh — it catches it. |
| **The money path** | Authorisation **hold → capture**, not decrement-on-intent. Retried `confirm_checkout` returns the original link (idempotent). Replayed payment callbacks and duplicate webhooks are recognised, not double-counted. Abandoned checkouts release their hold. |
| **Buyer-side policy** | The buyer carries its *own* rules (min return window, "only signed carts") and checks them against the merchant's declared policy before committing. Two parties with policy, reaching agreement — not a one-way feed. |
| **Adversarial input** | A product in the seed catalog carries a prompt injection in its description. It does nothing: the agent treats catalog text as data, the critic flags it, and the Gate enforces limits in code that never reads a description. |

---

## Cost: ~₹0

| Piece | Used | Cost |
|---|---|---|
| LLM (agent brain) | [Groq](https://console.groq.com) free API, open-weight models | **Free**, no card |
| LLM (offline alt) | [Ollama](https://ollama.com), local | **Free** |
| Payments | Razorpay **test mode** | **Free** |
| MCP, backend | `@modelcontextprotocol/sdk`, Express, Node | **Free / OSS** |
| Signing | Ed25519 via Node `crypto` | **Free**, built in |
| Voice | Browser Web Speech API | **Free** |
| Ledger | Hash-chained JSON-lines file | **Free**, no DB |

Razorpay is the one non-open piece — unavoidable, since its rails are what
the track builds on. Test mode is free without limit.

---

## Architecture

```
        In-app shopper                 External AI buyer
        (dashboard chat)               (Claude Desktop, Inspector, …)
              │                                │
              │  plan→act→observe→reflect      │  MCP: request_mandate,
              ▼                                ▼        draft_order, confirm_checkout
        Shopper Agent  ──MCP tools──►  Catalog & Policy MCP Server  (:4100)
              │                                │
              │        ┌───────────────────────┘
              ▼        ▼
        ┌─────────────────────────────────────────────┐
        │  CHECKOUT ENGINE  (the only path to money)   │
        │                                             │
        │  verify Intent Mandate (Ed25519, user key)  │
        │  → Gate: category · per-order · available    │
        │    balance · unattended-spend threshold     │
        │  → issue merchant-signed Cart Mandate        │
        │  → ledger HOLD  (not spend)                  │
        │  → Razorpay test-mode payment link           │
        │  → issue Payment Mandate                      │
        │  → on verified payment: HOLD → SPEND          │
        └─────────────────────────────────────────────┘
              │                          │
              ▼                          ▼
        Razorpay Test API      Hash-chained Ledger ──► Trust Console (SSE, live)
        (redirect + webhook,
         both signature-verified,
         both idempotent)
```

Two services, logically:

- **`catalog-server/`** (:4100) — a real MCP server (Streamable HTTP,
  JSON-RPC 2.0). `search_products`, `get_product`, `check_inventory`,
  `get_policies`, `get_related_products`, plus a `catalog://full`
  resource. No secrets.
- **`commerce-agent/`** (:4200) — the shopper agent, the checkout engine,
  the **merchant Commerce MCP endpoint** external buyers connect to, the
  ledger, and the dashboard as static files. The only service with
  secrets.

**Two ways they run.** `npm run dev` starts them as two processes on
`:4100` / `:4200` — closest to how a real merchant and a real catalog
provider would actually be separate. The live deployment above (and
every host config in [DEPLOY.md](DEPLOY.md)) runs **one process**
instead: `commerce-agent` boots `catalog-server` in-process on a
loopback port at startup (`EMBED_CATALOG=true`, the default) so a
free-tier host only has to keep one service alive. The shopper agent
still reaches the catalog only over MCP-over-HTTP either way — embedding
changes the process topology, not the protocol boundary. Set
`EMBED_CATALOG=false` plus a `CATALOG_SERVER_URL` to split them apart
again on any host.

---

## Setup

Don't want to install anything first? →
**[Try the live demo](https://agentic-bazaar.onrender.com)** — same
code, real Razorpay test-mode payments (see the cold-start note above).

To run it yourself, requires Node 18+.

```bash
npm install
npm run seed                 # regenerate seed/catalog.json (committed; optional)
cp .env.example .env          # fill in LLM_API_KEY and Razorpay test keys
npm run dev                   # catalog-server :4100 + commerce-agent :4200
```

Open **http://localhost:4200** — the Trust Console. A first visit runs a
short intro + an optional guided tour (skippable; replay it any time from
**Tour** in the top bar).

The console is a multi-view app — **Landing** (what it is, live stats,
animated ledger), **Console** (talk to the agent, watch it plan/act/reflect),
**Ledger** (verify the hash chain, or break it), **Mandates** (inspect a
credential, tamper with it live), **Agents** (external MCP buyers,
human-in-the-loop). All vanilla JS, zero runtime dependencies.

Two free keys:
- **Groq**: console.groq.com → API key → `LLM_API_KEY`.
- **Razorpay test**: Dashboard → Account & Settings → API Keys → Generate
  Test Key → `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.

No real keys yet? Leave `DEMO_MODE=true`. Razorpay network calls are
mocked with the same response shape; **signature verification, gating,
ledger holds and audit writes all still run for real**, and the console
shows a `DEMO MODE` badge the whole time so a mock is never passed off as
real. Repeated testing should run in demo mode — the real test API
rate-limits.

---

## Verifying it works

Three suites, all against a running server, none needing the LLM.
For repeated runs, start the server with `DEMO_MODE=true`.

```bash
npm run test:trust      # 21 checks — the properties that protect money
npm run test:buyer      # 15 checks — an external MCP client buys end to end
npm run test:e2e        # 3 scenarios — the original build-plan smoke test
npm run test:all        # all of the above
```

`test:trust` covers, among others: a tampered mandate is rejected and
never priced; budget is *held* not spent until payment; a retried confirm
mints no second link and holds no extra budget; a replayed payment
callback moves no revenue; a signed cart cannot be checked out twice; an
unsigned webhook is rejected without being parsed; a duplicate webhook
settles one order; the hash chain verifies from genesis; every event
carries a specific reason.

`npm run verify:ledger` checks the chain from disk without the server —
edit a byte of `commerce-agent/data/audit-log.jsonl` and run it.

---

## Connecting your own AI buyer

The merchant speaks MCP. Point any client at `http://localhost:4200/mcp` —
or skip local setup entirely and point it at the live deployment,
`https://agentic-bazaar.onrender.com/mcp`:

```bash
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP   URL: http://localhost:4200/mcp
#                          (or) https://agentic-bazaar.onrender.com/mcp
```

Flow: `get_merchant_profile` → `request_mandate` (returns a signed token) →
`search_products` → `draft_order` (returns a merchant-signed cart) →
`confirm_checkout`. Above the threshold you'll get an elicitation prompt
to approve. Tools carry honest `readOnlyHint` / `idempotentHint`
annotations.

---

## The mandate chain — how far it goes, said plainly

Modelled on AP2's Intent → Cart → Payment mandate chain:

- **Intent Mandate** — signed by the **user** key. "This agent may spend
  ₹X, in these categories, until T." The merchant verifies it; it cannot
  mint one.
- **Cart Mandate** — signed by the **merchant** key. Freezes an exact
  basket at an exact price for 10 minutes, bound by hash to the Intent
  Mandate it was priced against.
- **Payment Mandate** — signed by the merchant. Binds both hashes to the
  Razorpay payment reference. The non-repudiable settlement record.

Deviations from AP2, not hidden:
- **Ed25519** instead of ECDSA P-256 — equivalent strength, isolated to
  `keys.js` (one-line swap).
- **JSON + detached signature** instead of full W3C Verifiable
  Credential / JSON-LD framing.
- The user's wallet is **simulated in-process** (`wallet.js`) rather than
  a separate device with a hardware key. The *signing role* is genuinely
  separate — mandates are signed with a key the merchant doesn't hold and
  verified against its public half — but the *device* is not. Delete
  `wallet.js` and you lose the ability to issue mandates, not the ability
  to verify them.

The relevant standards — Google's **AP2**, and India's **NPCI Unified
Agent Protocol**, both under active development in 2025–26 — converge on
exactly this shape: register an agent, verify it's authorised, bound its
authority, keep an accountable trail. This is a hackathon-scale, honest
implementation of that shape on Razorpay's rails.

---

## Project layout

```
seed/                       deterministic 21-SKU catalog (one is a planted
                            injection), 3 persona mandates, policies
catalog-server/src/         MCP server — the agent-readable catalog
commerce-agent/src/
  canonical.js               deterministic JSON + hashing (JCS-style)
  keys.js                    Ed25519 keyrings: user / merchant / agent roles
  mandate.js                 Intent / Cart / Payment mandate chain + tamper helper
  wallet.js                  simulated shopper wallet — mints Intent Mandates
  gate.js                    the bounded-and-gated decision, as code
  ledger.js                  authorisation hold → capture → release
  audit.js                   hash-chained tamper-evident event log
  idempotency.js             once-per-key for confirm / callback / webhook
  checkout.js                the single chokepoint for money
  razorpay.js                the only file that talks to Razorpay
  merchantProfile.js         machine-readable "how to transact with me"
  merchantMcp.js             the MCP endpoint external AI buyers connect to
  growth.js                  P&L: settled GMV, upsell uplift, refused spend
  agent/
    trace.js                 span tracing for the plan/act/observe/reflect loop
    planner.js               intent classification → tool-surface gating
    critic.js                deterministic grounding + injection check
    memory.js                episodic memory, derived not summarised
    policy.js                buyer-side rules checked against the merchant
  shopperAgent.js            the four-stage agent orchestrator
  index.js                   Express: routes, SSE, webhook, payment callback
  test/trust.js              21-check trust-core suite
  test/external-buyer.js     15-check real-MCP-client suite
  test/e2e.js                3-scenario smoke test
dashboard/
  index.html                 app shell (nav, boot loader)
  css/                       tokens (dark + light), base, components, views
  js/app.js                  bootstrap: router, SSE, first-run onboarding
  js/router.js               hash router, lazy views, crossfade
  js/store.js  js/sse.js  js/api.js
  js/ui/                     h() dom helper, icons, toast, modal, skeleton, tour
  js/gl/chain3d.js           hand-rolled 3D hash-chain (canvas, no library)
  js/onboarding.js           intro modal + guided spotlight tour
  js/views/                  landing, console, ledger, mandates, agents
  _legacy-index.html.bak     the previous single-file dashboard
scripts/reset-demo.js        clean, honest empty state (keeps keys + memory)
scripts/verify-ledger.js     chain verification from disk, no server
```

---

## Demo runbook (3–4 min)

1. **Frame** (20s) — "Agent-to-agent commerce is the open problem of the
   year. Here's a merchant an AI agent can buy from safely, and prove it
   afterwards."
2. **Live purchase** (75s) — In the console, talk to the shopper agent:
   *"buy me the mini candle duo."* Point at the **trace panel**: plan,
   tool calls, grounding check — the real execution. Confirm & pay. Point
   at the **mandate panel**: ₹899 moves to *On hold*, not *Spent*.
3. **External buyer** (45s) — Split-screen the MCP Inspector (or run
   `npm run test:buyer`). *"This client shares no code with the merchant.
   It gets a signed mandate and buys. Same Gate, same ledger."* When the
   large order fires, show the **elicitation prompt** — the merchant
   asking the buyer's human.
4. **Break it, live** (45s) — Click **Tamper & present it**. Cap jumps to
   ₹9,99,999, signature untouched → **BLOCKED** in the feed. Then open
   `audit-log.jsonl`, change one word in a `reason`, hit **Verify chain**
   → it names the exact broken record.
5. **Close on the numbers** (30s) — The P&L: settled GMV, upsell uplift
   (with its n stated), and **refused spend** — "money we deliberately
   did not move." Architecture diagram while taking questions.

Record a full backup run the night before. `npm run demo:reset` gives a
clean feed so the console never opens showing yesterday's events.
