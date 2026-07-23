# ADR-0022: Teams are kept and completed — per-estate teams born at onboarding, `ChangeRequest.teamId` is display-only by contract

**Status:** Accepted — enacted
**Date:** 2026-07-22
**Deciders:** repo owner
**Evidence:** [docs/superpowers/specs/2026-07-21-ccp-data-birth-generic-onboarding.md](../superpowers/specs/2026-07-21-ccp-data-birth-generic-onboarding.md)
§8; branch `claude/data-birth-generic-onboarding`, `ccp/api/scripts/bootstrap.ts`. Companion
to [ADR-0020](0020-ccp-data-birth-blank-install.md) and
[ADR-0021](0021-ccp-control-scope-and-settlement.md) — this ADR is the one place the "remove
teams" premise floated during data-birth planning is formally evaluated and rejected.

## Context

Data-birth planning started from a premise worth checking, not assuming: *"teams are a string
stamped onto requests, wired to nothing."* Evidence gathered in the spec shows that premise is
**half right, and the wrong half to act on**:

- Teams **are** a real, server-enforced authorization gate today — the PRD's *"limited to the
  services their team owns"* is implemented end to end. `canRequest`
  (`ccp/app/src/lib/permissions.ts`) returns true for approvers/leads, else requires the
  requester's team to own the service (`TeamItem.serviceSlugs`); the api imports that **exact**
  function (`routes/requests.ts`) and enforces it per change-set item at submit — 403
  `TEAM_SCOPE` on a miss; the SPA mirrors it in the request form. Single-ownership is
  transactional (`stripFromOthers`, `routes/admin.ts`). Teams are already per-project
  (`teamKey(projectId, id)`, `RoleBinding.teamId`) with full CRUD and audit. This matches
  [PERMISSIONS.md](../../ccp/docs/PERMISSIONS.md) and
  [DOMAIN-MODEL.md](../../ccp/docs/DOMAIN-MODEL.md) as already documented.
- The stamped `ChangeRequest.teamId` (`routes/requests.ts`, mirrored on the drift twins) **is**
  authorization-dead — no gate anywhere reads it back to decide anything — but it is *not*
  unread: the Lead dashboard filters, charts, and CSV-exports by it
  (`ccp/app/src/features/dashboard/LeadDashboard.tsx`). It is display/analytics metadata,
  and a real consumer of it, not dead code to delete.
- The genuinely dead parts were narrower than the original premise: bootstrap's dangling
  `teamId: 'platform'` seed (no `TeamItem` for `platform` was ever created at first boot, and a
  team id is inert for a lead's authorization anyway — `canRequest` bypasses team scoping for
  approvers/leads) and `requestableServices`
  (`ccp/app/src/lib/permissions.ts`, no production consumer found).

Removing the load-bearing half of teams to fix a genuinely dead 3-line seed default would have
been a real product regression dressed as a simplification.

## Decision

**Teams stay the per-estate request-scoping construct.** Data-birth completes them by making
them born **per estate, at onboarding**, rather than assumed to already exist:

- The genuinely dead baked default — `bootstrap.ts` seeding the founding admin's `'*'` binding
  with `teamId: 'platform'`, a team id that never had a matching `TeamItem` anywhere — is
  removed. First boot no longer bakes **any** team id into the founding admin
  (`scripts/bootstrap.ts`: `roles: { '*': { role: 'lead' } }`, no `teamId`).
- The onboarding checklist (first-run screen, [onboarding-runbook.md](../../ccp/docs/onboarding-runbook.md))
  gains "define this account's teams and service ownership" as a step after an estate reaches
  `ready`, using the existing Teams CRUD — no schema migration, no new endpoint: teams were
  never global, so there is nothing to migrate server-side.
- The fail-closed default for an estate with no teams defined yet is already correct and is
  simply documented as intentional, not a gap: approvers/leads bypass team scoping and can
  request anything (`canRequest` returns true for them regardless), while a plain requester with
  no owning team can submit nothing (`canRequest` returns false) — an estate is safely
  request-capable by its seniors from the moment it goes `ready`, and opens up to requesters
  exactly as teams and their service ownership are defined.
