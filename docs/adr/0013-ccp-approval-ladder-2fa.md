> PARTIALLY SUPERSEDED 2026-07-22 — see [ADR-0024](0024-ccp-multi-device-totp.md) clause 4.
> Only clause 4's *dormant-secret* sentence below ("Disabling never deletes an enrolled
> secret (it goes dormant...)") is superseded: the secret still survives a `totpRequired`
> downgrade (unchanged), but it no longer goes dormant — an enrolled device is now always
> challenged at login regardless of the pin. Everything else on this page (the ladder, the
> admin-controlled per-user override itself, the typed-confirmation-on-downgrade intent)
> is unaffected and still the live decision.

# ADR-0013: Static two-level approval ladder + admin-controlled per-user 2FA

**Status:** Accepted; clause 4's dormant-secret sentence partially superseded 2026-07-22
by [ADR-0024](0024-ccp-multi-device-totp.md) clause 4 (see banner above)
**Date:** 2026-07-17 (records the owner decisions of 2026-07-15 in
[proposal 0037](../proposals/0037-two-level-approval-and-2fa-control.md))
**Deciders:** repo owner
**Supersedes:** [ADR-0009](0009-gerbang-approver-quorum.md); also the forces-replace
"two leads" rule in proposal 0035 §3.5 and the quorum behaviour described in 0003 §2

## Context

ADR-0009 set a risk-based approver quorum with an interim single-approver profile
(one person could complete a riskier change alone after a 24-hour wait). Proposal 0037
re-examined the model against an MSP-style L1/L2/L3 support structure and found the
quorum arithmetic hard to reason about and the solo path unacceptable; it also found 2FA
was derived purely from role, with no admin control per user.

## Decision

Level ↔ role mapping (fixed): **L1** raises the change (`requester`) · **L2** first
approver (`approver`) · **L3** final approver (`lead`). `isAdmin` stays orthogonal
(ADR-0011) — admin is a capability, never an approval seniority.

1. **Static two-level ladder for riskier changes:** first an L2 approves, then an L3, in
   that strict order. Small, safe changes still need one sign-off. No exposure-based
   quorum arithmetic.
2. **No solo approval:** the requester can never approve their own request, and the
   ADR-0009 interim single-approver exception is retired.
3. **Forces-replace (destroy-and-recreate) follows the same ladder** — not a special
   two-leads rule.
4. **Per-user 2FA, admin-controlled:** a per-account `totpRequired` override; unset means
   the role default (privileged roles require TOTP). An admin may set it on or off for
   any user — turning it **off** for a privileged account is a flagged security downgrade
   requiring an explicit typed confirmation, and is audited either way. Disabling never
   deletes an enrolled secret (it goes dormant; re-enabling never forces re-enrolment).

## Consequences

- Easier: predictable approval routing; an auditable ladder instead of per-request math.
- Harder: riskier changes need both an L2 and an L3 enrolled on the account before they
  can flow; enrolment mechanics live in
  [second-approver-enrolment](../runbooks/second-approver-enrolment.md) (its banner names
  what changed vs. the old model).
- Roles and team are per account; admin stays global (PRD roles table, DECISIONS #6).
- Proposal 0021's exposure-quorum enablement plan is historical.
