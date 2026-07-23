# ADR-0019: Day-zero threat model — who could seize control before governance exists, and how the seal + quorum close that window

**Status:** Proposed (owner acceptance = merging the governance-birth PR; the analysis binds
the build via the named contract tests below)
**Date:** 2026-07-22
**Deciders:** repo owner
**Design:** [spec 2026-07-21](../superpowers/specs/2026-07-21-ccp-bootstrap-lifecycle.md)
§4 (proof), §3.5 (seal), §14 (assert-and-test list) · **Companions:**
[ADR-0017](0017-ccp-bootstrap-lifecycle.md) (the lifecycle) ·
[ADR-0018](0018-ccp-founding-quorum.md) (the quorum that ends the window) ·
**Prior evidence:** [proposal 0021](../proposals/0021-second-approver-enablement.md) §0
(steady-state SoD verification; the ADV-3 residual this ADR inherits knowingly).

## Context

Steady state is verified: no single account can complete a privileged change alone
(`SELF_ACK` `domain/dualControl.ts:250`; `SELF_APPROVAL` `routes/requests.ts:580,714`; the
TOTP belt `requests.ts:587`; admin≠approver `domain/exposure.ts:61`, ADR-0011). **Before
governance exists, none of that helps** — there is only one human, one account, and a host.
Day zero is therefore the one window in the product's life where "who can seize control" has
a different answer than "nobody alone", and it deserves its own threat model instead of
inheriting the steady-state one by assumption.

"Seize control" here means concretely: end up holding an admin capability or senior approval
role — or a second account that fakes a second human — such that dual-control or the
approval ladder can later be satisfied by fewer real humans than the design intends.

## Decision

Adopt the following threat model and its closure argument as **binding on the founding
build**: each claim below is enforced by a named contract test (spec §13 lane A) or an
explicit accepted residual; a build that cannot keep a claim must come back to this ADR, not
quietly narrow it.

### The windows

| Window | State | Today (grant-admin era) | Under ADR-0017 |
|---|---|---|---|
| **W0** | install → founder's first login | one-time password live (stdout, once); no 2FA enrolled yet | identical — F1 kept: first login forces password rotation + TOTP enrolment (`routes/auth.ts:119-140`) before anything else |
| **W1** | founder active, second human not yet real | **open-ended**: the trap era; escape = host shell + `grant-admin.ts` on demand, powers implicit | **bounded + self-terminating**: founding verbs can only seat install-pinned principals; state loud (`/readyz`, portal chip); ends automatically at quorum ([ADR-0018](0018-ccp-founding-quorum.md)) |
| **W2** | quorum complete, seal not yet committed (crash gap) | n/a (no seal exists) | provably harmless: all declared slots are seated by definition of quorum reachability, so every founding power is an exhausted no-op (`seat`/`replace` refuse on activated slots); next read/boot lazily seals |
| **W3** | post-seal steady state | today's verified steady state | byte-identical steady state + founding endpoints refuse forever (`NOT_IN_FOUNDING`) |

### Actor-by-actor closure

| # | Actor | Could they seize control pre-seal? | What closes it |
|---|---|---|---|
| T1 | **Remote attacker, no credentials** | Needs a session; founding routes sit behind `requireSession + requireAdmin + requireFounding`. The only day-zero secrets are the founder's one-time password (printed once at install, dies at first login — `mustChangePassword`) and seat OTPs (shown once, in-portal, to an authenticated admin over TLS) | Unchanged auth surface (lockout, argon2id, cookies, CSRF — 0021 §0.1); founding adds **no** unauthenticated mutating surface; `/readyz.founding` deliberately exposes state only, no usernames |
| T2 | **Authenticated non-admin** (e.g. a seated requester principal) | Founding verbs refuse (`requireAdmin`); steady-state self-elevation is already dual-controlled and remains byte-identical | P1 bounds + untouched enforcement sites (spec §14 empty-diff evidence) |
| T3 | **The founder — malicious or coerced** (the central actor) | Cannot approve own requests, cannot self-ack (unchanged). Founding verbs let them seat **only** the principals pinned in the declaration, verbatim — no verb exists to add an account, widen a role, or grant admin outside the declaration (request bodies carry no authorization fields; handlers copy from `FoundingItem`) | **P1** bounded action set, pinned by `founding.bounds.test.ts` (smuggling refusals + closed route inventory). Residual R1 below is the honest remainder |
| T4 | **Host / root** | Can edit the store file directly — full control, today as after (that is precisely what `grant-admin.ts` does, sanctioned) | **Out of the trust boundary, explicitly (P5)** — unchanged in width, made *louder*: sentinel + hash chain + `verifyChain` on `/readyz`; and the *need* for host access narrows to a one-time declaration (vs. an on-demand privilege writer) |
| T5 | **Backup/restore operator (rollback)** | Restore a pre-seal snapshot ⇒ founding reopens with its powers | **P3**: the boot sentinel (`founding.sealed` beside the data file, `server.ts:66-77` pattern) makes a sealed host refuse to start on an unsealed store; reopening requires deliberately deleting the sentinel — a loud, documented host act of the same class as deleting the store to re-bootstrap. Sentinel-less sealed stores stay sealed (the item is authoritative; the sentinel only hardens rollback) |
| T6 | **Concurrent racer** (founding action vs. seal) | A founding write landing after the seal would extend founding powers past birth | Every founding-flagged transact guards `ifEquals {status:'founding'}` on the `FOUNDING` item; chain-head serialization totally orders the seal — the racer either serializes before it or fails (**P4**: "foundingPhase ⇒ pre-seal" is store-enforced, not best-effort) |
| T7 | **Declaration supply chain** | Whoever writes the declaration decides who can ever be seated | **P2**: exactly two writers, both at install-boundary trust — first boot via ephemeral `CCP_FOUNDING` (refused once any account or data file exists: `bootstrap.ts:21-25` + `server.ts:66-77`, unchanged double guard) and `found.ts declare` on legacy stores (`--pr` reviewed-PR doctrine carried over from `grant-admin.ts`; refuses if a `FOUNDING` item exists). No API route creates or widens a declaration beyond the two in-founding verbs, which re-validate the whole declaration |
| T8 | **v1 migration** (`routes/migrate.ts`) | Import a directory containing extra admins — accounts beyond the declaration | An **unchanged, pre-existing** surface, not a founding verb: admin-gated and hard-bounded to the single-account store (`migrate.ts:59-60`), so it runs only before any seat. P1's "declared principals only" claim is scoped to the *founding verbs*; migration is the one other day-zero account source, exactly as today — and under the lifecycle its completion **seals immediately** if the imported directory satisfies quorum, closing W1 rather than extending it. Residual = R5 |

