# Design iteration log

Newest entry at the bottom. **Read the latest entry before starting an
iteration.** Its "Next iteration" list is your backlog. The process is
in [`ITERATION_LOOP.md`](ITERATION_LOOP.md).

## Scoreboard

| Iter | Date | Total /100 | Headline |
|---|---|---|---|
| 00 | 2026-09-28 | 53 | Baseline: strong identity, broken mobile, a dishonest empty chain |

---

## Template (copy for each new iteration)

```markdown
## Iteration NN — <headline>   (YYYY-MM-DD)

**Carried over:** <open items from the previous entry, and what happened to each>
**Planned fixes (≤5):** 1. … (file) 2. …
**Tests:** test:all <pass/fail + counts> · click-through <ok/notes> · shots problems <n>

### Scores (before → after)
| Dimension | Before | After | Evidence |
|---|---|---|---|
| 1 First impression | | | |
| 2 Hierarchy | | | |
| 3 Typography | | | |
| 4 Colour & contrast | | | |
| 5 Layout & spacing | | | |
| 6 Responsiveness | | | |
| 7 States | | | |
| 8 Interaction & motion | | | |
| 9 Copy | | | |
| 10 Trust & storytelling | | | |
| **Total** | | | |

### Senior-designer critique (after this iteration's changes)
- **P0** · <view/theme/viewport> · <problem> → <fix>
- **P1** · …
- **P2** · …
**Biggest lever:** …

### Next iteration
1. …
```

---

## Iteration 00 — Baseline   (2026-09-28)

This is a critique only; no changes were made. Screenshots were taken
with `npm run shots` in the cloud sandbox. Google Fonts could not load
through the sandbox's proxy, so the light-theme console shots show
fallback fonts. That is environmental, not a site bug.

### Scores
| Dimension | Score | Evidence |
|---|---|---|
| 1 First impression | 7 | The landing hero headline "Money that moves only when it's allowed to." is excellent: clear, confident, with a good gradient. The 3D chain reads as "blockchain-ish" rather than *this* product. |
| 2 Hierarchy | 6 | The landing has a clear focal point. On the console (empty) the eye has nowhere to go: a 400px empty chat pane, and a PLAN·ACT·GATE stepper floating above the grid with no anchor. |
| 3 Typography | 7 | Sora, Instrument Sans and Plex Mono pair well. Mono eyebrow and stat labels (e.g. "SETTLED GMV") are about 10px and too faint to read comfortably. |
| 4 Colour & contrast | 6 | The accent is disciplined. But `--text-faint` is used for real labels (stat tiles, "chain height 0", footer) and fails AA. The ledger's *empty* state uses a green `--ok` banner, so "nothing here" reads as success. |
| 5 Layout & spacing | 5 | Landing has dead bands of about 200px between the hero and "The mechanism" and between sections. The hero 3D canvas is hard-cropped at its right edge (cubes cut mid-face). The console input row has mismatched heights: the mic button is about 34px next to a 42px input and send button. |
| 6 Responsiveness | 2 | **Broken at 390px.** The nav overflows: "Mandates" is clipped, "Agents" and "Tour" are unreachable. Mandates: persona cards, balance panel and the credential JSON run off the right edge. Agents: every panel is clipped. Console: `.pstep` overflows. Landing: `.path-card` overflows. |
| 7 States | 5 | Skeletons exist. Empty states are passive ("No turns yet.", "No records match this filter yet.") and don't tell you what to do. Four ₹0/0 stat tiles on a fresh landing look dead rather than intentionally new. |
| 8 Interaction & motion | 6 | Reduced motion is respected globally and page crossfades exist. Not yet reviewed mid-flow (plan card, trace, confirm): **do this in iteration 01.** |
| 9 Copy | 5 | Mostly strong, but "Not a mockup" is followed by "…not a mockup." (the section repeats itself). "Ledger is empty — nothing to verify yet." sits next to an enabled "Verify chain" button. |
| 10 Trust & storytelling | 4 | **Honesty bug:** Ledger view says "chain height 0" while the canvas draws 8 linked blocks, and the landing hero draws a chain for an empty ledger. For a product whose pitch is "numbers on screen are real", decorative data is a credibility leak. |
| **Total** | **53** | |

### Senior-designer critique
- **P0** · all views · mobile 390 · The nav overflows and hides Agents and Tour. → Make the nav scroll horizontally, or collapse it into a compact menu or bottom tab bar below about 640px, and hide the brand wordmark on mobile (the icon is enough).
- **P0** · Mandates, Agents, Landing, Console · mobile 390 · Panels run past the viewport. → Find the fixed widths, `min-width` and grid/flex children without `min-width: 0` (`.stack.gap-3`, `.panel.span-2`, `.path-card`, `.pstep`). Make pre/JSON blocks wrap (`white-space: pre-wrap; overflow-wrap: anywhere`) or scroll inside their own box.
- **P0** · Ledger + Landing hero · The 3D chain draws blocks that don't exist. → Draw `chain height` blocks, where 0 means a single dashed "genesis" placeholder with the caption "No records yet — start a session to write the first one". Keep the animation, but make it truthful.
- **P1** · Ledger · The empty state uses the green `--ok` banner. → Use a neutral info or empty treatment, disable "Verify chain" while it's empty (with a tooltip saying why), and add a CTA: "Open the console →".
- **P1** · Landing · Dead vertical bands. → Tighten section spacing to one consistent token (about 96px desktop, 64px mobile), and let the hero canvas bleed to the page edge with a fade mask instead of a hard crop.
- **P1** · Console · The empty chat pane is dead space. → Add three suggested prompt chips ("gifts under ₹1,500", "buy the candle duo", "something for ₹5,000", the last one to demonstrate a Gate refusal), and anchor the PLAN→SETTLE stepper inside the chat panel header.
- **P1** · Everywhere · Faint labels. → Promote stat and label text from `--text-faint` to `--text-dim` and raise it to 11–12px with tracking. Keep `--text-faint` for decoration.
- **P2** · Console · The input row heights differ. → Give the input, mic and send buttons one shared 44px height.
- **P2** · Landing · The "Not a mockup" section repeats itself. → Try "Live from this server" with the subtitle "Real numbers from the instance you're connected to. A fresh deploy starts at zero, on purpose."
- **P2** · Landing footer · "Replay tour" is styled differently from its sibling links. → Unify it.

**Biggest lever:** fixing mobile, which takes Responsiveness from 2 to 7 and alone adds about 5 points. Judges often open links on their phones.

### Next iteration
1. P0: mobile nav (`components.css` nav, `index.html`).
2. P0: overflow on Mandates, Agents, Landing and Console at 390px (`views.css`, `components.css`).
3. P0: truthful chain canvas, both ledger and hero (`js/gl/chain3d.js`, `views/ledger.js`, `views/landing.js`).
4. P1: ledger empty state, neutral banner, disabled verify button and CTA (`views/ledger.js`, `components.css`).
5. P1: console suggested-prompt chips and anchored stepper (`views/console.js`, `views.css`).

Also in iteration 01: capture and critique the **mid-flow** states (plan card, trace waterfall, cart, confirm, hold, break-it modal, tampered mandate), which this baseline didn't cover.
