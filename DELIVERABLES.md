# Deliverables — what "done" means

The fixed list of what this project must ship. Every session reads this
before starting work and checks its change against it before finishing.
If a change would break any line here, stop and say so. Don't quietly
trade one deliverable for another.

Status key: ✅ shipped · 🟡 shipped, still being polished · ⬜ not built

## 1. The submission (Razorpay Buildathon, Track 01: AI Growth & Agentic Commerce)

| # | Deliverable | Status | Proof |
|---|---|---|---|
| D1 | **Transactable by an AI buyer.** Any external MCP client can discover the merchant, get a mandate, draft, and pay at `/mcp`. It shares no code with the merchant. | ✅ | `npm run test:buyer` (15 checks) |
| D2 | **Grows merchant revenue.** Upsell with rationale, settled GMV, uplift %, conversion and refused spend, all shown in the console. | ✅ | `growth.js`, Landing stat tiles |
| D3 | **Signed spending mandate.** An AP2-aligned Intent → Cart → Payment chain, Ed25519. The user signs; the merchant verifies but can never mint. | ✅ | `test:trust`, the live tamper demo on Mandates |
| D4 | **Gate in code, not in the prompt.** Checks category, per-order limit, available balance, and the unattended threshold. Every refusal carries a specific reason. | ✅ | `gate.js`, `test:e2e` over-budget scenario |
| D5 | **Human-in-the-loop above threshold.** An MCP elicitation goes to the buyer's human. A client without elicitation support is refused. | ✅ | `test:buyer` accept + decline |
| D6 | **Hash-chained, tamper-evident ledger.** `/audit/verify` names the exact broken record. | ✅ | `npm run verify:ledger`, Ledger view "break it" |
| D7 | **Money path is hold → capture.** Idempotent confirm, replay-safe callbacks and webhooks, holds released on abandon. | ✅ | `test:trust` |
| D8 | **Real Razorpay test-mode payments,** webhook included. `DEMO_MODE` mocks only the network call and is always badged. | ✅ | Live deployment |
| D9 | **Near-zero cost.** Groq free tier or Ollama, Razorpay test mode, no paid infra, no DB. | ✅ | README cost table |
| D10 | **Live deployment** at <https://agentic-bazaar.onrender.com> (single process, embedded catalog). | ✅ | DEPLOY.md |
| D11 | Campaign orchestrator (stretch goal P5). | ⬜ | Documented future work, not required |

## 2. The Trust Console (`dashboard/`), the part judges see

| # | Deliverable | Status |
|---|---|---|
| U1 | **Landing** (`#/`): what it is in one screen, live stats, animated hash-chain, a path into the console and the tour. | 🟡 |
| U2 | **Console** (`#/console`): chat with the shopper agent; see the plan card, trace waterfall, cart, confirm, and the hold on the balance strip. | 🟡 |
| U3 | **Ledger** (`#/ledger`): live feed over SSE, verify the chain, break it and see it caught. | 🟡 |
| U4 | **Mandates** (`#/mandates`): inspect a credential, see its balance, tamper and present it live. | 🟡 |
| U5 | **Agents** (`#/agents`): external MCP buyers and the human-in-the-loop approvals. | 🟡 |
| U6 | First-run intro, plus a guided tour that can be skipped and replayed. | ✅ |
| U7 | Dark **and** light theme, both first-class. | 🟡 |
| U8 | Works at **390 px mobile** and **1440 px desktop** with no clipped content. | 🟡 (see ITERATION_LOG) |
| U9 | **Zero runtime dependencies**: vanilla JS, no framework, no build step. | ✅ |
| U10 | Honest states: an empty ledger looks intentionally empty, `DEMO MODE` is always badged, and nothing is faked. | ✅ |

## 3. Non-negotiables (never trade these away for polish)

1. **All three test suites pass**: `npm run test:all` with the server up and `DEMO_MODE=true`.
2. **A design change never touches the trust core.** `commerce-agent/src/{checkout,mandate,gate,ledger,audit,razorpay,keys,canonical,idempotency}.js` stay out of UI work.
3. **No mock passes as real.** The DEMO MODE badge stays visible, and numbers on screen come from the server.
4. **Never commit secrets.** No `.env`, no `data/keys.json`, no real keys in docs, logs or screenshots.
5. **Keep CONTEXT.md in step with the code** whenever something structural changes.
