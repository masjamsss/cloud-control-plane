# ADR-0010: Look & feel — clean-neutral base, futuristic through interaction

**Status:** Accepted — aesthetic clauses superseded by [ADR-0014](0014-ccp-ledger-redesign.md) (2026-07-17); interaction-quality requirements remain in force
**Date:** 2026-07-10
**Deciders:** repo owner

## Context
`gerbang/CONCEPT.md` (lines 52, 55–56) locks the look: "clean neutral, professional… Not the heavy dark ops-console. Light, calm… one restrained accent." Requirement R8 asks for a "futuristic, beautiful, powerful" React UI. The 0005 reassessment confirmed these were never reconciled — no artifact said how, so an implementer could drift toward sci-fi chrome (breaking the lock) or ship the current static UI (failing R8). See [../proposals/0005-gerbang-v2-architecture-reassessment.md](../proposals/0005-gerbang-v2-architecture-reassessment.md) Section "R8 — Futuristic React UI/UX", [`COHER-6`](../proposals/0005-appendix/coherence.md) and [`UIUX-1`](../proposals/0005-appendix/ui-ux.md).

Worse, `gerbang/REDESIGN-SPEC.md` §E "Visual system — final tokens" (line 259) declares "Dark is canonical; a light override ships for reviewers" — a direct contradiction of the CONCEPT lock that leaked into code as `<meta name="color-scheme" content="dark">` on a light theme (`UIUX-2`).

The foundation to build on is strong and must not be rebuilt: zero hardcoded hexes outside `tokens.css` (brand swap stays a one-file edit), the Risk-only color axis is enforced in code, and `prefers-reduced-motion` is honored in every animating stylesheet. What's missing is the "powerful" half: no virtualization against the 1,320-resource inventory, no command palette, no dark variant, no concurrent-React usage, and three tokens fail the AA contrast their own comments claim (`UIUX-3`).

## Decision
Keep CONCEPT.md's clean-neutral **light** base: one accent (`#2a5bd7`), Risk the only saturated axis. Deliver "futuristic/beautiful/powerful" through **interaction quality** — tokenized depth/elevation, purposeful micro-interactions ≤250ms honoring `prefers-reduced-motion`, 60fps virtualized lists, a command palette, and optimistic approvals (rendered against the authoritative gerbang-api, per [0005-gerbang-approval-authority.md](0005-gerbang-approval-authority.md)) — plus an **opt-in dark theme of the same token names**. Explicitly banned: neon/glow, glassmorphism, animated backgrounds, new saturated hues, dark-by-default. `gerbang/DESIGN-DIRECTION.md` is the binding spec. This supersedes `gerbang/REDESIGN-SPEC.md` §E line 259 ("Dark is canonical"): light is canonical; dark is a user-chosen variant of the same calm system.

## Options considered

### Option A: Futuristic = visual styling (dark-canonical, glow, chrome)
| Dimension | Assessment |
|---|---|
| Complexity | Med — mostly CSS, but a second visual language to police |
| Cost | Breaks the CONCEPT lock; saturated accents vibrate on dark; re-fights the brand-swap story |
| Team familiarity | Low — nothing in the current token system supports it |

**Pros:** Reads as "futuristic" instantly in a screenshot; REDESIGN-SPEC §E already drafted a dark ramp.
**Cons:** Is exactly the "heavy dark ops-console" the owner locked out; screenshot-futurism doesn't survive daily L1 use; risks Risk (the one signal that matters) drowning in ambient color.

### Option B: Ship the current static UI as-is (lock wins, R8 dropped)
| Dimension | Assessment |
|---|---|
| Complexity | None |
| Cost | R8 unmet; janks at estate scale (352 EBS volumes in one unvirtualized list); loading states stay dead code |
| Team familiarity | High — it's what exists |

**Pros:** Zero work; the calm base is already good.
**Cons:** "Powerful" is a real requirement, not decoration — keyboard speed and 60fps at 1,320 resources are operator needs; abandoning R8 just re-opens the argument later.

### Option C: Calm base, futuristic through interaction + opt-in dark of the same tokens (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Med — virtualization, command palette, concurrent React, a second value set per token |
| Cost | "Futuristic" must be earned in engineering, not CSS; every token pair is AA-verified twice (light and dark) |
| Team familiarity | Med — extends the existing token architecture rather than replacing it |

**Pros:** Honors the lock and R8 simultaneously; dark as a *user-chosen variant of the same tokens* is not the forbidden ops-console; "utilize everything React can do" maps to Suspense, transitions, optimistic state — measurable, not aesthetic.
**Cons:** Slower to demo than a coat of dark paint; the banned list needs enforcement (review checklist), or drift returns.

## Consequences
- Easier: implementers finally have a contract — `DESIGN-DIRECTION.md` decides every "is this too flashy?" argument; the token-only brand swap survives; the dark variant is additive (same names, second values), so components never branch on theme.
- Harder: interaction quality is engineering work (virtualization, palette, optimistic reconciliation with gerbang-api); the AA surface doubles — the contrast checker must gate CI for both themes; the banned list must be checked in review, not assumed.
- Revisit: when company branding lands (token value swap — the point of the architecture); if real users overwhelmingly choose dark, the *default* could be revisited — but only via a new ADR, never by drift.

## Action items
1. [ ] Write `gerbang/DESIGN-DIRECTION.md` (~1 page, binding): base-look clause, interaction-quality clause, opt-in-dark clause, banned list. Link it from CONCEPT.md "Look & feel" with one line.
2. [ ] Mark `gerbang/REDESIGN-SPEC.md` §E line 259 ("Dark is canonical") superseded by this ADR; keep §E's token/AA method, invert the canonical theme.
3. [ ] Fix `color-scheme` in `index.html` and the three failing tokens; add the contrast script to `npm test` (`UIUX-2`, `UIUX-3`; 0005 Phase 7 step 1).
4. [ ] Execute 0005 Phase 7: virtualized lists, command palette, opt-in dark theme, optimistic approvals — each step citing the DESIGN-DIRECTION clause it implements.
