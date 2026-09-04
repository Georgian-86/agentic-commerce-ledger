# Deploying the Agentic Commerce Ledger

## What this app needs from a host

It is **one long-running Node process** that:

- holds **Server-Sent Events** streams open (`/audit/stream` — the live
  ledger and the agent trace)
- keeps **in-memory session state** for connected MCP buyers (the
  human-in-the-loop elicitation is a request sent back mid-call)
- writes an append-only **hash-chained ledger** and generated **Ed25519
  keys** to disk
- runs a second Express app (the catalog MCP server) in-process

That rules out serverless / edge platforms — **Vercel, Netlify Functions,
Cloudflare Workers**. Their functions are stateless, time-boxed, and
can't hold an SSE connection or an in-memory session map across
invocations. Making it fit there would mean swapping SSE for polling,
moving sessions to Redis, and the ledger to Postgres — a rewrite that
makes the project worse for its actual purpose (a self-contained demo).

It wants a **persistent container / process host**. In order of fit:

| Host | Free tier | Persistence | Notes |
|---|---|---|---|
| **Fly.io** | yes (small) | volume | Best fit. Real VM, SSE fine, `fly launch` + `fly deploy`. Config: `fly.toml`. |
| **Render** | yes | paid only | One-click via `render.yaml` Blueprint. Free service sleeps after 15 min. |
| **Railway** | trial credit | volume | Auto-detects Node, `railway up`. |
| **Any VPS / Docker** | — | volume | `docker compose up -d`. Config: `Dockerfile`, `docker-compose.yml`. |

All four run the **same** thing: `node commerce-agent/src/index.js` with
`EMBED_CATALOG=true`.

---

## First: put it on GitHub

Render, Railway and Fly all deploy from a repo. The commit is already
made — add your remote and push:

```bash
git remote add origin https://github.com/<you>/agentic-bazaar.git
git push -u origin main
```

---

## Option A — Fly.io (recommended)

```bash
# once
curl -L https://fly.io/install.sh | sh      # or: brew install flyctl
fly auth login
fly launch --no-deploy --copy-config          # reads fly.toml; pick a unique app name
fly volume create ledger --size 1 --region sin

# secrets (never in the repo)
fly secrets set \
  LLM_API_KEY=gsk_xxx \
  RAZORPAY_KEY_ID=rzp_test_xxx \
  RAZORPAY_KEY_SECRET=xxx

fly deploy

# after the first deploy, tell it its own URL so Razorpay callbacks verify
fly secrets set PUBLIC_BASE_URL=https://<your-app>.fly.dev
```

Open `https://<your-app>.fly.dev`. It boots in **DEMO_MODE** (mocked
Razorpay, everything else real) so it works before you wire payments —
see "Going live with real Razorpay" below.

---

## Option B — Render (one click from the dashboard)

1. Push to GitHub (above).
2. Render → **New → Blueprint** → select the repo. It reads `render.yaml`.
3. It prompts for the `sync: false` secrets — paste:
   - `LLM_API_KEY` — your Groq key
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` — Razorpay test keys
   - `RAZORPAY_WEBHOOK_SECRET` — leave blank for now
4. **Apply**. Render builds (`npm install && npm run seed`) and starts it.
5. `PUBLIC_BASE_URL` is derived from Render's `RENDER_EXTERNAL_URL`
   automatically — nothing to set.

**Free plan:** delete the `disk:` block and the `ACL_DATA_DIR` var from
`render.yaml` first (free services can't mount a disk). The ledger then
resets on each deploy, which is what `npm run demo:reset` does anyway.
For persistence + always-on, set `plan: starter` and keep the disk.

---

## Option C — any box with Docker

```bash
cp .env.production.example .env      # fill in the 3 secrets + PUBLIC_BASE_URL
docker compose up -d --build
# → http://<host>:4200   (put a TLS reverse proxy in front for real payments)
```

The `ledger` named volume keeps `/data` (chain + keys + memory) across
restarts.

---

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `LLM_API_KEY` | for chat | Groq key (free, no card) — [console.groq.com](https://console.groq.com) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | for real payments | Test keys. Not needed while `DEMO_MODE=true`. |
| `PUBLIC_BASE_URL` | for real payments | Your deployed origin. Auto on Render/Railway; set it on Fly/VPS. |
| `RAZORPAY_WEBHOOK_SECRET` | for webhooks | From the Razorpay dashboard after you add the webhook. |
| `DEMO_MODE` | — | `true` (default here) mocks the Razorpay network call only. |
| `EMBED_CATALOG` | — | `true` (default) runs catalog in-process. `false` only if hosting it separately. |
| `ACL_DATA_DIR` | — | Point at a mounted volume to persist the ledger. Omit = ephemeral. |
| `CONFIRMATION_THRESHOLD_PAISE` | — | Unattended-spend ceiling, default `150000` (₹1,500). |
| `PORT` / `HOST` | — | Injected by most hosts. Defaults `4200` / `0.0.0.0`. |

---

## Going live with real Razorpay

1. Set `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` (test keys).
2. Confirm `PUBLIC_BASE_URL` is the real HTTPS origin.
3. Razorpay Dashboard → **Settings → Webhooks → Add**:
   - URL: `https://<your-origin>/webhooks/razorpay`
   - Active event: `payment_link.paid`
   - Copy the signing secret → set `RAZORPAY_WEBHOOK_SECRET`.
4. Set `DEMO_MODE=false` and redeploy.
5. Test: run a purchase in the console, pay with a
   [Razorpay test card](https://razorpay.com/docs/payments/payments/test-card-details/),
   watch `payment_verified` land in the ledger (redirect **and** webhook,
   both idempotent).

Keep `DEMO_MODE=true` for a rehearsal / booth demo — the free test API
rate-limits under repeated hammering, and the console shows a `DEMO MODE`
badge the whole time so a mocked call is never mistaken for a real one.

---

## Health & operations

- `GET /health` — liveness (used by every platform config here).
- `GET /audit/verify` — walk the hash chain from genesis.
- `POST /debug/reset-demo` — truncate the ledger, reissue mandates
  (shopper memory kept). **This is unauthenticated** — fine for a demo,
  but put the deploy behind an access control if it's long-lived.
- Logs print the resolved `PUBLIC_BASE_URL`, the settlement rail, and
  whether the catalog is embedded, on every boot.

---

## Why not just static-host the dashboard?

You can — it's plain files under `dashboard/`. But it's useless without
the backend (every panel reads a live endpoint, and the whole point is
the running trust layer). If you want a CDN-hosted frontend, host
`dashboard/` anywhere static and set `window.__API_BASE` to the deployed
API origin; CORS is already open. For a single deploy, the Express server
serving both is simpler and is what the configs above do.
