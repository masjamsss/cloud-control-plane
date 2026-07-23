# ADR-0018: The founding quorum — ≥2 founding-complete admins AND ≥2 founding-complete seniors

**Status:** Proposed (owner acceptance = merging the governance-birth PR)
**Date:** 2026-07-22
**Deciders:** repo owner
**Design:** [spec 2026-07-21](../superpowers/specs/2026-07-21-ccp-bootstrap-lifecycle.md)
§3.4 · **Companions:** [ADR-0017](0017-ccp-bootstrap-lifecycle.md) (the lifecycle this
predicate seals) · [ADR-0019](0019-ccp-day-zero-threat-model.md) (why the predicate is
attack-relevant). **Evidence base:**
[proposal 0021](../proposals/0021-second-approver-enablement.md) §0/F2 (the SoD verification
and the minted-account lesson) · [ADR-0013](0013-ccp-approval-ladder-2fa.md) (the ladder
this quorum must make satisfiable).

## Context

[ADR-0017](0017-ccp-bootstrap-lifecycle.md) makes founding a phase that **seals itself**
the instant "governance exists". That puts the entire weight of the design on one predicate:
*what, exactly, counts as governance existing?* Get it too loose and the door closes while
dual-control is still infeasible (re-creating today's trap behind a sealed door, permanently);
too tight and instances linger unsealed, keeping founding powers alive longer than needed
([ADR-0019](0019-ccp-day-zero-threat-model.md)'s window).

The two independent liveness needs, from the enforcement sites themselves:

- **Governance liveness** — a loosening `PendingConfigChange` needs an acker who is an
  *active admin distinct from the proposer* (`domain/dualControl.ts:250` `SELF_ACK`). One
  admin ⇒ permanently infeasible; **two** active admins is the minimum at which every
  loosening change has a possible acker.
- **Approval liveness** — a request needs senior sign-off by non-requesters
  (`routes/requests.ts:580,714` `SELF_APPROVAL`; roles per `canSignStep`,
  `requests.ts:609`), and admin deliberately confers no approval capacity at all
  (ADR-0011; `domain/exposure.ts:61`). **Two** seniors is the minimum at which a request
  raised by a third account has a full L2→L3 ladder available.

Proposal 0021's finding **F2** supplies the hard-won lesson on *counting*: the shipped
eligible-approver count once included minted-but-never-activated accounts, silently flipping
enforcement mode estate-wide the moment a row was created — before any human owned the
credential. A birth predicate that counts paper accounts would let a lone founder mint a dead
second admin and seal the instance into permanent `SELF_ACK` infeasibility.

## Decision

An account is **founding-complete** iff

```
status === 'active'
∧ mustChangePassword === false                       // the human owns their password
∧ (totp !== undefined ∨ needsTotp(account) === false) // second factor satisfied per the
                                                      // account's EFFECTIVE requirement
                                                      // (auth/totp.ts:67 — the one source of truth)
```

**Quorum holds** — and the [ADR-0017](0017-ccp-bootstrap-lifecycle.md) seal fires — iff

```
|{ a : founding-complete(a) ∧ a.isAdmin }| ≥ 2
∧ |{ a : founding-complete(a) ∧ isSeniorAnywhere(a) }| ≥ 2   // projects.ts:133
```

Binding clauses:

1. **Only founding-complete accounts count** (the F2 lesson made constitutional): a seated
   slot changes nothing until its human has activated — password owned, effective second
   factor satisfied. The seal fires only when a second human can *actually operate* the
   controls, never on paper headcount.
2. **The same person may satisfy both sets** — the **2-human compact** (two humans, each
   lead + admin) is explicitly allowed. It is the documented reality of the enrolment
   runbook and the smallest deployment the product promises to govern. Operators wanting
   ≥3 humans or admin∩senior disjointness take spec §15 knob 3 (its own ADR if ever taken).
3. **The predicate is enforced by construction at declaration time**: a `mode:'quorum'`
   declaration is refused at PROVISION unless its principals, once activated, satisfy this
   predicate (spec §3.2) — so the seal is *reachable* on every non-evaluation install, and
   in-founding `replace`/`upgrade` re-validate the whole declaration against the same rule.
4. **2FA counts via `needsTotp`, not raw enrolment**: an account whose *effective*
   requirement is satisfied counts. This keeps exactly today's semantics for the
   admin-set `totpRequired:false` exemption (ADR-0013 item 4) — an exempted principal
   counts without a second factor. Deliberately consistent, deliberately surfaced: spec §15
   knob 4 records the tightening (refuse exemptions for founding principals) as an operator
   choice not taken here.

## What the predicate guarantees — and, honestly, what it does not

Guaranteed at the instant of seal, by construction:

- **Every loosening change has a possible acker** (2 active admins, `SELF_ACK` satisfiable;
  the single-admin permanent-infeasibility trap cannot exist behind the seal).
- **Approval is live**: an L2-only (self_service) ladder is satisfiable by either of the
  two founding-complete seniors for any third-party request. In the minimal two-admin
  declaration (the common case) the founder — principal 1, always admin, bound
  lead-on-`'*'` (spec §3.2, mirroring `bootstrap.ts:37,42`) — is necessarily
  founding-complete at seal, so the full L2→L3 ladder is satisfiable for requests raised
  by a third account.
- **Recovery from the loss of one human** is a governed operation, not a trap: with 2
  admins, enrolling a replacement is an ackable pending change.

Deliberately **not** guaranteed, stated so the owner accepts the same boundary the current
system has (no regression, no silent promise):

- **A riskier (L2→L3) request raised *by one of the two seniors themselves* needs a third
  account**: ladder signatures must be distinct people and exclude the requester
  (`requests.ts:580` + the whole-ladder dedup), so in the 2-human compact such requests are
  raised by a requester account that is neither senior — exactly the runbook's existing
  `R`-actor pattern. The quorum makes governance *possible*, not every workflow
  self-service for two people.
- **The seal does not wait for an L3 lead beyond the founder** in >2-principal
  declarations: quorum could complete via two non-lead-role admins plus seniors while the
  founder (the guaranteed lead) is not yet founding-complete. Feasibility surfacing
  (`GET /requests/:id/feasibility`) already names such gaps at request time; the predicate
  does not try to encode every ladder shape.
- **No time bound**: quorum is a state predicate, not a deadline. Founding age is surfaced
  loudly (spec §15 knob 2) rather than enforced — a TTL is an operator choice needing its
  own ADR.

## Consequences

- Easier: "is this instance born?" is one mechanical predicate over the account table —
  testable, displayable (the founding screen's quorum readout), and the same rule at
  declaration validation, seal check, and legacy `found.ts declare`.
- Harder: the build must compute founding-complete from the same helpers the enforcement
  uses (`needsTotp`, `isSeniorAnywhere`) — a parallel reimplementation is how F2 happened;
  lane A's tests must pin equivalence.
- Evaluation mode (`mode:'evaluation'`, [ADR-0017](0017-ccp-bootstrap-lifecycle.md))
  is precisely "quorum deliberately not declared": one principal, seal unreachable until
  upgraded — the predicate is what makes that mode honest rather than broken.
- Where the data-plane birth needs a governance precondition (settlement ordering,
  `@control` scope), it references this predicate through ADRs 0020–0022 (parallel lane,
  by number only).

## Action items
1. [ ] Lane A implements founding-complete exactly via `needsTotp`/`isSeniorAnywhere`
       (shared helpers, no re-derivation) with tests pinning the F2 case: a seated,
       never-activated slot never counts and never seals.
2. [ ] Declaration validation (spec §3.2) refuses any quorum declaration whose principals
       cannot satisfy this predicate; `replace`/`upgrade` re-validate.
3. [ ] Owner confirms knobs 3 and 4 (minimum-humans floor; founding 2FA-exemption pinning)
       stay open-not-taken, or commissions their ADRs.
