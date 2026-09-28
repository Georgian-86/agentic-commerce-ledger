# The design iteration loop

How any AI agent (or person) improves the Trust Console. The goal is
simple: **each iteration leaves the site measurably better than the one
before, and never worse.**

The loop has memory. Critiques, scores and open fixes live in
[`ITERATION_LOG.md`](ITERATION_LOG.md), so iteration *n+1* picks up
exactly where iteration *n* stopped, even in a fresh session.

---

## The loop

```
 ┌─► 0. LOAD   read DELIVERABLES.md, DESIGN.md, the last ITERATION_LOG entry
 │   1. SEE    run the app, capture screenshots, look at every one
 │   2. TEST   functional checks: test suites + a click-through
 │   3. CRITIQUE  as a senior product designer (rubric below)
 │   4. PLAN   pick ≤ 5 fixes, P0s first, carry-overs before new ideas
 │   5. BUILD  make the changes, small and scoped to dashboard/
 │   6. VERIFY re-run 1 + 2, compare before/after, score again
 └── 7. LOG    append the iteration to ITERATION_LOG.md, commit, push
```

### 0. Load

- Read `DELIVERABLES.md` (what must not break) and `DESIGN.md` (the
  contract).
- Read the **latest entry** in `ITERATION_LOG.md`. Its "Next iteration"
  list is your starting backlog. Anything still open **must** be done
  or explicitly carried over with a reason.

### 1. See

```bash
DEMO_MODE=true npm start            # or: npm run dev
npm run shots -- --out iter-NN      # 5 views × {desktop 1440, mobile 390} × {dark, light}
```

- In the Claude Code web sandbox, prefix the shots command with
  `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium SHOTS_IGNORE_HTTPS_ERRORS=1`.
  On a laptop, run `npx playwright install chromium` once instead.
- **Open and look at every screenshot.** Don't critique from the code.
- The script also reports console errors, failed requests and elements
  wider than the viewport. Treat each one as a finding. Font requests
  failing only inside the sandbox proxy is environmental, so say so
  rather than hiding it.
- Also capture the **interactive states** that matter: the console
  mid-conversation (plan card, trace, cart, confirm), the ledger after
  "break it", a tampered mandate, the modal and the tour. Drive them
  with Playwright or by hand.

### 2. Test

- `npm run test:all` (server up, `DEMO_MODE=true`). It must stay green.
- Click through the golden path. Start a session as *Gift shopper*,
  ask for "gifts under 1500", draft, and confirm. Then check that the
  hold appears on the balance strip, the ledger verifies, break-it is
  caught, and tampering is rejected.
- Keyboard-only pass on one view: Tab order, visible focus, Esc closes
  modals.

### 3. Critique — as a senior product designer

Put on the persona and stay in it:

> *You are a principal product designer with 10+ years shipping fintech
> and developer tools (think Stripe Dashboard, Linear, Mercury). You're
> reviewing this for a demo in front of judges tomorrow. You're kind but
> exacting: you notice 2px misalignments, muddy hierarchy, lazy empty
> states, and copy that says nothing. You never say "looks good": you
> say what is wrong, why it matters, and what exactly to do.*

Score every dimension **1–10** and justify each score with a
**specific** observation that names the view, theme, viewport and
element:

| # | Dimension | What a 10 looks like |
|---|---|---|
| 1 | **First impression / 5-second test** | A stranger can say what this is and why it's trustworthy |
| 2 | **Visual hierarchy** | One obvious focal point per screen; eye path is intentional |
| 3 | **Typography** | Clear scale, tight headings, readable body, mono only where it means something |
| 4 | **Colour & contrast** | Accent disciplined, semantic colours consistent, AA everywhere, both themes |
| 5 | **Layout & spacing** | 4px grid, consistent rhythm, aligned edges, no dead bands |
| 6 | **Responsiveness** | 390px is a designed layout; nothing clipped; targets ≥ 40px |
| 7 | **States** | Loading / empty / error / success all designed and honest |
| 8 | **Interaction & motion** | Feedback on every action; motion explains, never decorates; reduced-motion respected |
| 9 | **Copy** | Specific, plain, confident; every label earns its place |
| 10 | **Trust & storytelling** | Mandate → Gate → Ledger is felt, not just read |

Then write:

- **Findings**, each tagged **P0** (broken, clipped, illegible, or
  misleading), **P1** (clearly hurts quality), or **P2** (polish).
  Each one needs the location, the problem, why it matters, and the
  fix.
- **The single biggest lever**: the one change that would most raise
  the overall impression.

### 4. Plan

- Pick **at most 5** fixes. Order them: carried-over P0s, then new
  P0s, then the biggest lever, then P1s. P2s only when nothing above
  them remains.
- Write them down *before* coding, with the file each one touches.

### 5. Build

- Stay inside `dashboard/` (plus `DESIGN.md` if a token or rule
  changes). Never edit the trust core for a design fix.
- Use tokens, never hard-coded hex. Reuse existing components.
- Bump the `?b=NN` cache-buster in `dashboard/index.html` when CSS or
  JS changes.
- For bigger visual moves, use the **frontend-design** skill. For
  multi-step work, use **superpowers:writing-plans** and
  **superpowers:verification-before-completion**.

### 6. Verify

- Re-run the shots into the same `iter-NN` folder and the test suites.
- Compare before and after for **every** view you touched, in both
  themes and both viewports. Confirm each planned fix actually landed
  and nothing regressed.
- Re-score. **The total must go up. No single dimension may drop**
  unless you explain the trade-off in the log. If it regressed, fix it
  or revert before logging.

### 7. Log

Append a new entry to `ITERATION_LOG.md` using the template there.
Commit with the message `design: iteration NN — <headline>` and push.

---

## Rules of the loop

- **Evidence over assertion.** You may only claim a fix is done if the
  screenshot shows it.
- **Don't re-litigate settled decisions** recorded in the log, such as
  dark-first or the iris accent, unless the critique brings new
  evidence.
- **Small, safe, visible.** Five good fixes beat one half-finished
  redesign.
- **Never trade a deliverable for polish.** If a design idea would
  break something in `DELIVERABLES.md`, log it as an idea and don't
  build it.
- Screenshots are local working files and are gitignored. The log
  carries the findings in words so the history survives.
