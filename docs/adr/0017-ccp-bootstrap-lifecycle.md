# ADR-0017: Bootstrap is a lifecycle — PROVISION → FOUND (sealed) → GOVERN

**Status:** Proposed (owner acceptance = merging the governance-birth PR; until the build
ships, `grant-admin.ts` remains the sanctioned day-zero path)
**Date:** 2026-07-22
**Deciders:** repo owner
**Design:** [spec 2026-07-21 — CCP bootstrap lifecycle](../superpowers/specs/2026-07-21-ccp-bootstrap-lifecycle.md)
(the governing design; this ADR records the decision, the spec carries the mechanics)
**Extends:** [ADR-0011](0011-gerbang-admin-capability.md) (admin as capability — untouched) ·
[ADR-0013](0013-ccp-approval-ladder-2fa.md) (ladder + 2FA — untouched)
**Supersedes (in part):** ADR-0011's Consequences "Interim" clause and action item 4 (the
config-as-code / `grant-admin.ts` fallback for the single-admin window — replaced by the
founding phase below). **Companions:** [ADR-0018](0018-ccp-founding-quorum.md) (the quorum
predicate) · [ADR-0019](0019-ccp-day-zero-threat-model.md) (the day-zero threat model).
**Numbering note:** 0017–0019 are this governance-birth set; **0020–0022 are reserved by the
parallel data-birth lane** (the one-time boot settlement and the reserved neutral `@control`
scope live there — referenced by number only, no dependency on their text).

## Context

CCP models governance as a **steady-state property**: every control assumes a quorum of
admins and seniors already exists. Dual-control needs a second distinct admin
(`domain/dualControl.ts:250` `SELF_ACK`); approval needs a non-requester senior
(`routes/requests.ts:580,714` `SELF_APPROVAL`); admin confers no approval capacity
(`domain/exposure.ts:61`, ADR-0011); every senior/admin session demands a second factor
(`auth/totp.ts:67-70` `needsTotp`). The system has **no concept of birth**: first boot seeds
exactly one over-privileged account (`ccp/api/scripts/bootstrap.ts:27,37,42` — `putra`,
lead-on-`'*'` + `isAdmin`) straight into those steady-state rules, and every day-zero wall is
a symptom — 2FA demanded before the one-time password is even rotated
(`routes/auth.ts:119-140`), every loosening proposal by the lone admin permanently un-ackable
and dead at 72 h, no request the founder submits ever approvable, and the sanctioned way out
an offline incantation: `npx tsx scripts/grant-admin.ts --username <id> --pr <ref>` on the
host, discoverable only via runbook
[second-approver-enrolment.md](../runbooks/second-approver-enrolment.md) Phase 3.

`grant-admin.ts` is **already a bootstrap bypass** — a host-side script that flips `isAdmin`
outside every in-app control. It is narrow (refuses at ≥2 active admins,
`grant-admin.ts:76-83`), audited (`transactWithAudit`, `interimProfile:true`), and
attribution-gated (`--pr`, reviewed-PR doctrine) — but it is *hidden*: invisible in-product,
its authority ("someone with a shell on the host") implicit rather than designed. The system
has a birth hatch today; it is just undeclared and ugly.

## Decision

Reconceive day zero as an explicit lifecycle with sealed, irreversible transitions:

1. **PROVISION** — at the install boundary (host/root, the trust that already owns the store
   file and `CCP_TOTP_KEY`), the operator **declares the founding quorum**: at least two
   named founding admins — or explicitly chooses solo **evaluation mode**. The declaration
   is data written at first boot (ephemeral `CCP_FOUNDING`, the `CCP_BOOTSTRAP`
   pattern); it fabricates no second person's credential. A fresh install **refuses to boot
   without a declaration** — no silent default.
2. **FOUND** — a named first-run state (`FoundingItem`, a global store item, single
   authority on lifecycle state) in which the founder **seats** the declared principals
   in-portal: each slot materialized verbatim from the declaration, one-time password shown
   once, each human then owning their password + 2FA exactly as today. The founding action
   set is **closed** (seat / replace-unactivated / evaluation-upgrade / read — spec §3.6);
   every founding action is audited with a hash-covered `foundingPhase` marker whose
   store-level guard (`ifEquals status:'founding'`) makes "flag ⇒ pre-seal" an invariant.
3. **The founding seal** — the phase **seals itself automatically and irreversibly** the
   instant the quorum predicate of [ADR-0018](0018-ccp-founding-quorum.md) holds. Sealing
   is never an endpoint and never a human act: one atomic transaction
   (`status: 'founding' → 'sealed'`, guarded `ifEquals`), a chained `founding-sealed` audit
   entry the item cross-references, and a boot **sentinel file** that makes restoring a
   pre-seal store snapshot fail closed at startup (unsealing requires deliberately deleting
   the sentinel on the host — the same class and loudness of act as deleting the data file to
   re-bootstrap today). No writer of `sealed → 'founding'` exists anywhere, pinned by a
   contract test that inventories writers.
4. **GOVERN** — steady state, **byte-identical to today**. `SELF_ACK`, `SELF_APPROVAL`, the
   TOTP belt (`requests.ts:587`), `canSignStep` (`requests.ts:609`), `needsTotp`, the
   classification table (`dualControl.ts:41-84`), last-admin guards and the 72 h expiry are
   untouched enforcement sites — the build must show an empty diff on them (spec §14).

