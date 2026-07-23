# ADR-0025: One-time recovery codes — hashed at rest, shown once, a login path of last resort

**Status:** Proposed (build landed on `claude/account-security-build` per the spec:
[account & security center](../superpowers/specs/2026-07-22-ccp-account-security-center.md) —
the owner greenlit codes-at-enrolment + the 10×80-bit format and the recovery-code
ceremony at forced first login (§13 open questions 4 and 5) as defaults not to be
re-litigated; status flips to Accepted on the owner's formal word)
**Date:** 2026-07-22
**Deciders:** repo owner (security posture); design lane `claude/account-security-center-design`

## Context

With 2FA required for every senior/admin account (`needsTotp`, `auth/totp.ts:67-71`) and
becoming multi-device ([ADR-0024](0024-ccp-multi-device-totp.md)), the lost-ALL-devices
case still ends in either admin `reset-totp` or lockout. On the smallest deployment this
product promises to govern — two humans, each lead + admin (ADR-0018's 2-human compact) —
"ask an admin" can mean "ask the person whose phone is also in the lost bag". The industry
answer is one-time backup codes generated at 2FA setup, stored only as hashes, shown
exactly once, individually burned on use.

Forces:

- **Storage:** the repo's precedent for high-entropy credentials is plain `sha256` at rest
  (session tokens, `auth/sessions.ts:16-24` — 256-bit tokens, hash-only storage); low-entropy
  credentials get argon2id (passwords). Recovery codes must be entropic enough to sit in
  the first class, or expensive enough to verify in the second.
- **The login state machine** already has the right seam: a 1FA-passed pre-session with
  `pending: 'totp'` (`routes/auth.ts:119-125`), on which the challenge routes hang. A
  recovery login is *another way to satisfy that same pending step*, not a new door.
- **Audit:** every consume/regenerate must land on the hash-chained audit — but never the
  codes or their hashes (audit is admin-readable; hashes of guessable strings are an
  offline-cracking gift).
- **Lockout parity:** a recovery-code guesser must hit the same exponential backoff as a
  password guesser (`routes/auth.ts:82-99`), or the pre-session becomes a free oracle.

## Decision

1. **Shape:** a new additive-optional account field

   ```
   recoveryCodes?: {
     codes: Array<{ hash: string, usedAt?: string }>  // hash = sha256hex(normalized code)
     generatedAt: string
   }
   ```

   **10 codes** per set. Each code is 16 characters from a 32-symbol unambiguous alphabet
   (Crockford-style, no `0/O/1/I`), displayed grouped `XXXX-XXXX-XXXX-XXXX` — **80 bits of
   entropy**, which justifies plain `sha256` at rest exactly as it does for session tokens
   (offline brute-force of 2^80 sha256 is out of reach; argon2×10-codes-per-attempt buys
   nothing but latency). Verification normalizes (strip separators, uppercase) and
   compares constant-time against unused hashes.

2. **Generation moments — shown once, plaintext never stored:**
   - automatically when 2FA becomes active (the first device enrolment, including the
     forced first-login enrol: the enrol response carries the fresh codes and the SPA
     interposes a "save these now" step before entering the app — the day-one lockout
     window closes at birth);
   - on demand from the Account Center ("Regenerate"), re-auth-gated
     ([ADR-0026](0026-ccp-reauth-gate.md)); regeneration **replaces the whole set**
     (old codes all die, audited).

3. **The recovery login path:** on the TOTP challenge screen, "Use a recovery code
   instead" posts the code against the same `pending: 'totp'` pre-session. Success burns
   that one code (`usedAt` stamped — burned, never deleted, so the audit trail and the
   remaining-count stay honest), mints the full session, and audits `recovery-code-used`
   with the count remaining. Failure counts toward the account's `failedAttempts`
   backoff and audits `login-failure`. A recovery login does **not** clear devices or
   codes beyond the one burned — the user may have found the phone; the Account Center
   banners "you signed in with a recovery code — review your devices" and warns from
   ≤3 codes remaining.

4. **Codes are break-glass, not a factor.** They never satisfy the re-auth gate
   (ADR-0026 — password or a live TOTP code only), never count for ADR-0024's
   last-factor guard, and never make an account founding-complete on their own
   (ADR-0018's predicate reads device enrolment, not codes). When the last device is
   legitimately removed (2FA off), the code set is deleted with it. Admin `reset-totp`
   clears codes along with devices (ADR-0024 clause 6).

5. **What the audit and the API ever expose:** counts and timestamps only
   (`{remaining, generatedAt}`) — never code material or hashes, in any response, audit
   payload, or log.

## Options considered

### Option A: No codes — admin reset is the recovery path
| Dimension | Assessment |
|---|---|
| Complexity | None |
| Cost | 2-human compact: correlated loss (one bag, one flood) = permanent lockout of the estate's governance |
| Team familiarity | High — status quo |

**Pros:** nothing to build; smallest secret surface.
**Cons:** fails the ask; ADR-0019's day-zero threat model already treats "second human
can actually operate the controls" as constitutional — a recovery story that dead-ends in
the other human's phone is availability theater.

### Option B: One-time hashed backup codes (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low-medium — one field, one route, one interstitial |
| Cost | A second credential class to store/burn/audit; user discipline ("save these") |
| Team familiarity | High as users (GitHub/Google pattern), medium as implementers |

**Pros:** offline, no dependencies (matches the product's no-email/no-SMS posture —
local identity per ADR-0006); hash-only at rest; individually burnable and auditable;
self-service regeneration.
**Cons:** codes on paper are a phishable/stealable artifact (mitigated: single-use, burned,
audited, backoff-limited); users who skip the "save" step gain nothing (mitigated: shown
at enrolment, regenerable).

### Option C: Admin-issued one-time bypass ("break-glass ticket")
| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Still requires a working admin at recovery time — same correlated-loss hole as A; adds a powerful new admin verb |
| Team familiarity | Low |

**Pros:** nothing for users to keep.
**Cons:** doesn't solve the case that motivates this ADR; a standing "let anyone in once"
admin power is a worse primitive than pre-committed hashed codes.

## Consequences

- **Easier:** losing every device stops being an estate-governance emergency; the forced
  first-login enrolment produces a complete recovery posture in one sitting; admins field
  fewer `reset-totp` rescues.
- **Harder:** the SPA must treat code display as a one-shot ceremony (copy/download,
  confirm-before-continue); the mock store mirrors `{remaining, generatedAt}` for
  standalone parity (ADR-0007 doctrine); ERROR-STATES and the event catalog gain the new
  codes/kinds at build time.
- **Revisit:** printable/download format niceties; whether an admin should *see*
  `remaining` on the Users screen (recommended yes — counts only); rate limiting beyond
  the shared lockout if telemetry ever shows abuse.

## Action items

1. [x] Owner: sign off codes-at-enrolment (automatic) + 10×80-bit format — greenlit as
       one of this build's owner-accepted defaults (2026-07-22).
2. [x] Build in the spec's A1 (api) / A2 (clients+mock) / A3 (UI interstitial + Account
       page card) lanes; landed on `claude/account-security-build`.
3. [ ] Flip to Accepted on the owner's formal word — the design and the build are done;
       this line tracks only the sign-off ceremony.
