> SUPERSEDED 2026-07-16 — see PRD.md at the repo root. This document predates the multi-account + auto-apply direction.

# ADR-0009: Risk-based approver quorum and the single-approver interim profile

**Status:** Superseded by [ADR-0013](0013-ccp-approval-ladder-2fa.md) (2026-07-17)
**Date:** 2026-07-10
**Deciders:** repo owner

## Context
The locked concept keeps a risk-based quorum — 1 approval for low-risk, 2 for risky/delete (`gerbang/CONCEPT.md` step 4, line 26; `policy.ts` `deleteMin: 2`). Reality: exactly one human approver exists anywhere (`CODEOWNERS` is `* @masjamsss` on a personal repo), so the 2-approval rule and separation of duties (SoD) are structurally unsatisfiable today. The [0005 reassessment](../proposals/0005-gerbang-v2-architecture-reassessment.md) (§4 Decision B) confirmed this from four angles: [ACCT-4](../proposals/0005-appendix/auditability.md) (critical — the mock marks requests APPLIED at `approvals.length >= required` with no dedupe, no requester exclusion, and no check that two eligible approvers even exist), [ADV-3](../proposals/0005-appendix/red-team.md) (critical — a Lead can mint a second "approver" account and satisfy quorum alone), [SCAL-8](../proposals/0005-appendix/scalability.md) (every request serializes on one person), and [COHER-15](../proposals/0005-appendix/coherence.md) (CONCEPT reads as launchable while its own rules require ≥3 humans for a Delete). Decision A ([0005-gerbang-approval-authority.md](0005-gerbang-approval-authority.md)) makes `gerbang-api` the authoritative enforcement point, so quorum can be server-enforced rather than a UI courtesy. Nothing auto-applies and there is no auto-eligible bypass lane (retired per 0005) — every change without exception passes this quorum.

## Decision
The risk-based quorum stays: **one approval for low-risk changes; two or more distinct approvals for the riskiest activity — any HIGH-risk change and any Delete.** SoD is enforced: the requester cannot approve their own request and no account counts twice — server-side in `gerbang-api` as soon as it exists (until then, UI-enforced and explicitly labelled advisory).

Until a second human approver is enrolled, Gerbang runs a documented **single-approver interim profile**:

1. **Show the infeasibility.** When policy requires 2 approvals but fewer than 2 eligible approvers exist (active, approval-capable, excluding the requester), the approval screen states "HIGH needs 2 approvals but only 1 eligible approver exists — proceeding under the single-approver interim profile (ADR-0009)". It never silently under-approves.
2. **Cooling-off delayed apply.** HIGH-risk and Delete changes approved under the interim profile wait a minimum 24-hour window (policy-configurable upward, never off) between the single approval and merge/apply, cancellable at any point during the window.
3. **Elevated logging.** Interim approvals are flagged `interimProfile: true` in the hash-chained audit log with the plan digest; any enrollment of an approval-capable account during the interim is flagged the same way (the ADV-3 minted-approver path stays visible even if attempted).
4. **Signed risk acceptance — recorded here.** repo owner (@masjamsss) accepts, as of 2026-07-10, that HIGH-risk and Delete changes may proceed with one distinct approval plus the controls above, and carries the residual risk of a single mistaken or compromised approver. This ADR in git history is the signature.

**Exit criterion:** enroll ≥2 real approver humans (distinct people, distinct credentials — not accounts minted by one person for themselves). Only then is the interim profile removed, by a status note on this ADR.

This supersedes [proposal 0001](../proposals/0001-gerbang-l1-control-plane.md) §8.1 ("Phase -1: the org / SSO reality that must exist before anything ships") and §8.3 ("≥3 named humans" as a hard, verified launch precondition): the org + SSO + ≥3-reviewer substrate becomes the interim profile's exit target, not a launch blocker. The design stays org-portable per Decision A.

## Options considered

### Option A: Block HIGH/Delete changes entirely until 2 approvers exist
| Dimension | Assessment |
|---|---|
| Complexity | Low — refuse the request class outright |
| Cost | The riskiest changes route around Gerbang as hand-authored PRs with *fewer* controls, not more |
| Team familiarity | High — it's what ACCT-4's mock-fix suggests |

**Pros:** No under-approval ever; nothing to accept or sign.
**Cons:** Pushes exactly the changes that most need structured review, plans, and audit into the untooled path; makes Gerbang useless for the estate's real single-operator present.

### Option B: Single-approver interim profile with compensating controls (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Med — eligible-approver computation, banner, cooling-off timer, flagged logging |
| Cost | HIGH/Delete changes wait ≥24 h; residual one-person risk explicitly accepted |
| Team familiarity | High — same quorum machinery, plus one documented mode |

**Pros:** Honest — the gap is displayed, logged, time-buffered, and signed for, never papered over; the quorum policy survives intact for the day it becomes satisfiable; risky changes stay inside the tooled, audited path.
**Cons:** For its duration it is one person's judgment plus a timer; the cooling-off is a deliberate-error control, not a second pair of eyes (ADV-3's core risk remains until exit).

### Option C: Drop the 2-approval rule (rejected)
| Dimension | Assessment |
|---|---|
| Complexity | Low — delete `deleteMin: 2` |
| Cost | Permanently weakens the control to fit a temporary staffing gap |
| Team familiarity | High |

**Pros:** No infeasible states to display.
**Cons:** Encodes today's constraint as forever policy; when approvers exist, nothing demands they be used; contradicts the locked CONCEPT and R4's accountability bar.

## Consequences
- Easier: launch is unblocked without weakening policy; the UI is honest about what it cannot enforce (ACCT-4, COHER-15); under Decision A the in-app quorum becomes the load-bearing gate, with approver identities embedded in the PR so GitHub's single human review audits a quorum already met (SCAL-8).
- Harder: HIGH/Delete changes are slower by design during the interim; SoD is **not** relaxed, so requests raised by the sole approver cannot be approved in-app at all — they go as ordinary hand-authored PRs under the GitHub gates; the interim carries confirmed residual risk (ADV-3) that one person effectively controls the path.
- Revisit: at exit (second approver enrolled — remove the profile, re-verify SoD end-to-end); on org migration, when team CODEOWNERS and required reviewers per 0001 §8 become available as additional backstops.

## Action items
1. [ ] Enforce quorum + SoD server-side in `gerbang-api`: distinct accounts, requester excluded, approvals deduped — replacing the mock's `approvals.length >= required` check (`gerbang/app/src/lib/api.ts:234-247`).
2. [ ] Compute eligible-approver count (active, approval-capable, minus requester) and render the interim infeasibility banner citing this ADR.
3. [ ] Implement the ≥24 h cooling-off for HIGH/Delete under the interim profile, cancellable during the window, non-skippable.
4. [ ] Flag interim approvals and approval-capable enrollments `interimProfile: true` in the hash-chained audit log with plan digests.
5. [ ] Enroll ≥2 real human approvers with distinct credentials; then retire the interim profile and append a dated status note here.
