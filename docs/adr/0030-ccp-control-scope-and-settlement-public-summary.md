# ADR-0030: Retire the hardcoded default project id; reserve a dedicated scope for the control plane's own routing and audit (public summary)

**Status:** Accepted — enacted
**Date:** 2026-07-22
**Deciders:** repo owner
**Note:** This is a generic public restatement of a decision originally recorded privately
(this deployment's ADR-0021), whose title literally named a real customer's project
code-name as the hardcoded default being retired. Naming that code-name is the entire
subject of that original decision, so redacting it in place would falsify what was
decided — the private original therefore stays private and unedited (see
`scripts/split/public-excludes.txt`) rather than being rewritten. The decision substance
below is unchanged from that original; only the identifying detail is generalized.
Companion: [ADR-0029](0029-ccp-data-birth-blank-install-public-summary.md).

## Context

A blank install ([ADR-0029](0029-ccp-data-birth-blank-install-public-summary.md)) has
no estate at all when it first boots — but the control plane still has to route
header-less requests somewhere and file its own audit trail somewhere. Before this
decision, one specific customer project's id secretly played two roles at once: an
ordinary, registrable estate identifier, *and* the control plane's own implicit default
scope. That collision had real consequences: the control plane's own housekeeping
(account enrolment, login, registry lifecycle) was filed on the audit trail under one
tenant's name instead of its own; and, more fundamentally, a blank install with no
reserved scope at all could not route a single request, because the request-routing
middleware refused every project id that wasn't already in a known set.

## Decision

A reserved scope id, `@control`, deliberately placed outside the normal project-id
grammar — the same trick an existing `'*'` all-projects wildcard already uses — so
collision with a real, registrable project id is impossible by construction and no
reserved-word list ever needs to be maintained. A header-less request now defaults to
this control-plane scope, never an implicit estate, and the control plane's own audit
trail is filed on its own partition, never a tenant's. A one-time, idempotent boot
settlement retro-registers any real legacy footprint that predates this change (a store
that really was already running as that hardcoded default), so upgrading an
already-running deployment is safe and requires no manual migration step.

## Options considered

### Option A: A reserved, out-of-grammar scope id (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low — one constant, a handful of call sites already keyed off the old hardcoded default |
| Cost | None beyond the seam itself; no reserved-word registry to maintain |
| Team familiarity | High — identical trick to the existing all-projects wildcard |

**Pros:** collision with a real project id is impossible *by construction* (the reserved
id can never satisfy the project-id grammar), so there is no reserved-name list to keep in
sync forever, and nothing breaks if an operator someday wants a project literally named
"control."
**Cons:** a genuinely new concept — a scope that is routable but is not itself a project —
that every future contributor touching authorization must learn.

### Option B: An in-grammar reserved word with an explicit reserved-ids list
**Pros:** stays inside the existing id shape, so validation code needs no special case for
the scope constant itself.
**Cons:** requires a reserved-ids list checked at every registration path, forever, and a
real operator could plausibly want that exact word as a project slug some day — an
avoidable future collision. Rejected.

### Option C: Keep the hardcoded default as the permanent control-plane scope (status quo)
**Pros:** zero migration, no settlement needed.
**Cons:** this is exactly the defect this decision retires — it conflates one estate's
identity with the control plane's own identity permanently. Rejected.

## Consequences

- **Easier:** the control plane's own audit trail is now filed under its own name, not a
  tenant's; the reserved scope is provably never a valid request/approval/catalog scope;
  a legacy store settles automatically and idempotently on first boot of the new code,
  with no manual migration script an operator must remember to run.
- **Harder:** an already-running deployment that settles now carries two chains of
  control-plane history — the historical entries filed under its old hardcoded default,
  and the new entries filed under the reserved scope — so a reader (or an audit-export
  tool) must know to check both for the full control-plane story on such an instance.
- **Revisit:** whether to run a full onboarding trust ceremony retroactively over an
  already-running deployment's legacy estate — rather than leaving it honestly
  trust-less-with-a-marker, which is what the automatic settlement does today — is an
  explicit open decision for that deployment's own operator, not required by this
  decision.

## Action items

1. [x] Drop the hardcoded default project id; add the reserved control-plane scope
   constant; the known-routable set is computed store-only.
2. [x] Header-less requests default to the reserved control-plane scope; estate-only
   surfaces (requests, approvals, catalog/inventory reads) refuse it with a distinct
   error, separate from "you're not bound to this project."
3. [x] The legacy bare-account-row fallback no longer manufactures a binding onto anyone's
   estate — it now resolves to "member of nothing" rather than a specific tenant.
4. [x] One-time boot settlement implemented: retro-register any real legacy footprint plus
   bare-row materialization, run at boot and lazily per-request, guarded by an idempotency
   marker; idempotency, restart-survival, and equivalence with the prior behavior all
   proven by test.
5. [x] Readiness/health reporting verifies the control-plane scope's own audit chain and
   reports an estate count that excludes it.
6. [ ] Open: decide whether to run the full onboarding trust ceremony retroactively over
   an already-running deployment's own legacy estate (deferred to that deployment's own
   operator).
