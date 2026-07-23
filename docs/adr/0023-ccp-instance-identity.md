# ADR-0023: Instance identity is a hybrid — baked generic default + runtime override set at first setup

**Status:** Proposed (build landed on `claude/branding-build` using this ADR's §12-recommended
defaults, per instruction not blocking on sign-off; status flips to Accepted on the owner's word)
**Date:** 2026-07-22
**Deciders:** repo owner (product identity); design lane `claude/generic-branding-design`

## Context

Cloud Control Plane is becoming a generic, white-labelable product: the operator
standing it up brings their own brand and wants the instance's displayed name (and one-line tagline)
neutral by default, settable during first setup, and changeable later. The PRD already
splits **display name** from the **`ccp` identifier slug** (PRD.md:3, 2026-07-16) and
promises brand-swappable design tokens (PRD.md:125) — this ADR decides *where the display
identity lives and when it is set*. Code identifiers (`ccp/` paths, `CCP_*` env
prefixes, css/package names) are explicitly out of scope — no user benefit, huge blast
radius.

Constraints and forces:

- **ADR-0007 standalone parity:** the SPA must run with no backend (mock mode). The name
  must resolve with zero network.
- **The deploy flow already bakes Vite env:** `VITE_API_BASE` is a compose build arg from
  `.env`; the interactive installer (`install.sh`/`setup.sh`) rebuilds the SPA image and
  performs one ephemeral `CCP_BOOTSTRAP=1` first boot — natural seams for both a
  build-time value and a first-boot seed.
- **The login page renders the name pre-auth**, so any runtime source must be readable
  unauthenticated.
- **Server settings are project-scoped** (`SETTING#` under `P#<id>#`); instance identity is
  global — precedent: the accounts partition and the in-flight `FoundingItem` (ADR-0017).
- **Founding (ADRs 0017–0019) seals itself irreversibly.** A display name must stay mutable
  forever, so it must not live inside the sealed founding record.
- **A flash of the wrong brand is a real defect** here (the codebase already engineers
  against posture-flash — AdvisoryGate's constant-mode doctrine).

Companion design (full recon, build lanes, collisions, Phase-2 logo/accent boundary):
[docs/superpowers/specs/2026-07-22-ccp-generic-branding.md](../superpowers/specs/2026-07-22-ccp-generic-branding.md).

## Decision

**Hybrid (option C).** A **generic baked default** — `VITE_INSTANCE_NAME` build arg with
fallback `'Cloud Control Plane'` (final wording: owner) compiled into `brand.ts` — plus a
**server-side runtime identity**: a global `INSTANCE` store item `{name, tagline, version,
updatedAt, updatedBy}`, seeded at the installer's one first boot from
`CCP_INSTANCE_NAME`, served unauthenticated at `GET /instance` (name + tagline only),
edited via `PUT /admin/instance` (admin, validated, version-guarded, audited
`instance-identity-change`), rename-anytime with no rebuild. The SPA resolves
baked → cached-last-known → runtime, and the installer seeds both layers from **one
prompt/`.env` knob** so they are identical on day zero. Instance naming is a **first-run
step and a Settings surface, not part of the sealed FOUND record**.

## Options considered

### Option A: Build-time only (`VITE_INSTANCE_NAME` baked at `docker build`)
| Dimension | Assessment |
|---|---|
| Complexity | Low — mirrors `VITE_API_BASE` exactly |
| Cost | A rebuild for every rename, forever; no Settings surface possible |
| Team familiarity | High — the existing pattern |

**Pros:** simplest; zero runtime moving parts; mock parity trivial; no flash ever.
**Cons:** fails "changeable later" — rename = rebuild + redeploy; identity invisible to the
api (TOTP issuer stays hardcoded or needs a separate env); no audit trail of renames.

### Option B: Runtime only (server-side identity, fetched by the SPA)
| Dimension | Assessment |
|---|---|
| Complexity | Medium — endpoint + store + subscribable client state |
| Cost | Every cold paint flashes the built-in default until fetch resolves; mock/standalone has no name source without a bolted-on local fallback (which quietly reinvents option A's constant) |
| Team familiarity | Medium |

**Pros:** rename anytime; single source of truth; api-side consumers (TOTP issuer) read it
naturally.
**Cons:** violates ADR-0007 cleanliness (backendless build needs a special case);
guaranteed flash-of-default pre-fetch; pre-auth login needs an unauthenticated endpoint
anyway (shared with C, so no advantage).

### Option C: Hybrid — generic baked default + runtime override (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium — both seams, but each is the simple half of A and B |
| Cost | Two layers to keep coherent; after a runtime rename the baked long-tail copy converges only at the next rebuild (routine via self-update) |
| Team familiarity | High — build arg pattern + FoundingItem-style global item + first-boot seed pattern |

**Pros:** installer seeds both layers from one answer ⇒ day-zero flash-free and identical;
mock/standalone = baked layer, ADR-0007 holds with no special case; rename-in-Settings is
instant on identity surfaces, audited, no rebuild; a last-known cache kills the
post-rename cold-load flash.
**Cons:** brief mixed state possible between a rename and the next rebuild (deep body copy
baked with the old name) — accepted and documented; two places to reason about instead of
one.

## Consequences

- **Easier:** a new org installs and owns the identity from the first prompt; white-label
  Phase 2 (logo + accent) plugs into the same identity object and editor; the genericity
  guard can ratchet `\bNTT\b` out of app source once the sweep lands.
- **Harder:** brand copy must flow through one seam (`brand.ts` + `lib/instanceIdentity.ts`)
  — enforced by the guard, but a discipline nonetheless; the ciTemplates byte-parity trio
  must genericize in a three-file lockstep commit; TOTP authenticator labels predating a
  rename keep the old name until re-enrollment (cosmetic, documented).
- **Revisit:** rename write classification (immediate-audited vs dual-control — owner
  question); Phase 2 asset storage + SVG sanitization gets its own ADR; if the governance
  build moves first-boot declarations into `found.ts declare`, the identity seed should
  ride the same vehicle.

## Action items

1. [ ] Owner: confirm the generic default wording, rename governance (immediate vs
       dual-control), default tagline, and PRD-banner timing (spec §12) — the build below
       used the §12-recommended answers for all four without blocking on this confirmation;
       reviewing the PR is the confirmation step.
2. [x] Build per the spec's G1–G6 lanes, **after** the in-flight app lanes merge
       (data-birth, ux-audit, journey-simulation, twofa-qr, wayfinding) — spec §10 order.
       Landed on `claude/branding-build` (2026-07-22): all six lanes, Phase 1 (name +
       tagline) only — Phase 2 (logo + accent) deliberately deferred per spec §8.
3. [ ] Flip this ADR to Accepted on the owner's word. PRD naming banner already gained the
       configurable-display-name sentence with the build (PRD wins doctrine — the sentence
       describes the shipped direction; this ADR's own status is the formal record).
