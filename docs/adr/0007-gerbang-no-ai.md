# ADR-0007: No AI in the Gerbang request path

**Status:** Accepted
**Date:** 2026-07-10
**Deciders:** repo owner

## Context
Gerbang turns L1 form submissions into Terraform PRs that humans approve; with [ADR-0005](0005-gerbang-approval-authority.md) the local backend is now authoritative, so anything sitting in the request/approval path is a *control*, not a convenience. The design docs contradict each other on whether a model sits there. Proposal [0001](../proposals/0001-gerbang-l1-control-plane.md) embeds a "Fable concierge" in the request flow (lines 43, 171, 242), specifies a four-agent fleet in §11 (lines 2321–2495) and budgets ~US$100–130/month for it (§13.3). Proposal [0004](../proposals/0004-frontend-interpreter-to-pr.md) keeps the concierge as an optional prefill layer (§2.5, lines 318–343) and a severable "AI layer" (§6, line 816) — while itself proving in §1.3 that no LLM is required. The locked [gerbang/CONCEPT.md](../../ccp/CONCEPT.md) is categorical the other way: line 43 "No AI — deterministic, manifest-driven forms only (works with no model)"; line 53 "No AI helper". The [0005 reassessment](../proposals/0005-gerbang-v2-architecture-reassessment.md) confirmed the contradiction as [COHER-4](../proposals/0005-appendix/coherence.md) and found the built app already complies: `interpreter.ts` is pure manifest lookup + validation ("NO model, NO network"), and a grep for concierge code across `gerbang/app/src` returns nothing but one unused `VITE_CONCIERGE_AI` type declaration (`vite-env.d.ts:7`).

## Decision
The interpreter is deterministic — manifest lookup plus validation, pure functions over the module manifests and the inventory. No model is invoked anywhere in the request or approval path, and the app is fully functional with no LLM connected. This supersedes, **as current policy**, 0001 §11 (the Fable agent fleet, lines 2321–2495, plus the concierge at lines 43/171/242 and the §13.3 fleet cost line) and 0004 §2.5/§6 (the optional concierge/AI layer). Those designs are retained in the archive only as a *future, severable, advisory-only, read-only* option — never in the critical path, never generating authoritative HCL, never approving.

## Options considered

### Option A: Deterministic-only interpreter (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low — lookup and validation over static manifests; no prompts, no fallbacks, no key custody |
| Cost | Zero model spend (removes 0001 §13.3's ~US$100–130/month line) |
| Team familiarity | High — it is what's built; `gerbang/app/src/lib/interpreter.ts` and its tests assert exactly this |

**Pros:** Deterministic auditability — same input yields the same operation, risk tier and HCL, so every request is replayable in review and in tests; works fully offline (demo, air-gapped, CI); zero prompt-injection surface on the control path (0001 needed a whole §11.3 to defend the fleet — that surface now simply doesn't exist); no model-version drift in the evidence chain.
**Cons:** No natural-language on-ramp — operators pick operations from the manifest-generated list and type fields by hand; approvers read raw plan output with no AI summary; catalog/manifest coverage is the hard ceiling of what the portal can do, and only engineers extend it.

### Option B: Model in the request path (0001 fleet / 0004 concierge)
| Dimension | Assessment |
|---|---|
| Complexity | High — prompt-injection defence (0001 §11.3), output hygiene, API-key custody, degraded-mode paths |
| Cost | ~US$100–130/month plus the audit cost of a nondeterministic component near authorization |
| Team familiarity | Low — nothing of it was ever built; REDESIGN-SPEC's `ConciergeBox` (line 352) references a file that does not exist |

**Pros:** Natural-language shortcut that prefills forms; draft PRs for beyond-catalog changes; plan summaries for reviewers.
**Cons:** A model between the user and a validated request is an injectable, nondeterministic input to a control system; cannot run offline; every audit answer gains a "which model, which version, which prompt" clause. 0004 §2.5 itself concedes that severing the concierge loses only a prefill shortcut — the road is identical without it.
**Disposition:** Retained as a future option only, and only in this shape: advisory, read-only, severable, off by default, outside the request/approval path, behind a new ADR before any code lands.

## Consequences
- Easier: audit and replay (deterministic transcript from form input to HCL); offline operation; no model secrets to hold or rotate; golden-replay style testing stays honest because there is nothing stochastic to mock.
- Harder: UX ceiling is manifest coverage — every new operation is engineering work, not a prompt; approvers get no machine summarization and must read plans (mitigated by the risk model and plan-digest guard of [ADR-0005](0005-gerbang-approval-authority.md)).
- The built app needs no change to comply — this ADR ratifies what `gerbang/app/src` already does. The one vestige is the unused `VITE_CONCIERGE_AI` declaration.
- Revisit: only via a new ADR, and only for an advisory/read-only layer per Option B's disposition. Any such layer must leave `grep -ri concierge` on the request-path code an honest test of this invariant.

## Action items
1. [ ] Add superseded-as-current-policy banners naming this ADR to 0001 §11/§13.3, 0004 §2.5/§6, and REDESIGN-SPEC §B/§F/§H (the "AI: off" indicator and `ConciergeBox` at lines 72/352/403) — per COHER-4 and 0005 Phase 0 doc reconciliation.
2. [ ] Remove the unused `VITE_CONCIERGE_AI` declaration from `gerbang/app/src/vite-env.d.ts` (separate app change; acceptance: `grep -ri concierge gerbang/app/src` returns nothing).
3. [ ] Add a dependency guard in CI: fail if `gerbang/app` or `gerbang-api` gains a model SDK (`@anthropic-ai/*`, `openai`, etc.) without an ADR referencing this one.