- `ChangeRequest.teamId` keeps its status as **display/analytics metadata by contract**, not
  authorization — this is now the documented, intentional shape (this ADR), not an unexamined
  loose end.
- `requestableServices` (`ccp/app/src/lib/permissions.ts`, no production consumer) is **not**
  removed by this change — flagged to [proposal 0018](../proposals/0018-enablement-deployment-unresolved.md)
  as a candidate for a future simplify pass, out of scope here.

## Options considered

### Option A: Keep teams, complete them at onboarding (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low — no schema change; the CRUD, the gate, and the audit trail already exist and are already correct |
| Cost | One doc/checklist addition (onboarding step) plus a 3-line bootstrap fix |
| Team familiarity | High — nothing new to learn; the mental model ("teams own services, scope requests") is unchanged |

**Pros:** preserves a real, tested, PRD-mandated security boundary (PRD: *"limited to the
services their team owns"*); zero server-side migration risk; the Lead dashboard's team-based
filters/exports keep working unchanged.
**Cons:** requires evaluating the original "teams are dead weight" premise carefully enough to
tell its load-bearing half from its genuinely dead half — cheaper to have assumed the premise
and deleted the whole mechanism, and wrong.

### Option B: Remove teams entirely
**Pros:** deletes a mechanism, simplifying the account/role model on its face.
**Cons:** removes a real, server-enforced authorization gate (`TEAM_SCOPE`) with no replacement,
a product regression — requesters would gain the ability to request changes for any service
regardless of ownership, contradicting the PRD directly. Rejected on the evidence in Context,
above.

### Option C: Promote `ChangeRequest.teamId` to authorization-relevant (make some gate read it back)
**Pros:** would make the stamped field "fully wired," closing the display-only asymmetry some
find odd.
**Cons:** not requested by any of this spec's actual defects, changes submit-time semantics for
existing requests/tests with no corresponding product need identified, and the Lead dashboard's
current read (an as-submitted historical record) is arguably *more* correct as pure metadata
than as a live-reevaluated authorization field would be. Rejected as out of scope; not pursued.

## Consequences

- **Easier:** the "teams are dead" question that would otherwise resurface every time someone
  reads `ChangeRequest.teamId` and wonders is now answered once, in one place, with evidence —
  this ADR is that answer, cited by [PERMISSIONS.md](../../ccp/docs/PERMISSIONS.md) and
  [DOMAIN-MODEL.md](../../ccp/docs/DOMAIN-MODEL.md) rather than re-litigated per reader. A
  fresh estate has no phantom team baked in that its own admins never created.
- **Harder:** a freshly onboarded estate is, correctly, request-locked for plain requesters
  until an admin defines at least one team and its service ownership — an extra onboarding step
  operators must be told about (carried in the onboarding runbook's onboarding checklist), not a
  bug.
- **Revisit:** `requestableServices`'s removal is deferred to a future simplify pass (tracked in
  proposal 0018), not decided here.

## Action items
1. [x] Drop the dangling `teamId: 'platform'` bootstrap seed (`scripts/bootstrap.ts`) — first
   boot bakes no team id anywhere.
2. [x] Document `ChangeRequest.teamId` as display/analytics-only by contract (this ADR;
   [PERMISSIONS.md](../../ccp/docs/PERMISSIONS.md) /
   [DOMAIN-MODEL.md](../../ccp/docs/DOMAIN-MODEL.md) carry the pointer).
3. [x] Add "define teams and service ownership" to the onboarding checklist
   ([onboarding-runbook.md](../../ccp/docs/onboarding-runbook.md)).
4. [ ] Future simplify pass: remove `requestableServices` (no production consumer) — registered
   in [proposal 0018](../proposals/0018-enablement-deployment-unresolved.md), not required here.
