# ADR-0026: A session-stamped re-authentication gate (10-minute window) guards sensitive self-service

**Status:** Proposed (build landed on `claude/account-security-build` per the spec:
[account & security center](../superpowers/specs/2026-07-22-ccp-account-security-center.md) —
the owner greenlit the 10-minute window and the either-factor rule (§13 open question 2)
as defaults not to be re-litigated; status flips to Accepted on the owner's formal word)
**Date:** 2026-07-22
**Deciders:** repo owner (security posture); design lane `claude/account-security-center-design`

## Context

The account & security center gives every signed-in user standing power over their own
credentials: add/remove a 2FA device (ADR-0024), regenerate recovery codes (ADR-0025),
revoke sessions. A session cookie alone must not be enough for those — an unattended
laptop or a hijacked cookie would let an attacker *quietly swap in their own authenticator
and mint fresh recovery codes*, converting a transient session compromise into durable
account ownership. The standard answer (GitHub "sudo mode", Google security checkup) is a
short-lived elevated state entered by re-proving a credential.

Repo facts that shape the design:

- Sessions are server items resolved on every request (`auth/sessions.ts:54-78`) — there
  is a natural, tamper-proof place to stamp elevation: the `SessionItem` itself
  (per-session, dies with the session, absent from every other session).
- `/auth/change-password` already re-proves the current password inline
  (`routes/auth.ts:232-233`) — an existing, working micro-instance of this gate.
- Login failures drive an exponential-backoff lockout (`routes/auth.ts:82-99`); any new
  place a password can be guessed must feed the same counter or it becomes the
  attacker's preferred oracle.
- Session TTLs are fixed named constants (`ABSOLUTE_MS` 12h, `IDLE_MS` 30m,
  `sessions.ts:9-10`) — the window should be a third sibling constant, not a setting
  (the SPA's local "session limits" steppers are already documented authority theater,
  SETTINGS-CATALOG §SPA-local).

## Decision

1. **One route, one stamp.** `POST /auth/reauth` accepts **either** the account password
   **or** a live TOTP code from any enrolled device (`{password}` or `{code}` — exactly
   one). Success stamps the **current session item** with `reauthAt` (ISO) and audits
   `reauth-success`; failure audits `reauth-failure`, **bumps the same
   `failedAttempts`/lockout counter as login**, and returns the generic
   `BAD_CREDENTIALS`/`TOTP_REQUIRED` shape (no oracle). Recovery codes are **not**
   accepted — they are break-glass for login only (ADR-0025 clause 4).

2. **Validity: 10 minutes** (`REAUTH_MS = 10 * 60 * 1000`, a named constant beside
   `ABSOLUTE_MS`/`IDLE_MS`). Long enough to complete a device enrolment ceremony (QR scan
   + code entry + naming + saving recovery codes), short enough that a walked-away
   session cools off. Not configurable in v1 — a constant, like every other session
   lifetime here.

3. **Enforcement is server-side, per operation.** Sensitive self-service routes check
   `now - reauthAt <= REAUTH_MS` on the *resolved session* and refuse otherwise with a
   new `403 REAUTH_REQUIRED` error state. Gated in v1: begin/confirm device add, device
   remove, recovery-code regeneration, session revocation (one or all-others).
   **Not double-gated:** `/auth/change-password` keeps its inline current-password proof —
   it *is* a re-authentication, and adding a second prompt for the same secret is
   ceremony without security. The elevation never crosses sessions (it lives on the
   session item) and never survives sign-out, revocation, or a `sessionVersion` bump.

4. **The SPA treats `REAUTH_REQUIRED` as a flow, not an error:** one reusable
   confirm-it's-you dialog (password or 6-digit code, mirroring what the account has)
   that calls `/auth/reauth`, then transparently retries the refused call. Mock parity
   (ADR-0007 doctrine): the standalone store keeps an in-memory `reauthAt` per tab with
   the same window and verifies the password against its PBKDF2 hash; since the mock
   store holds no real TOTP secrets, its dialog is password-only — a named, deliberate
   parity gap (same class as the mock's boolean `totpEnrolled`).

## Options considered

### Option A: No gate — a live session may do everything
| Dimension | Assessment |
|---|---|
| Complexity | None |
| Cost | Session compromise ⇒ durable account takeover (attacker enrols own device + codes) |
| Team familiarity | High |

**Pros:** zero friction.
**Cons:** unacceptable for a governance control plane: the audit chain would show the
victim "choosing" to add the attacker's device; contradicts the product's own
walked-away-laptop posture (30m idle timeout exists for exactly this adversary).

### Option B: Per-session elevation stamp with a short window (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low — one field on `SessionItem`, one route, one middleware-style check |
| Cost | One extra prompt per sensitive burst; a new error state + dialog |
| Team familiarity | High as users (GitHub sudo); the session store is already the request path |

**Pros:** tamper-proof (server item, not a client claim); scoped to one session; dies
with the session; lockout-integrated; one dialog serves every current and future
sensitive op.
**Cons:** a 10-minute window is a judgment call (revisit below); mock mode can only
re-prove the password.

### Option C: Fresh full login (drop the session, sign in again) per sensitive op
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Brutal UX (lose app state, redo TOTP per op); pushes users to batch-avoid security chores |
| Team familiarity | Medium |

**Pros:** maximally conservative; no new state.
**Cons:** re-entering the *whole* login (including TOTP) to *remove* a broken TOTP device
can be impossible; friction this high teaches users to postpone hygiene.

## Consequences

- **Easier:** every sensitive self-service op inherits one uniform, audited gate; future
  additions (e.g. a display-name self-edit, if the owner approves one) reuse the same
  check + dialog; the admin-vs-self boundary stays crisp (admin routes keep their own
  `requireAdmin` + dual-control machinery — this gate is self-service-only).
- **Harder:** `SessionItem` gains a field (additive-optional — legacy sessions parse,
  treated as never-elevated: fail closed); ERROR-STATES gains `REAUTH_REQUIRED`; tests
  must drive the two-step refuse-elevate-retry flow.
- **Revisit:** the window length if real usage shows ceremonies exceeding 10 minutes;
  whether an *admin's own* sensitive self-service (their devices/codes) should demand the
  TOTP branch specifically once multi-device is common (v1: either factor).

## Action items

1. [x] Owner: confirm the 10-minute window and either-factor rule — greenlit as one of
       this build's owner-accepted defaults (2026-07-22).
2. [x] Build in the spec's A1 lane (route + stamp + checks) with the A3 dialog; landed on
       `claude/account-security-build`.
3. [ ] Flip to Accepted on the owner's formal word — the design and the build are done;
       this line tracks only the sign-off ceremony.
