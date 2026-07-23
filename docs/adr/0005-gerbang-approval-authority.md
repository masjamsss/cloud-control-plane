> SUPERSEDED 2026-07-16 — see PRD.md at the repo root. This document predates the multi-account + auto-apply direction.
> Generalized for publication 2026-07-22; decision substance unchanged.

# ADR-0005: Gerbang approval authority (in-app, GitHub gates as mechanical backstop)

**Status:** Accepted
**Date:** 2026-07-10
**Deciders:** repo owner

## Context
Gerbang turns L1 form submissions into Terraform PRs; a human approves, CI applies, nothing auto-applies. Proposal [0001 §8](../proposals/0001-gerbang-l1-control-plane.md) (Identity, RBAC & separation of duties, lines 1438–1660) placed all approval authority in GitHub: an org with SAML SSO (§8.1, a "hard precondition"), team CODEOWNERS (§8.2), ≥3 named humans on the prod Environment (§8.3), and an apply-job SoD check comparing GitHub logins (§8.4). None of those preconditions exist — the repo is personal (github.com/masjamsss/cloud-control-plane), there is no org, and today there is one human. The locked [gerbang/CONCEPT.md](../../ccp/CONCEPT.md) reversed this silently: local Gerbang accounts, one `gerbang-bot` doing all git. That reversal was recorded nowhere ([COHER-1](../proposals/0005-appendix/coherence.md)) and left "who approved" living only in the app while GitHub shows the bot everywhere ([ACCT-13](../proposals/0005-appendix/auditability.md)). The [0005 reassessment §4 Decision A](../proposals/0005-gerbang-v2-architecture-reassessment.md) framed the fork and forced this decision. Constraint: we prepare on personal GitHub now and may move to an org later — the design must not hard-depend on org-only constructs, and must not preclude that migration.

## Decision
Approval authority lives in an authoritative local backend, `gerbang-api` (Fork A1): server-enforced permissions and SoD, server-assigned timestamps, hash-chained tamper-evident audit, local Gerbang accounts. GitHub's gates — branch protection, the prod Environment required-reviewer click, and a plan-digest guard — remain as **mechanical backstops**, not the authority. Every in-app approval record is embedded into the PR so git history keeps a tamper-evident copy of who approved. This supersedes 0001 §8 in full (§8.1 org/SSO precondition, §8.3 ≥3-reviewer environment, §8.4 GitHub-login SoD) and resolves ACCT-13 by choosing its option (A): Gerbang approvals gate the **merge**; GitHub gates the **apply**.

## Options considered

### Option A1: Authoritative local backend, GitHub as mechanical backstop (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Med — a new server (`gerbang-api`) plus an attribution bridge into git history |
| Cost | Gerbang's store (`gerbang-config`) becomes security-critical: backup/DR, PITR, degraded-mode procedures it never needed as a "disposable read model" |
| Team familiarity | High — matches the locked CONCEPT.md; works on personal GitHub today |

**Pros:** Works now with one human and no org; matches the owner-confirmed concept; permissions, quorum and SoD are enforced server-side instead of in `localStorage`; org migration stays open (local accounts can later map to SSO identities).
**Cons:** We build and operate a security-critical system ourselves; approvals are only as trustworthy as `gerbang-api` and its store — hence the signed, committed approval record and the GitHub backstops below.

### Option A2: GitHub-native org gates (deferred)
| Dimension | Assessment |
|---|---|
| Complexity | Low in-app — GitHub does identity, review, and SoD by construction |
| Cost | Blocked on an org + SAML SSO + ≥3 named approvers; none exist today |
| Team familiarity | Med — it is what 0001 §8 designed, but it was never stood up |

**Pros:** Approvals are real GitHub reviews by real identities; no new security-critical store; auditable by construction.
**Cons:** Every precondition is missing and contradicts the locked concept; unbuildable on a personal repo. **Deferred, not rejected** — revisit if we move to a GitHub org with enough enrolled humans.

## Consequences
- **The in-app approval record must be committed into the PR** so git history retains tamper-evident who-approved despite `gerbang-bot` being the committer everywhere: (a) commit trailers `Request-Id` / `Requested-By` / `Approved-By`; (b) a machine-readable fenced JSON block in the PR body (`{request_id, requester, approvals[], risk, approvals_required}`); (c) a KMS-signed approval attestation verifiable independently of Gerbang's store.
- **The prod GitHub Environment required-reviewer click stays** and is satisfied for now by the repo owner on personal GitHub. Two layers: Gerbang approvals gate the merge, GitHub gates the apply — per ACCT-13's option (A), at the cost of one extra click per change.
- **A plan-digest guard binds "plan reviewed = plan applied":** sha256 of normalized plan JSON published as a commit status at review time; the apply job recomputes on its re-plan and hard-fails on mismatch, with stale approvals dismissed on push (0005 Phase 2.5).
- **`gerbang-config` becomes security-critical.** As the authoritative approval store it needs backup/DR, PITR, an RPO/RTO target, and a degraded-mode procedure — owned by [0005 Phase 8](../proposals/0005-gerbang-v2-architecture-reassessment.md), not treated as cleanup.
- Harder: until a second approver is enrolled, quorum for HIGH/Delete changes is infeasible — governed by the single-approver interim profile in [ADR-0009](0009-gerbang-approver-quorum.md) (link label fixed 2026-07-17; it previously said "ADR-0006").
- Revisit: on any move to a GitHub org with SSO and ≥3 approvers, re-evaluate Fork A2; nothing here depends on org-only constructs, so the migration path is open in both directions.

## Action items
1. [ ] Amend CONCEPT.md's flow section (one sentence) to record that the prod Environment click remains (ACCT-13 acceptance).
2. [ ] Implement commit trailers + PR-body JSON in the bot's PR-opening path; add the KMS-signed attestation when `gerbang-api` lands.
3. [ ] Implement the plan-digest guard in `terraform.yml` and enable dismiss-stale-approvals-on-push (0005 Phase 2.5, finding ACCT-2/ADV-5).
4. [ ] Prepend the superseded banner to 0001 §8 (exact text in [coherence.md](../proposals/0005-appendix/coherence.md) step 2).
5. [ ] Open the `gerbang-config` backup/DR work item under the 0005 Phase 8 track.
