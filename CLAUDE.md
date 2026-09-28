# CLAUDE.md — read me first, every session

Agentic Commerce Ledger ("Agentic Bazaar") is a Razorpay Buildathon
Track 01 entry: a merchant any AI agent can buy from, held to a
user-signed mandate and a hash-chained ledger. It is live at
<https://agentic-bazaar.onrender.com>.

## Required reading, in order

1. **[DELIVERABLES.md](DELIVERABLES.md)**: what must ship and what must
   never break. Check your change against it before you finish.
2. **[CONTEXT.md](CONTEXT.md)**: architecture, the file-by-file map,
   and known gotchas. The code is the source of truth; if this file is
   stale, say so.
3. **[DESIGN.md](DESIGN.md)**: the design contract for `dashboard/`
   (tokens, rules, the quality bar, the north star).
4. For any UI or design work: **[docs/design/ITERATION_LOOP.md](docs/design/ITERATION_LOOP.md)**
   and the **latest entry** in **[docs/design/ITERATION_LOG.md](docs/design/ITERATION_LOG.md)**.

## How to work on the UI: always iterate, never one-shot

Every UI change runs the loop in `ITERATION_LOOP.md`:

**load → see (screenshots) → test → critique as a 10-year senior
designer → plan ≤5 fixes → build → verify (before/after + re-score) →
log → commit.**

- Start from the previous entry's "Next iteration" list. Open items
  are done or carried over with a reason; they're never silently
  dropped.
- Only claim a fix is done when a screenshot shows it. The score must
  go up each iteration, and no dimension may regress without an
  explanation.
- Screenshots: `npm run shots -- --out iter-NN` with the server running.
  In the cloud sandbox, prefix it with
  `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium SHOTS_IGNORE_HTTPS_ERRORS=1`.
- Use the `frontend-design` skill for visual direction and the
  `superpowers` skills for planning and verification.

## Commands

```bash
npm install
DEMO_MODE=true npm run dev     # :4100 catalog + :4200 app (or `npm start` for one process)
npm run test:all               # trust (21) + e2e (3) + buyer (15); server must be up
npm run shots                  # screenshots of all views → docs/design/shots/
npm run verify:ledger          # hash-chain check from disk
```

## Hard rules

- **Never touch the trust core for a design change:** `checkout`,
  `mandate`, `gate`, `ledger`, `audit`, `razorpay`, `keys`, `canonical`,
  and `idempotency` in `commerce-agent/src/`.
- `dashboard/` stays **zero-runtime-dependency** vanilla JS with no
  build step. Bump the `?b=NN` cache-buster in `dashboard/index.html`
  when CSS or JS changes.
- **Honesty:** nothing on screen is fake. The DEMO MODE badge always
  shows, and visuals reflect real server state.
- **Never commit or echo secrets** (`.env`, `commerce-agent/data/keys.json`).
- `npm run test:all` stays green. Run it with `DEMO_MODE=true` to avoid
  Groq and Razorpay rate limits.
- When structure changes, update `CONTEXT.md`. When a token or rule
  changes, update `DESIGN.md`. Both go in the same commit.
