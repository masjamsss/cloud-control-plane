# ADR-0028: Estate settings are two-tier runtime config — born at first setup, changeable forever, projected (never compiled) into out-of-band tools

**Status:** Proposed (design lane; build gated on owner decisions D1–D6 — spec:
[estate config at setup](../superpowers/specs/2026-07-22-ccp-estate-config-at-setup.md))
**Date:** 2026-07-22
**Deciders:** repo owner (product direction); design lane `claude/estate-config-design`
**Note on numbering:** 0027 is deliberately skipped — it remains reserved for the
repo-split ADR (FUNDAMENTALS, REPO_SPLIT row).

## Context

CCP is becoming a public tool with a per-operator install. The owner's directive:
every estate-specific assumption must be operator-set at first setup and changeable
later — generalizing the instance-identity pattern
([ADR-0023](0023-ccp-instance-identity.md)) — and specifically the estate/project
**id + display name** must be a first-run prompt. The measured state:

- Exactly **one estate fact survives in tool source**: `catalogctl` pins every
  maintenance window's provenance `tz` to the literal `"Asia/Tokyo"`
  (`tools/catalogctl/internal/request/request.go:181`, re-checked in
  `internal/windowcheck/windowcheck.go:116`, plus a hardcoded JST `FixedZone` for
  display copy). Enforcement itself is UTC-instant math everywhere — app, api
  (`domain/schedule.ts` has no tz handling), and the gate; the tz is
  display/provenance metadata.
- Estate **id, name, and provider identity (account/region or
  subscription/tenant/location)** are already operator-supplied at `POST /projects`
  (required `id` + `name`, allowlisted region/location) — but not framed as a
  first-run prompt on a blank install, and the display name has no rename path.
- Instance identity is decided and built (ADR-0023: global `INSTANCE` item, first-boot
  seed, admin edit). Estates are born at onboarding on a blank install (ADR-0020/0022);
  `@control` is reserved (ADR-0021). The bundled sample estate is a frozen fixture
  with a compile-time id (`SAMPLE_ESTATE_ID`, `ccp/app/src/lib/projectScope.ts`) —
  tests cannot prompt, so it can never be operator-configurable.
- CI gates cannot call the api (the `CCP_FREEZE` precedent: api-invisible state is
  mirrored as a repo variable, prepended by `scripts/ci/apply-window-gate.sh`).

Forces: fail-closed gates must stay fail-closed and table-testable (windowcheck reads
no clock, does no I/O); mock/standalone parity (ADR-0007) needs zero-network defaults;
fixture law forbids editing oracles to make implementations pass; the public tool
source must carry no estate value.

## Decision

1. **Two tiers.** Install-tier (global, one per deployment): instance identity —
   ADR-0023 unchanged. Estate-tier (per project): id, display name, provider identity,
   **operating timezone**, and future estate-policy knobs — persisted where
   project-scoped runtime config already lives (the project record + the `SETTING#`
   partition under `P#<id>#`, reserved `estate.*` key namespace), set at the
   first-run/onboarding "create your estate" step, edited later in an admin
   estate-settings surface (audited, version-guarded; timezone behind the ADR-0026
   re-auth gate).
2. **Id immutable, name mutable.** The estate id keys partitions, storage scopes, and
   URLs — chosen once at registration, never renamed; the display name renames
   anytime (audited `project-rename`). Same split ADR-0023 made for instance identity.
   The sample fixture's id stays a fixed generic compile-time constant, refused as a
   real registration id.
3. **The projection rule.** A tool that cannot call the api at run time learns an
   estate expectation as an **explicit parameter at its boundary** — flag > env >
   generic compiled default — projected into CI as a repo variable by the wrapper
   script (the `CCP_FREEZE` pattern). Concretely for the timezone: `catalogctl`
   takes `--estate-tz` / `CCP_ESTATE_TZ` / default `"UTC"`, resolved once in
   `main` and threaded down; `request.go`'s check becomes
   `window.tz == <configured tz>`; the JST `FixedZone` is replaced by a
   startup-resolved `time.LoadLocation` over embedded tzdata (display-only —
   enforcement stays pure UTC comparison); an unresolvable configured tz refuses at
   startup, exit 3. Existing `Asia/Tokyo` fixtures are untouched: the harness passes
   the configured value for that set, new UTC fixtures cover the default, a mismatch
   test proves fail-closed.
