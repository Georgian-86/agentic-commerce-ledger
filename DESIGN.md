# Design — Agentic Bazaar Trust Console

The design contract for `dashboard/`. Everything below describes what is
in the code today (`dashboard/css/tokens.css` is the source of truth for
values). When you change a token or a rule, change it here in the same
commit.

## 1. What the interface must make someone feel

A judge has about 90 seconds with this. In that time they should come
away believing three things:

1. **The money can't move without permission.** Mandate → Gate → Ledger
   should be legible at a glance, not buried in prose.
2. **It's real and running.** Live numbers, live ledger, real signatures,
   and an honest empty state rather than fake data.
3. **It was built by people with taste.** A calm, precise, fintech-grade
   surface: closer to Stripe, Linear or Mercury than to a hackathon
   template.

Voice: plain, confident, specific. Say "Refused: ₹2,400 exceeds the
₹2,000 cap", not "Oops! Something went wrong". Don't use exclamation
marks or marketing adjectives.

## 2. Identity

- **Dark-first.** Dark is the brand. Light is a full, equal theme, not
  an afterthought: every token has a light value.
- **One accent: iris violet** (`--iris`). It marks primary actions, the
  active nav item, and the "this is the system" highlights.
- **Mint** (`--mint`) is reserved for *live* things and the motion of
  success, such as the hash chain animating or a settled amount. Don't
  use it for decoration.
- **Semantic colours sit apart from the accent:** `--ok`, `--warn`,
  `--crit`, `--info`. Money states always map the same way:

  | State | Token |
  |---|---|
  | Settled / spent | `--ok` |
  | On hold | `--warn` |
  | Available | `--iris` |
  | Refused / tampered / broken | `--crit` |

## 3. Tokens (from `tokens.css`)

**Surfaces, darkest to lightest:** `--void` (page) → `--surface-0..3`
(panels, raised, hover) → `--line`, `--line-bright` (hairlines). Put
depth into surface steps and hairlines, not heavy shadows.

**Type:**

| Role | Font | Used for |
|---|---|---|
| Display | **Sora** 600 | h1–h3, big numbers |
| UI | **Instrument Sans** 400/500/600 | body, controls |
| Mono | **IBM Plex Mono** | hashes, JSON, eyebrows, labels, code |

The scale is `--step--1` 13px, `--step-0` 15px (body), `--step-1` 17,
`--step-2` 21, `--step-3` 28, `--step-4` 38, and `--step-5` a fluid
44→68 for the hero. Headings use `letter-spacing: -0.02em` and
`text-wrap: balance`.

**Radius:** `--r-xs` 6 · `--r-sm` 9 · `--r-md` 14 (panels) · `--r-lg` 20
· `--r-xl` 28 · `--r-pill`.

**Motion:** `--ease-out` for entrances, `--ease-spring` only for small
confirmations, and durations `--dur-1..4` (120–600 ms). Every animation
respects `prefers-reduced-motion`, which `base.css` enforces globally.

**Layout:** `--nav-h` 60px, `--page-max` 1240px, `--gutter` fluid
16→40px. **`.shell` is the scroll container, not the document**: it is
fixed below the nav with `overflow-y: auto`. Sticky elements and scroll
listeners must target `.shell`.

## 4. Rules — the quality bar

Hard rules. A change that breaks one is a regression, however nice it
looks.

1. **No clipped or overflowing content at 390px.** Long hashes and JSON
   wrap (`overflow-wrap: anywhere`) or scroll *inside* their own box.
2. **Contrast:** body text is at least 4.5:1 and large text or UI
   glyphs at least 3:1, in both themes. `--text-faint` is for
   decoration only, never for text a user needs to read.
3. **Minimum text size is 12px.** Mono eyebrows and labels may be 11px
   only if tracked and at least 4.5:1.
4. **Touch targets are at least 40×40px on mobile.** Controls that sit
   side by side (input, mic, send) share one height.
5. **Spacing is on a 4px grid.** Vertical rhythm between landing
   sections is consistent and has no dead bands larger than about one
   viewport-third.
6. **Every data view has three designed states:** loading (skeleton),
   empty (says why, and what to do next), and populated.
7. **Numbers use tabular figures** (`font-variant-numeric:
   tabular-nums`). Money is always shown as ₹ with Indian grouping
   (₹1,50,000).
8. **Visible focus ring** (`--iris-line`) on every interactive element,
   and the whole flow works from the keyboard.
9. **One primary button per view.** Everything else is secondary or
   ghost.
10. **No new runtime dependencies** and no framework. Fonts come only
    from Google Fonts.
11. **Both themes** are checked on every change.

## 5. Components (in `components.css`)

Nav bar (glass), panels, buttons (primary / secondary / ghost / danger),
pills and badges (the `DEMO MODE` badge is warn-toned and always
visible), stat tiles, the balance strip, the plan card, the trace
waterfall, JSON viewer, modal, toast, skeleton, and the spotlight tour.
Reuse these before inventing new ones. If a new component is genuinely
needed, add it to `components.css` and list it here.

## 6. Where the design is heading

This is the north star for the iteration loop. Each iteration should
move toward it.

- The landing hero shows the product working (a mandate, a Gate
  decision, a ledger record), not only abstract 3D cubes.
- The console reads like a real-time instrument panel. The empty state
  teaches, and the first message is one click away through suggested
  prompts.
- Every ledger record and mandate is inspectable in place: click a row
  and see the canonical JSON, the hash, and its link to the previous
  record.
- Mobile is a designed layout, not a squeezed desktop: a bottom or
  compact nav and single-column panels.
