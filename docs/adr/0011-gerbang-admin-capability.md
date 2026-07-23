# ADR-0011: Admin as a grantable capability, not a role

**Status:** Accepted — the Consequences "Interim" fallback and action item 4 (config-as-code
/ `grant-admin.ts` while a single admin exists) are superseded in part by
[ADR-0017](0017-ccp-bootstrap-lifecycle.md) (proposed 2026-07-22; the fallback remains
the sanctioned path until the founding build ships). The core decision — admin is a
capability — stands untouched.
**Date:** 2026-07-10
**Deciders:** repo owner

## Context
The locked [PRD](../../PRD.md) roles table (originally gerbang/CONCEPT.md lines 14–18) defines exactly three roles — Requester, Approver, Lead — with Lead = "approve and see the audit dashboard", and [gerbang/BUILD-PLAN.md](../../ccp/docs/history/BUILD-PLAN.md) (line 13) types the union accordingly, planning no admin screens. The built SPA kept the 3-role type but shipped a full admin console (users, teams, risk overrides, approval policy) gated on `isLead` (`AppShell.tsx:22`; `policy.ts` line 5: "Editable by a Lead"). Every Lead thus silently became the "highest-privilege admin" that CONCEPT.md R7 asks for — including the power to edit the very approval policy they approve under. That is the confirmed governance trap [ADMIN-3](../proposals/0005-appendix/admin-backend.md) (critical: a single Lead can unilaterally collapse the quorum), the contradiction [COHER-8](../proposals/0005-appendix/coherence.md), and the open decision [ADMIN-9](../proposals/0005-appendix/admin-backend.md). With `gerbang-api` now authoritative ([0005-gerbang-approval-authority.md](0005-gerbang-approval-authority.md)), whoever holds admin holds the keys to quorum itself — so governance power must be separable from approval power without breaking the 3-role lock. Full rationale: [0005 reassessment](../proposals/0005-gerbang-v2-architecture-reassessment.md), §6 recommendation 3 "Admin-as-capability".

## Decision
Add `isAdmin: boolean` to the account, separate from the `requester | approver | lead` Role union (which stays exactly three). Gate `/admin` and all `gerbang-api` admin routes on `isAdmin`, never on `role === 'lead'`. The seed Lead gets `isAdmin = true`. Granting or revoking `isAdmin` is itself a privilege-affecting config change and routes through dual-control (a second admin's ack) once `gerbang-api` exists. This supersedes the built app's Lead-as-admin gate (`AppShell.tsx:22`) and resolves ADMIN-9 and COHER-8; CONCEPT.md's roles table stays locked, gaining only a footnote pointing here.

## Options considered

### Option A: Lead-as-admin status quo
| Dimension | Assessment |
|---|---|
| Complexity | Low — nothing to change; it is what the app ships today |
| Cost | The policy-editor is automatically an approver: ADMIN-3's self-governance risk stays structural |
| Team familiarity | High — current code and mental model |

**Pros:** Zero churn; one fewer concept to explain.
**Cons:** Conflates governance power with approval power — a Lead can lower `deleteMin` and then approve under the loosened policy; contradicts the locked 3-role table's Lead definition; no way to give someone policy stewardship without also making them an approver.

### Option B: `isAdmin` capability flag (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low — one boolean on the account, one gate swap, permissions tests |
| Cost | One more axis to audit (role × capability), and grants need dual-control plumbing |
| Team familiarity | High — same three roles everyone knows; admin is an explicit grant |

**Pros:** Separation of governance from approval power (the ADMIN-3 fix has a locus: the capability, not a role); the 3-role lock survives untouched; a policy steward need not be an approver, and an approver need not see `/admin`; grant/revoke is a discrete, auditable, dual-controlled event.
**Cons:** Capability flags can proliferate if undisciplined (this ADR authorizes exactly one); a Lead-without-admin may be surprised `/admin` is gone — the UI must say why, not just 403.

### Option C: 4th `admin` role in the Role union
| Dimension | Assessment |
|---|---|
| Complexity | Med — union change ripples through permissions, RoleGate, tests, seeds, UI copy |
| Cost | Breaks the locked 3-role table; anyone needing approve + govern needs two accounts or role juggling |
| Team familiarity | Low — new role to teach and document |

**Pros:** Cleanest-looking SoD on paper; matches a literal reading of R7's "highest-privilege admins".
**Cons:** More churn for the same enforcement; still couples the axes (a role is exclusive — admin-who-approves is unexpressible); contradicts CONCEPT.md's lock, which the reassessment treats as binding.

## Consequences
- Easier: ADMIN-3's dual-control design ([0005 reassessment](../proposals/0005-gerbang-v2-architecture-reassessment.md) §5 item 6) has a clean subject — `isAdmin` grants are just another `PendingConfigChange`; the policy editor and the approver pool can finally be different people; ADRs 0005/0006's "lead-only enrollment" language tightens to "admin-only enrollment".
- Harder: authorization checks now consult role AND capability — `permissions.ts` and its tests must cover the four Lead×admin combinations; audit events must record capability grants distinctly from role changes.
- Interim: while exactly one admin exists, dual-control on `isAdmin` grants is infeasible in-app; per reassessment §5 item 6 the grant falls back to a config-as-code PR through branch protection, and the single-approver interim profile's elevated logging applies.
- Revisit: if capability flags multiply beyond `isAdmin`, replace flags with a proper permission model; on org migration ([0006-gerbang-local-identity.md](0006-gerbang-local-identity.md)), decide whether `isAdmin` maps to an IdP group.

## Action items
1. [ ] Add `isAdmin: boolean` (default false) to the account type; seed Lead gets `true`.
2. [ ] Swap the `/admin` entry gate from `isLead` (`AppShell.tsx:22`) to `isAdmin`; show an explanatory message, not a bare 403, to Leads without it.
3. [ ] Gate all `gerbang-api` `/admin/*` routes on `isAdmin` server-side (per [0005-gerbang-approval-authority.md](0005-gerbang-approval-authority.md), never trust the SPA).
4. [ ] Route `isAdmin` grant/revoke through the ADMIN-3 dual-control path; config-as-code PR fallback while a single admin exists.
5. [ ] Update `permissions.test.ts` for the Lead×admin matrix; emit distinct audit events for capability grants.
6. [ ] Add the CONCEPT.md roles-table footnote referencing this ADR (roles unchanged; admin is a capability).
