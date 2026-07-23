> SUPERSEDED 2026-07-16 — see PRD.md at the repo root. This document predates the multi-account + auto-apply direction.
> Generalized for publication 2026-07-22; decision substance unchanged.

# ADR-0006: Local Gerbang accounts + one gerbang-bot identity

**Status:** Accepted
**Date:** 2026-07-10
**Deciders:** repo owner

## Context
Gerbang v2 makes `gerbang-api` the authoritative backend: approvals happen in-app and the GitHub pipeline gates become mechanical backstops ([0005-gerbang-approval-authority.md](0005-gerbang-approval-authority.md), Fork A1). Identity must therefore live where enforcement lives. Proposal 0001 assumed the opposite — [§8.1 "Phase -1: the org / SSO reality that must exist before anything ships"](../proposals/0001-gerbang-l1-control-plane.md) made a GitHub org + SAML SSO + SCIM a hard precondition, and that precondition is indefinitely blocked (no org, no IdP, fewer than 3 enrollable approvers). The repo lives on a personal account today (`github.com/masjamsss/cloud-control-plane`) and may move to an org later, so the design must not hard-depend on org-only constructs now, but must not preclude that migration. The locked concept ([gerbang/CONCEPT.md](../../ccp/CONCEPT.md), line 20) already calls for one "Gerbang bot" service account doing all git work. Full evidence: [proposal 0005](../proposals/0005-gerbang-v2-architecture-reassessment.md) and its appendix (`ADMIN-8`, `ACCT-4`, `ADV-10`).

## Decision
Local Gerbang accounts (argon2id — PBKDF2 acceptable only as a fallback where argon2id is unavailable) in `gerbang-api` are the identity system. A single least-privilege **gerbang-bot GitHub App** — `contents` + `pull_requests` write only, present in no approver list, private key held in a server-side secret store (SSM/Secrets Manager), never in the SPA or repo — performs all git operations. Personal GitHub now; org migration stays open.

## Options considered

### Option A: Local accounts + one gerbang-bot App (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Med — auth hardening (argon2id, server sessions, lockout, TOTP) is built once in gerbang-api |
| Cost | Zero licence cost; no org/IdP procurement; one App key to guard |
| Team familiarity | High — plain username/password UX for a mixed L1 team; no GitHub accounts needed for requesters |

**Pros:** Ships now on a personal repo; identity and enforcement live in the same authoritative service; humans never touch git so their credentials can't merge anything; the bot is structurally incapable of approving (not in any approver list, no `administration` or `workflows` scope); GitHub Apps work identically under an org, so migration is a re-install, not a redesign.
**Cons:** Gerbang becomes an identity provider — password reset, lockout, session, and offboarding are now our code and our runbook; no verified corporate identity behind an account (mitigated by lead-only enrollment and the dual-control rules in [0005-gerbang-approval-authority.md](0005-gerbang-approval-authority.md)).

### Option B: GitHub org + SAML SSO + SCIM (0001 §8.1) — deferred
| Dimension | Assessment |
|---|---|
| Complexity | High — org creation, IdP contract, SCIM provisioning, team mapping |
| Cost | GitHub Enterprise + IdP licences; weeks of procurement before the first request ships |
| Team familiarity | Low — no IdP exists today; L1 team has no GitHub accounts |

**Pros:** Verified corporate identities; IdP-driven joiner/mover/leaver; audit ties to HR truth.
**Cons:** Blocked on prerequisites that do not exist and have no arrival date; under Fork A1 the app is authoritative anyway, so SSO would gate the backstop, not the decision point.

## Consequences
- Easier: Gerbang ships now; requesters need no GitHub account; every human act traces to a local account and every git act to exactly one bot; the approver quorum is enforced where identity lives.
- Harder / residual risks, stated explicitly:
  - **Single GitHub owner.** One personal account owns the repo, branch protection, and the App installation. A compromise of that account is a total compromise. Mitigation: hardware-key 2FA on the owner account; revisit at org migration.
  - **The bot key is a crown-jewel.** Anyone holding it can push branches and open PRs as gerbang-bot. Mitigation: branch protection means a stolen token can *open* but never *merge*; key lives only in the server secret store; scope is `contents` + `pull_requests` write, nothing else; rotate on any suspicion.
  - **In-app joiner/mover/leaver replaces IdP offboarding.** Disabling a leaver is a manual Gerbang admin action, not an automatic IdP dropout. Requires an account-lifecycle runbook (enroll, role change, disable, session revocation, periodic access review).
- Revisit: when an org + IdP become available, adopt Option B for login (SSO in front of the same local account records) without changing the bot or the enforcement locus.

## Supersedes
- Proposal 0001 [§8.1 "Phase -1"](../proposals/0001-gerbang-l1-control-plane.md) (org + SAML SSO + SCIM as a hard precondition, ~line 1442) — retired as a blocker; retained as the deferred Option B.

## Action items
1. [ ] Register the gerbang-bot GitHub App on `masjamsss` with `contents` + `pull_requests` write only; install on `cloud-control-plane`; store the private key in SSM/Secrets Manager.
2. [ ] Implement local auth in gerbang-api: argon2id, server sessions (httpOnly, 12h/idle TTL), lockout after 5 failures, forced reset on seeded accounts, TOTP for approver/lead roles.
3. [ ] Verify gerbang-bot appears in no approver list and cannot pass branch protection (attempt a bot-token merge in a drill; expect rejection).
4. [ ] Write the account-lifecycle runbook (enroll / role change / disable / session revocation / quarterly access review) under `docs/runbooks/`.
5. [ ] Document the org-migration path (App re-install, repo transfer, SSO-in-front) so nothing built now precludes it.