**Evaluation mode** is part of this decision: a first-class, explicitly-chosen founding mode
(`mode:'evaluation'`, exactly one principal) that *names* the single-person instance instead
of letting it look broken — persistent state chip, labeled walls, `/readyz` field — with
**zero server-side enforcement relaxation**. Leaving it is add-only
(`founding-upgrade` to a real quorum declaration); there is no downgrade path back.

**`grant-admin.ts` is replaced outright.** The successor for legacy stores is
`scripts/found.ts declare` (same host trust, same `--pr` reviewed-PR doctrine — but writing a
bounded *declaration* into the audited, self-sealing founding path instead of an immediate
privilege). Legacy mapping (spec §8): stores with ≥2 active admins are **retro-sealed**
(recorded `mode:'legacy'`, door closed); stores with exactly 1 active admin get **no
auto-declaration** — the operator must name the second human via `found.ts declare`; 0-admin
stores stay dead-to-the-app (restore runbook). `grant-admin.ts` and its tests are deleted in
the build's final tranche; runbook Phase 3 Paths A/B get their superseded-in-part banner **at
that point, not before** — until then the runbook and script remain the sanctioned path.

## Options considered

### Option A: Status quo — hidden hatch + runbook
| Dimension | Assessment |
|---|---|
| Complexity | None now; recurring operator cost at every install |
| Cost | Every new instance re-discovers the walls, then a host-side incantation; birth is evidentially smeared across ordinary `account-*` audit entries |
| Team familiarity | High (it shipped) |

**Pros:** zero churn; grant-admin is narrow, audited, and battle-tested.
**Cons:** the *authority model* is implicit (shell access = birth authority); in-product invisible;
the un-ackable-proposal trap (permanent `SELF_ACK` infeasibility) remains a designed dead
end an operator must hit before learning the escape; no honest name for solo instances.

### Option B: Lifecycle with a sealed founding phase (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Med — one new domain module + route group + store item, installer prompt, app screen (spec §13 lanes A–D) |
| Cost | A real state machine to test (seal atomicity, contention, rollback); migration mapping for legacy stores |
| Team familiarity | The mechanics reuse existing patterns verbatim: `transactWithAudit`, `ifEquals` guards, lazy settlement, boot-refusal sentinels |

**Pros:** birth becomes declared, bounded, audited, self-terminating; the hatch narrows
(seat only install-pinned principals, only while unsealed — vs. grant-admin's any-account
at-any-time-while-<2-admins); the day-zero walls dissolve by *birth order* instead of
enforcement change; audit gains a mechanical birth/steady-state partition.
**Cons:** more moving parts than a script; the seal's irreversibility must be genuinely
proven (that is [ADR-0019](0019-ccp-day-zero-threat-model.md)'s job), and legacy stores
need a mapped story.

### Option C: Relax steady-state rules during day zero (rejected outright)
| Dimension | Assessment |
|---|---|
| Complexity | Low to build, unbounded to trust |
| Cost | A solo-approval / self-ack window is precisely the vulnerability class the product exists to prevent; any relaxation window becomes the attack window |
| Team familiarity | — |

**Pros:** none that survive review. **Cons:** breaks the product's core promise; rejected —
and registered as the not-taken operator choice (spec §15 #1) so it stays visibly not-taken.

## Consequences

- Easier: a fresh install reaches governed steady state entirely in-product after
  `install.sh` exits; day-zero UX walls (F1–F5, spec §5) become explained ceremony steps,
  all **UX-only** — no enforcement site changes; auditors get a one-filter
  (`foundingPhase == true`) birth partition.
- Harder: the seal is new load-bearing machinery — its contract tests
  (`founding.seal.test.ts`, `founding.bounds.test.ts`, `founding.migration.test.ts`, spec
  §13 lane A) are the law before `grant-admin.ts` may be deleted; installers gain a refusal
  path (fresh install without a declaration) that operators must learn.
- ADR-0011 keeps its decision (admin is a capability) in full; only its *interim
  single-admin fallback* (Consequences "Interim", action item 4) is retired — the founding
  phase is the designed replacement for that fallback.
- The manual PR lane and gated apply are unaffected; nothing here touches ADR-0012/0016
  scope. Where the lifecycle meets the data-plane birth (boot settlement, `@control`
  scope), the parallel ADRs 0020–0022 govern — by number, no textual dependency.
- Two-truths discipline: until the build lands, docs must keep describing `grant-admin.ts`
  as the live sanctioned path; the lifecycle is settled *direction*
  (this ADR), not live behavior. Rollout status lives in
  [proposal 0018](../proposals/0018-enablement-deployment-unresolved.md).

## Action items
1. [ ] Build lanes A–D per spec §13 (api domain/routes/seal → installer → app → docs), each
       gate-green; §14's empty-diff evidence on every steady-state enforcement site ships in
       the build PRs.
2. [ ] Delete `grant-admin.ts` + tests only in the final tranche, same commit as the runbook
       Phase 3 superseded-in-part banner and the ADR-0011 status-line note taking effect.
3. [ ] PRD "How an instance is born" paragraph (product language, three phases + evaluation
       mode) — lands with owner acceptance of this ADR, per PRD-wins discipline.
4. [ ] Register build status in proposal 0018 as lanes land (the one live-status home).
