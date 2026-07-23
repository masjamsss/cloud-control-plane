> SUPERSEDED 2026-07-16 — see PRD.md at the repo root. This document predates the multi-account + auto-apply direction.
> Generalized for publication 2026-07-22; decision substance unchanged.

# ADR-0008: No auto-apply; retire the standard-change lane

**Status:** Superseded by [ADR-0012](0012-ccp-auto-apply.md) (2026-07-17)
**Date:** 2026-07-10
**Deciders:** repo owner

## Context
Proposals 0002–0004 designed an "auto-eligible" standard-change lane: ops that pass a deterministic gate (reversible + LOW + non-security + no-downtime + zero-destroy + tightly-bounded + cost-neutral, [0002 §7A.3](../proposals/0002-service-module-catalog.md)) could apply without a human approval. 0002 qualified **36 of 74** estate Change ops (49%, "Reading the snapshot", ~line 435); 0003 generalised it across MACD to **111 of 1,171** ops (lines 11, 109), carried as an `auto_eligible` field in the op schema ([0003 §1](../proposals/0003-macd-capability-matrix.md), ~line 45); 0004 routed on the boolean with a `plan-check` backstop ([0004](../proposals/0004-frontend-interpreter-to-pr.md), ~line 316).

The locked concept says the opposite: [CONCEPT.md](../../ccp/CONCEPT.md) flow step 5 — "**Nothing auto-applies**" (line 27). And the machinery that made the auto-lane arguably safe — ≥3-reviewer prod Environment, org/SSO identity, an implemented plan-check — does not exist; per [ADR-0005](0005-gerbang-approval-authority.md)/[ADR-0006](0006-gerbang-local-identity.md) we run an authoritative local backend on a personal repo with, today, one human approver. In that world "auto" means **zero humans**. The built app already reflects this: `autoEligible` exists only as a type field (`gerbang/app/src/types/manifest.ts:61`) and inert manifest data (`src/data/manifests/*.json`) — no routing code reads it.

A related contradiction ([COHER-7](../proposals/0005-appendix/coherence.md)): 0003 §2 (line 78) and [REDESIGN-SPEC](../../ccp/docs/history/REDESIGN-SPEC.md) C4b (line 126) say `engineer_only` ops get "never a form", while CONCEPT.md line 24 says "never blocked at the form". The app implements the correct synthesis (`RequestForm.tsx:245` banner; `api.ts:175-178` NEEDS_ENGINEER) and this ADR ratifies it.

## Decision
Every change is human-approved before apply; **no auto-apply path exists, ever**. The standard-change lane is retired: `autoEligible` must never drive routing or approvals, and is neutralized in code — deleted from the manifest type and all manifests, or kept only as an inert, commented, historical field. Exposure (`l1_self_service` / `l1_with_guardrails` / `engineer_only`) is **routing metadata only**: every op is requestable through the same form; `engineer_only` submissions become tracked NEEDS_ENGINEER requests, never blocked at the form.

## Options considered

### Option A: Keep the standard-change lane (0002 §7A.3 / 0003 auto-lane)
| Dimension | Assessment |
|---|---|
| Complexity | High — needs the plan-check guard, digest binding, and a calibrated eligibility gate, all maintained forever |
| Cost | An unreviewed write path to a live production account; every manifest label becomes a security boundary |
| Team familiarity | Low — designed in 0002/0003, never built; no code reads the flag today |

**Pros:** L1 velocity on the 111 trivial ops (tags, descriptions, retention bumps); the gate predicate is deterministic and re-runnable by any reviewer.
**Cons:** With one approver and no org gates, auto-eligible means nobody looks; a mislabelled manifest or codemod bug applies unreviewed to prod; contradicts the locked CONCEPT; the saving is minutes on ops that already need only one approval under the risk quorum.

### Option B: Retire the lane; a human approves every apply (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low — neutralize a flag nothing consumes; one invariant, no exception machinery |
| Cost | Trivial LOW-risk changes wait for one human click; throughput is capped by approver availability |
| Team familiarity | High — matches CONCEPT.md and what the app already does |

**Pros:** The security story is one sentence ("no path applies without a human"); ADR-0005's backstops cover everything with no carve-out; a labelling error can no longer remove the human; low-risk stays cheap (1 approval, optimistic-approval UX).
**Cons:** No fast lane if request volume grows — the pressure lands on the single approver (see the interim profile under [0005 §4 Decision B](../proposals/0005-gerbang-v2-architecture-reassessment.md)); discards design work in 0002/0003, retained only as rationale.

## Consequences
- Easier: one trust model for all 1,171 ops; the 0002/0003 risk metadata (reversible, downtime, cost, zero-destroy) survives as **display and risk-scoring input** — it just never routes past a human.
- Easier: COHER-7 is closed — exposure tiers decide what happens *after* submit (self-service PR, guardrailed PR, or NEEDS_ENGINEER handoff), never whether the L1 may ask; leads gain a tracked queue of engineer-only demand instead of invisible side-channel requests.
- Harder: every change, however trivial, consumes human attention; if that becomes the bottleneck, the answer is enrolling approvers, not resurrecting the lane.
- Supersedes: [0002](../proposals/0002-service-module-catalog.md) §7A.1 (line 120, the auto-lane boolean), §7A.3 (eligibility gate), the `†` flags and "Reading the snapshot" (36/74, ~line 435); [0003](../proposals/0003-macd-capability-matrix.md) auto-lane framing (lines 11, 58–70, 109; `auto_eligible` in §1) and §2's "engineer_only must not be self-service" (line 78, per COHER-7); [0004](../proposals/0004-frontend-interpreter-to-pr.md) lane routing (~line 316); [REDESIGN-SPEC](../../ccp/docs/history/REDESIGN-SPEC.md) `⚡ auto` chip and `autoEligible` metadata (lines 123, 174, 250).
- Revisit: never by re-enabling the flag. If a future org-gated pipeline (ADR-0005 Option A2 world, ≥3 enrolled approvers) wants a fast lane, that is a new proposal with its own review.

## Action items
1. [ ] Neutralize `autoEligible` in the app: remove from `gerbang/app/src/types/manifest.ts:61` and all `src/data/manifests/*.json` (or mark inert/historical); CI grep asserts no runtime read.
2. [ ] Prepend superseded banners to 0002 §7A and 0003 naming this ADR (banner text per [coherence.md](../proposals/0005-appendix/coherence.md) step 2, including the COHER-7 clause).
3. [ ] Add the exposure-is-routing sentence to the app's ARCHITECTURE doc: "every op is requestable; `engineer_only` submissions become tracked NEEDS_ENGINEER requests" (COHER-7 acceptance), keeping 0003's machine-readable reason codes in the form banner.
4. [ ] Drop the `⚡ auto` chip from any UI derived from REDESIGN-SPEC §C2/C4; keep risk and exposure chips.
5. [ ] Extend ADR-0005's plan-digest guard check: no workflow path may enable auto-merge without a recorded in-app approval for that exact plan digest.