### The seal's irreversibility (what "sealed" is worth)

1. **No writer exists** for `sealed → 'founding'` — single writer module
   (`domain/founding.ts`), seal transaction guarded `ifEquals status:'founding'`, pinned by
   `founding.seal.test.ts`'s writer inventory ("no sealed→founding transition exists").
2. **Rollback fails closed** at boot (T5's sentinel).
3. **Tamper evidence**: the `founding-sealed` entry is inside the hash chain
   (`domain/audit.ts:77-81`); stripping it breaks `verifyChain` on every `/readyz` probe.
   The seal does not claim to stop root (T4); it claims no in-app, in-API, or
   sanctioned-script path reopens founding, and that out-of-band edits are strictly louder
   than today.

### Residual-risk register (accepted, each with its today-equivalence)

| # | Residual | Today-equivalence | Compensating control |
|---|---|---|---|
| R1 | **Founder puppetry**: one human declares two principals and operates both credentials — the declaration is a *claim* of two humans, not a biometric proof | Identical to today: one human can run `grant-admin.ts` against a puppet account whose password they set, and to the standing two-colluding-admins residual (0021 §0.1 ADV-3) | The declaration makes the two-humans claim **explicit, pinned at install, and auditable**; the `foundingPhase` partition + access review reconcile every founding principal to a named human (runbook hard rule 1 stays procedural law) |
| R2 | Host root rewrites the store | Identical (grant-admin *is* a sanctioned store write) | Sentinel + chain + `/readyz`; narrower *need* for host access |
| R3 | One-time-password interception in delivery | Identical (runbook Phase 1) | Shown once; `mustChangePassword` kills it at first use; delivery-channel rule (runbook hard rule 2) mirrored in founding UI copy |
| R4 | An **evaluation-mode** instance has no quorum to seize — and no governance either | New honesty, not new risk: today the same instance exists but *looks* governed | The mode is named everywhere (chip, walls, `/readyz`); zero enforcement relaxation ([ADR-0017](0017-ccp-bootstrap-lifecycle.md)); solo-approval relaxation is the registered not-taken choice (spec §15 #1) |
| R5 | Founder migrate-imports a puppet directory | Identical surface, byte-unchanged | Single-account guard; immediate seal on quorum; imported accounts land on the chain like any other |

## Consequences

- Easier: "is day zero safe?" becomes a finite checklist — the four proof obligations
  (P1 bounds, P2 anchoring, P3 seal, P4 evidence) + this residual register, each mapped to
  a named test or an accepted line; security review of the build diffs against this ADR
  instead of re-deriving the model.
- Harder: the contract tests are now load-bearing security controls — weakening
  `founding.seal.test.ts` / `founding.bounds.test.ts` is a security decision, not a test
  cleanup (fixtures-are-law rule applies with teeth); any new founding verb or new
  declaration writer **must** return to this ADR first.
- The window comparison is the deletion justification for `grant-admin.ts`
  ([ADR-0017](0017-ccp-bootstrap-lifecycle.md)): founding is strictly narrower — pinned
  targets vs. any activated account chosen at run time, self-terminating vs. open-ended,
  in-product-loud vs. runbook-hidden.
- Data-plane birth surfaces (the one-time boot settlement, the reserved neutral `@control`
  scope) carry their own threat analysis in the parallel ADRs 0020–0022; this ADR covers
  the governance plane only and takes no dependency on their text.

## Action items
1. [ ] Lane A lands `founding.seal.test.ts` (atomicity, idempotence, contention, writer
       inventory, sentinel rollback refusal, `kill -9` survival via `restart-survival.ts`)
       and `founding.bounds.test.ts` (closed verb set, smuggled-authorization refusals) —
       green before `grant-admin.ts` is deleted.
2. [ ] `founding.migration.test.ts` pins T8: retro-seal at ≥2 admins; no auto-declaration at
       1 admin; migrate-triggered seal.
3. [ ] Owner reviews and signs the residual-risk register R1–R5 (esp. R1: the two-humans
       claim stays procedural, as today).
4. [ ] Security-review checklist for the build PRs: empty diff on every spec §14
       enforcement site; no new unauthenticated surface beyond `/readyz.founding` (state
       only, no usernames).
