# ADR-0014: Ledger visual identity + per-user selectable palettes

**Status:** Accepted
**Date:** 2026-07-17
**Deciders:** repo owner
**Supersedes:** the *aesthetic* clauses of [ADR-0010](0010-gerbang-look-and-feel.md) and `ccp/DESIGN-DIRECTION.md` (the "clean-neutral, calm, one fixed accent" mandate). Keeps ADR-0010's interaction-quality and engineering-discipline requirements in full.

## Context
ADR-0010 locked a deliberately calm, neutral, one-fixed-accent look and delivered "powerful" through interaction quality. The interaction half shipped and is good: tokenized motion (WS1a), self-hosted Geist, virtualization, command palette, skeletons, the WCAG-AA contrast gate. But in daily use the owner's verdict (2026-07-17) is that the *visual identity* reads as timid and forgettable — calm by mandate tipped into generic. ADR-0010 anticipated exactly this: its Consequences → "Revisit" clause permits changing the look "only via a new ADR, never by drift." This is that ADR.

A design exploration (three directions × real screens, then five palettes on the chosen direction) was reviewed with the owner. Decisions: adopt the **Ledger** direction; ship **all five palettes** as a **per-user** choice; roll out **whole-app at once**.

## Decision
Adopt **"Ledger"** — a confident light-editorial identity — as the binding look, and replace the single fixed accent with a **per-user selectable palette**.

**Ledger design language (the new binding look):**
- Confident Geist display typography with real hierarchy (large tracking-tight headers), not oversized hero copy.
- Structure over decoration: numbered section rails (`01 — Compute`), hairline dividers instead of card-in-card, tabular-figure data authority for counts/metrics.
- Light remains canonical and the default; the calm base stays *approachable* for the mixed L1 team — what changes is that it is now *intentional*, not defaulted.

**Palette system:**
- Five palettes — **Bordeaux · warm**, **Ink navy · cool**, **Teal · stone**, **Slate · neutral**, **Mono · risk-only** — each redefining only the accent + neutral surface/text tokens.
- **Per-user** preference, persisted like the existing `data-theme` toggle (a new `data-palette` axis on `<html>`, first-paint inline script, per-user store). Not per-project (that remains a future option).
- Risk (`--risk-low/med/high`) stays a **fixed, palette-independent** axis — it is the one signal that must never shift.

**Preserved from ADR-0010 (non-negotiable):** zero hex outside `tokens.css`; risk is the only saturated *status* axis; WCAG-AA gate — now across **every palette × theme**; `prefers-reduced-motion`; keyboard reachability; skeleton-first loading; virtualization; the WS1a motion tokens; Geist.

**Still banned:** neon/glow, glassmorphism/blur panels, animated backgrounds, dark-by-default. (Direction C's blueprint-grid texture was *not* chosen; texture stays out.)

## Options considered
- **A · Deck (dark command console):** most dramatic, most "premium infra tool," but overturns the "approachable for a mixed L1 team, not a heavy dark ops-console" rationale that still holds. Rejected as default; dark remains an opt-in theme.
- **B · Ledger (light editorial) — chosen:** keeps the correct approachable-light base, fixes the timidity through typography and structure. Lowest audience risk, real identity.
- **C · Instrument (industrial):** most distinctive, but texture + saturated signal-orange are furthest from restraint and tire on all-day use. Rejected.
- **One fixed accent vs per-user palettes:** a picker is personalization, not brand ("consistency comes from removing knobs"), and multiplies the AA surface — accepted deliberately because operator choice is the owner's explicit goal, and the token architecture already exists to make it a low-cost extension.

## Consequences
- **Easier:** the token-only theming architecture finally earns its keep — palettes are a value-set layer, components never branch. The design has a point of view.
- **Harder:** the AA surface multiplies (5 palettes, plus dark) — the contrast checker must gate **every** palette; `DESIGN-DIRECTION.md` must be rewritten to describe Ledger + the palette system; the redesign touches every screen (owner chose whole-app-at-once → one large review surface).
- **Revisit:** per-project palette/branding, and whether one palette should be the shipped default, are future decisions — again only by ADR, never by drift.

## Action items
1. [ ] Rewrite `ccp/DESIGN-DIRECTION.md` to describe the Ledger language + the five-palette per-user system; mark the old "one accent / calm" text superseded by this ADR.
2. [ ] Extend `tokens.css` with a `data-palette` layer (5 palettes) and a palette store + first-paint script mirroring `theme.ts`; add a palette picker to the account menu / settings.
3. [ ] Extend the contrast gate to iterate every palette × theme; keep it in CI.
4. [ ] Apply the Ledger language across every screen; keep the full test suite + guards green throughout.