4. **The register discipline.** Every estate knob has a row (spec §3): where set at
   first setup, where persisted, how changed later, blank-install default. A new knob
   = a new `estate.*` key + SETTINGS-CATALOG row + default + governance class — never
   a literal in source.

## Options considered

### Option A: Per-estate build-time configuration (bake estate values at compile/deploy)
| Dimension | Assessment |
|---|---|
| Complexity | Low per value — the `VITE_*` pattern |
| Cost | Every change = rebuild; fails "changeable since initial setup" outright; multiplies published artifacts per estate |
| Team familiarity | High |

**Pros:** zero runtime moving parts; trivially deterministic.
**Cons:** contradicts the directive (change requires rebuild); gates would still need
a source-of-truth outside the binary; ADR-0023 already rejected this shape for the
name (option A there) — same reasoning, more strongly, for policy-relevant values.

### Option B: One global settings blob + a config file for out-of-band tools
| Dimension | Assessment |
|---|---|
| Complexity | Medium — one store, plus file discovery/parse/failure handling in every tool |
| Cost | Global scope fights the product model (provider/region/teams are per-project — ADR-0015/0022; one install can host several estates); a discovered config file is a second on-disk home rivaling the server store, ambiguous under catalogctl's varying cwds |
| Team familiarity | Medium |

**Pros:** single blob is simple to reason about; a file generalizes to many keys.
**Cons:** wrong scope for estate facts; file discovery is a new failure surface on a
fail-closed gate path; a one-string file is machinery without a second tenant. (A
third variant — carrying the expectation solely on the request envelope — is
self-certification: the artifact under validation supplying its own oracle. Rejected
in the spec §5.2.)

### Option C: Two-tier runtime settings + explicit projection (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium — settings keys + one admin surface + one flag/env seam |
| Cost | Two truths (server setting, CI variable) that must be kept aligned — accepted: misalignment fails closed and loudly (exit 3 naming the variable), and the alignment step is a documented runbook line until automation (owner flag D5) |
| Team familiarity | High — every mechanism is an existing pattern (SETTING# partition, ADR-0023 seed/edit flow, CCP_FREEZE projection, pure windowcheck parameters) |

**Pros:** operator sets everything at first run and changes it later with audit;
public source carries only generic defaults; gates stay pure, deterministic, and
fail-closed; fixtures stay frozen; each tier lives where its scope says.
**Cons:** the CI variable is a manual projection until D5; a timezone change
invalidates in-flight windowed requests (deliberate — approvers signed old-zone
wall-clock terms; the surface warns and lists them).

## Consequences

- **Easier:** a blank public install prompts for estate id, name, provider identity,
  and timezone with generic defaults and zero estate residue in source; issue #37
  closes with a one-parameter change model; future estate knobs have a rutted road
  (register row + `estate.*` key), not a new design each time.
- **Harder:** operators changing the timezone must re-window in-flight requests and
  update the CI variable (warned in-surface, documented in runbooks); build lanes must
  thread one more parameter through catalogctl call sites; the register discipline is
  one more review checkpoint.
- **Revisit:** automating the repo-variable projection from the api (D5); promoting
  cooling-off/ladder parameters into `estate.*` (each needs its own ADR); a
  multi-file `--estate-config` if catalogctl ever needs a second estate setting.

## Action items

1. [ ] Owner: decide D1–D6 (spec §11) — recommendations are marked; the build lanes
       use them unless overruled.
2. [ ] Build lanes E1–E6 per spec §9 (E4/catalogctl is independent and may ship
       first; live-estate rollout must set `CCP_ESTATE_TZ` to that deployment's own
       zone before the new binary reaches the gate path — spec §7 ordering).
3. [ ] Flip this ADR to Accepted on the owner's word; status rows land in proposal
       0018 as lanes merge.
