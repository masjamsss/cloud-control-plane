# ADR-0024: 2FA becomes a named TOTP device list — shimmed migration from the single secret, and an enrolled factor is always challenged

**Status:** Proposed (build landed on `claude/account-security-build` per the spec:
[account & security center](../superpowers/specs/2026-07-22-ccp-account-security-center.md) —
the owner greenlit the always-challenged rule (clause 4) and the 5-device cap (§13 open
questions 1 and 5) as defaults not to be re-litigated; status flips to Accepted on the
owner's formal word, the same pattern [ADR-0023](0023-ccp-instance-identity.md) uses)
**Date:** 2026-07-22
**Deciders:** repo owner (security posture); design lane `claude/account-security-center-design`
**Supersedes in part:** [ADR-0013](0013-ccp-approval-ladder-2fa.md) — its "disabling
never deletes an enrolled secret (it goes dormant)" clause: the secret still survives a
requirement downgrade, but it no longer goes *dormant* (see Decision, clause 4).

## Context

2FA today is a single optional secret per account: `totp: {secretEnc, enrolledAt}`
(`api/src/store/schema.ts:41,162`), enrolled exactly once at first privileged login
(`routes/auth.ts:127-141,172-191`), AES-256-GCM encrypted behind the `SecretCipher` seam
(`auth/totp.ts:16-54`). There is no second device, no device naming, no self-service
removal — the only exits are the admin's `reset-totp` (`routes/admin.ts:803`) or nothing.
The owner has asked for a self-service account area where a user can "add additional 2FA
device and many more".

Forces:

- **One phone is a single point of lockout.** A lost/wiped authenticator on a privileged
  account means admin intervention (`reset-totp`) — which on a two-human deployment may be
  the *other* human's only admin account, and on a one-admin day may be nobody.
- **`needsTotp` is the one source of truth for the requirement**
  (`auth/totp.ts:67-71`: `totpRequired ?? (isSeniorAnywhere || isAdmin)`), and the pending
  founding build reads enrolment for its founding-complete predicate —
  [ADR-0018](0018-ccp-founding-quorum.md) spells it
  `totp !== undefined ∨ needsTotp(account) === false`. Any shape change must keep exactly
  one enrolment predicate or the quorum arithmetic and the login gate can disagree.
- **Legacy rows must parse unchanged.** The store doctrine is additive-optional fields
  plus a canonicalizing read shim — the `rolesOf` precedent (`schema.ts:99-110`,
  legacy `role`/`teamId`/`projects` folded into `roles` on read, all writes emit the new
  shape). Zero-downtime, idempotent, no migration script.
- **Admin-vs-self boundary:** the admin keeps `reset-totp` (availability recovery) and the
  `totpRequired` pin; self-service must not create a path that weakens either.

## Decision

1. **The account's 2FA state becomes a named device list.** New additive-optional field:

   ```
   totpDevices?: Array<{
     id: string          // ulid, server-minted
     name: string        // user-given, 1–40 chars, trimmed, single-line
     secretEnc: string   // AES-256-GCM via the existing SecretCipher seam
     enrolledAt: string  // ISO
     lastUsedAt?: string // ISO — set on each successful challenge
   }>
   ```

   Cap: **5 devices per account**. The legacy `totp` field stays in the schema so every
   stored row parses.

2. **One read shim, `rolesOf`-style.** A single helper (working name `totpDevicesOf`)
   canonicalizes: `totpDevices` if present, else a legacy `totp` secret presented as one
   device `{id: 'legacy', name: 'Authenticator', secretEnc, enrolledAt}`, else `[]`.
   Every reader — the login challenge, `publicAccount.totpEnrolled`, the founding build's
   founding-complete predicate, admin surfaces — goes through it. **All writes emit the
   new shape and delete `totp`** (lazy migration on first device mutation; idempotent;
   no downtime; no script). ADR-0018's predicate is satisfied by restating its enrolment
   clause as `totpDevicesOf(a).length > 0 ∨ needsTotp(a) === false` — same truth value
   for every existing row.

3. **A login challenge is satisfied by any enrolled device.** The submitted 6-digit code
   is verified against each device's secret (≤5 decrypt+verify, bounded); the matching
   device's `lastUsedAt` is stamped and its `id` is carried on the `login-success` audit
   entry. First-login enrolment (no devices yet, `needsTotp` true) is unchanged in flow
   and becomes the enrolment of device #1, default name "Authenticator".

4. **An enrolled factor is always challenged.** The login gate changes from
   `needsTotp(a)` to `needsTotp(a) ∨ totpDevicesOf(a).length > 0`. `needsTotp` keeps its
   exact meaning — *must this account have a second factor* (drives forced enrolment and
   the last-device guard) — but possession of an enrolled device now always engages the
   challenge, which is what makes voluntary (opt-in) 2FA real and closes the gap where an
   admin `totpRequired: false` pin silently stopped challenging an already-enrolled
   account. This supersedes ADR-0013's *dormant* semantics in part: the secret still
   survives the downgrade (never deleted by the pin, exactly as 0013 promised), but it
   keeps protecting the login. An exempted user who wants no challenge removes their
   devices in self-service — an explicit, audited act instead of a silent pin side-effect.

5. **Self-service device add/remove, re-auth-gated** (the gate is
   [ADR-0026](0026-ccp-reauth-gate.md); the routes/UX are the spec's):
   add = server-minted secret → QR/setup-key (the existing offline `TotpQr` renderer) →
   confirm with a live code → named device appended. Remove = by id. **Last-factor
   guard:** removing the last device is refused (new error `LAST_FACTOR`) while
   `needsTotp(account)` is true; when it is false, removing the last device is allowed
   and also burns the account's recovery codes ([ADR-0025](0025-ccp-recovery-codes.md)
   — codes exist only while 2FA is active). Anyone may opt in, including plain
   requesters.

6. **The admin path is unchanged in meaning, widened in effect:** `reset-totp` clears
   *all* devices and the recovery codes, kills sessions, and stays immediate + audited —
   availability recovery, not a privilege grant. The `totpRequired` pin stays the
   admin's; self-service never writes it. Every self-service device mutation bumps
   `accountVersion` (the dual-control drift guard, `schema.ts:147-161`) so a pending
   admin proposal captured against the old state stales to 409 instead of replaying.

## Options considered

### Option A: Keep one secret; allow re-enrolment self-service
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | No second device ever — replacing is not adding; lost-phone still = admin rescue or lockout |
| Team familiarity | High — the shape that exists |

**Pros:** no schema change; no migration.
**Cons:** fails the ask outright ("add additional 2FA device"); a re-enrol flow without a
second factor present is a pure downgrade window; recovery codes would carry the whole
lost-device burden alone.

### Option B: Named device list, shimmed from the legacy secret (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium — one new array field, one read shim, challenge loop over ≤5 secrets |
| Cost | Every 2FA reader must go through the shim (enforced by review + tests); audit gains device ids |
| Team familiarity | High — `rolesOf` is this exact migration pattern, already shipped |

**Pros:** additive + idempotent migration with zero downtime and no script; device
naming/audit ("which phone approved this login"); the founding predicate and `needsTotp`
keep one source of truth; cap bounds verification cost.
**Cons:** two shapes coexist in stored data until rows are touched (accepted — same as
`roles`); ADR-0013's dormancy clause needs the partial supersession above.

### Option C: Generalized factor table (TOTP + WebAuthn-ready rows)
| Dimension | Assessment |
|---|---|
| Complexity | High — abstract factor kinds, per-kind verification, per-kind enrolment UX |
| Cost | Speculative generality; WebAuthn needs origin/RP decisions this deployment hasn't made |
| Team familiarity | Low |

**Pros:** future-proof if passkeys arrive.
**Cons:** YAGNI today; the device list is forward-compatible anyway (a later `kind` field
on the device row is additive); blocks the ask behind design work nobody requested.

## Consequences

- **Easier:** lost-one-phone stops being lockout (second device or recovery code);
  security review can name devices in the audit trail; opt-in 2FA becomes possible for
  requesters; the founding build gets a single enrolment helper instead of a raw field
  read.
- **Harder:** every future 2FA reader must use the shim, never the raw fields (the spec
  adds a contract test pinning `totp`-raw reads to the shim module); the mock store
  (`app/src/lib/accounts.ts`) must mirror the device list for standalone parity
  (ADR-0007 doctrine); admin `reset-totp` copy must say "clears **all** devices and
  recovery codes".
- **Behavior change to surface at rollout:** accounts enrolled *and* pinned
  `totpRequired: false` are challenged again after this ships (clause 4). The spec's
  rollout note requires calling this out to the owner; affected accounts self-remedy by
  removing their devices.
- **Revisit:** per-code replay protection (rejecting reuse of the same 30s window's code)
  is not added — parity with today's single-device behavior; a hardening pass may add a
  per-device `lastUsedStep`. WebAuthn/passkeys would be a new ADR extending the device
  row with a `kind`.

## Action items

1. [x] Owner: sign off the always-challenged rule (clause 4) and the 5-device cap —
       greenlit as one of this build's owner-accepted defaults (2026-07-22).
2. [x] Build per the spec's lanes (A1 api model → A2 clients/mock → A3 UI), **after** the
       branding build's G1/G2 lanes land — the spec's §10 collision table named the
       shared files (`schema.ts`, `auth/totp.ts`, `openapi`, `httpApi.ts`, `api.ts`,
       `LoginPage.tsx`); landed on `claude/account-security-build`.
3. [x] Reconcile with the founding build: the shim helper `totpDevicesOf` is the one
       enrolment predicate every reader (login, founding-complete, admin surfaces) goes
       through — whichever build lands second still just consumes it.
4. [x] ADR-0013 gains its partial-supersession banner line in this same change (see its
       top banner). Formal flip to Accepted on the owner's word remains open — the design
       and the build are done; this line tracks only the sign-off ceremony.
