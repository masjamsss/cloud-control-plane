# ADR-0033: An opt-in scanner service lets the control plane run the first scan itself — read-only forge access, contained; both ceremonies untouched

**Status:** Accepted — **built for public repositories** (2026-07-26). The owner gave the
go-ahead ("let's fix all of them", "keep building") and the lane below is implemented,
disarmed by default, and proved end to end: an admin queues a scan, an isolated worker
clones and prescans, and the project reaches `pending-trust` with the two-admin trust
ceremony still ahead of it. **Decision 1 (credential custody) is NOT built yet** — there
is no GitHub App broker and no sealed forge token, so an armed deployment can currently
scan **public repositories only**; a private repo's clone fails the job with git's own
"not found", which is the correct fail-closed behaviour but not the intended experience.
Decision 5's register-form shrink is likewise still pending; the wizard's new
"Let this system scan it" tab delivers the zero-action scan, not yet the one-field form.
Everything else below is in the code.
**Date:** 2026-07-25
**Deciders:** Owner (Jamal) + maintainers

> Supersession, stated honestly: **for deployments that opt in**, this ADR supersedes
> ADR-0031's deferral of its option B (a control-plane-dispatched scanner,
> `0031:61-72`) and amends `ccp/docs/onboarding-security.md`'s "The control plane
> itself never runs it, either way" clause. ADR-0031 and ADR-0032 remain the standing,
> fully supported design for every deployment that does **not** opt in — their lanes
> are not deprecated. ADR-0032's rejection of server-held repo-**write** credentials
> (`0032` decision 4) stands unweakened everywhere, including here.

## Context

The owner asked, twice and decisively: *"Why does scanning the repo have to be run
manually on our end? Why can't the CCP system do it?"* — and — *"Im expecting we just
put the repo, then the rest scan is run by the system itself."* The direction is set;
this ADR's job is to deliver it safely and state its real cost plainly.

Today the first scan must be produced outside the deployment — laptop or estate CI
(`ccp/docs/onboarding-security.md`, "Where the first scan may run") — because the
deployment holds no repo credential and never checks out repos
(`ccp/api/src/routes/projects.ts` header contract). Two verified facts make a safe
server-side lane possible:

1. **The day-zero artifacts come from prescan only** — a pure `hashicorp/hcl/v2`
   static parse. The trust-gate stop (`tools/catalogctl/internal/onboard/onboard.go:147-163`)
   precedes the required_version gate (:169-184) and every runner call (:186-200), so a
   scanner that never supplies `--trusted-commit` structurally cannot execute anything.
   The scan environment therefore needs a shallow read-only clone and nothing else: no
   terraform binary, no registry egress, no cloud credentials.
2. **The narrow upload lane already exists** (ADR-0031 Phase 1, built): a pre-trust
   onboarding token minted per project (`POST /projects/:id/onboard-tokens`) authorizes
   exactly one verb — `PUT /projects/:id/trust-request` — through the unchanged
   validation pipeline (sha binding, strict parse, repo-disagreement refusal;
   `projects.ts`). A server-side scanner can ride it with zero new authority.

## Decision

Ship an **opt-in scanner service** — a separate container (compose profile `scanner`,
sibling of `runner`/`toolbox`), never the api process — that clones the registered
repo shallowly and runs the unchanged `catalogctl` prescan, uploading the artifact pair
over a short-TTL per-job onboarding token. The operator experience becomes: paste the
repo URL, click Add, and review the result — the scan itself costs zero actions.

Containment, each piece load-bearing:

1. **Credential custody.** Primary: a **GitHub App installation** — the operator
   installs it on their org (repo-picker least privilege), permissions
   `contents: read` + `metadata: read` only; the deployment stores the App key in
   env/secret-file (never the store) and mints per-job installation tokens (≤1 h,
   scoped to the one repo). Revocable by the owner from GitHub's own UI. GitLab and
   self-hosted forges: an operator-minted read-only project/deploy token, sealed
   AES-256-GCM under an env key, never serialized by any endpoint. Public repos: no
   credential at all. A store-only breach yields no forge secret.
2. **Isolation.** The scanner image contains **no terraform** (and its entrypoint
   refuses to start if one appears on PATH); it reuses the committed no-cloud-creds
   guard (`tools/catalogctl/sandbox/run.sh:13-16`); non-root, read-only rootfs, tmpfs
   per-job workspace destroyed on completion; documented egress = the configured forge
   hosts + the api only — narrower than the sandbox container, which needs the two
   registry hosts. The worker pulls jobs from the api with a key that authorizes only
   claim/status; its sole artifact write path is the existing Bearer lane.
3. **Disarmed by default.** `CCP_SCANNER` unset ⇒ nothing arms and merging changes
   zero production behavior; a misconfiguration refuses to arm rather than
   half-working — the exact precedent of `ccp/api/src/domain/apply/loop.ts`.
4. **SSRF closed by construction.** No raw URL ever reaches git: the clone URL is
   reconstructed server-side from the project's validated `RepoRef`; self-hosted base
   URLs must match a deployment allowlist (`CCP_FORGE_HOSTS`); https only, redirects
   off, depth-1, no submodules/LFS, size/time caps, rate limits, one active job per
   project. Job creation is lead+isAdmin and audited.
5. **"Just put the repo."** The register form shrinks to one pasted URL (id/name
   auto-suggested, editable). Cloud identity moves to the review step: the census gains
   a static-literal `providerConfig` so provider/region (and, when statically present,
   account/subscription ids) are **proposed with file:line provenance and confirmed by
   a human** — never silently inferred, never a product constant. A new
   `PUT /projects/:id/identity` records the confirmation; upload-token mint refuses
   `IDENTITY_UNCONFIRMED` as the fail-closed backstop.
6. **Untouched, verbatim:** `POST /projects/:id/trust` (two-admin ceremony) has zero
   diff; the two-admin first-data activation has zero diff; the sha binding and strict
   artifact validation are the same code path; the pre-trust/post-trust token
   separation keeps its exact-inverse mint gates; the api process still never checks
   out a repository — the scanner service does, and only it.

**The honest cost:** an opted-in deployment holds read access to estate repos. An
attacker who fully compromises the api host can read the repos the App is installed on
(read-only, until the owner revokes at the forge — one click). A compromised worker
holds one job's ≤1 h single-repo read token and one ≤30 min pre-trust upload token,
and could submit a dishonest report for that one project — which two admins then
review, the same trust already placed in an estate CI runner or a laptop in the
existing lanes. That cost is the price of the owner's requirement, and this design's
whole shape is minimizing it.

## Options considered

### Option A: opt-in scanner service, GitHub-App custody, prescan only (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | High-Med (job queue + worker + forge-credential broker + wizard; but zero new scan code — the engine is the unchanged `catalogctl`, and the upload lane already exists) |
| Cost | ~2 weeks incl. hardening (matches ADR-0031's option-B estimate) |
| Team familiarity | Med — new service, but every pattern (compose profile, off-by-default arming, token lanes, byte-pinned guards) is an existing house pattern |

**Pros:** delivers the owner's ask verbatim — no file in the estate repo, no pasted
CI token, no workflow click; works for estates with no usable CI; short-lived
narrowly-scoped credentials with forge-side revocation; scan environment strictly
narrower than the sandbox.
**Cons:** the deployment now holds repo-read access (the cost above); a new
service/trust zone to build, operate, and audit; GitLab lacks an App analogue so its
custody story is a sealed pasted token with forge-side expiry.

### Option B: keep estate-CI (0031/0032) as the only lanes
| Dimension | Assessment |
|---|---|
| Complexity | None new |
| Cost | Zero |
| Team familiarity | High |

**Pros:** zero credential custody. **Cons:** does not do what the owner asked — twice.
**Not chosen as the recommendation; remains the standing design for deployments that
don't opt in.**

### Option C: run the scan inside the api process
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Days |
| Team familiarity | High |

**Pros:** no new service. **Cons:** puts untrusted-input parsing, git, and forge
tokens inside the process that holds the store and every session — exactly what the
sandbox contract exists to prevent. **Rejected.**

### Option D: pasted long-lived PATs as the primary credential
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Days |
| Team familiarity | High |

**Pros:** no App to register; works everywhere. **Cons:** standing secrets replayable
from a breached host, rotation is manual, revocation is per-token; strictly worse
custody than installation tokens. **Kept only as the self-hosted/GitLab fallback.**

## Consequences

- Easier: onboarding becomes paste → review → two acks; the scan costs zero operator
  actions; estates without CI are served for the first time.
- Harder: a new opt-in service to operate; a forge credential to hold (env-kept,
  store-free) and a documented revocation drill; `onboarding-security.md` gains a
  fourth "where the first scan may run" entry and an amended never-runs-it clause.
- Unchanged, by design: both two-admin ceremonies byte-identical; sha binding; token
  separation; no execution of repo content anywhere; no cloud credentials near the
  scan; no repo-write credential ever; estate-CI and local lanes fully supported.
- Revisit: extending the same worker to the post-trust data lane (killing the estate
  CI file entirely) is a natural follow-up with its own ADR — it executes product
  extractors over repo data and needs its own analysis; not licensed here.

## What shipped, and what it looks like in the code (2026-07-26)

Recorded here rather than in a new file, per this repo's extend-don't-spread rule. The
decisions above are unchanged; this is only where each one lives now.

| Decision | Where it is | Note |
|---|---|---|
| 2 — isolation | `ccp/scanner/Dockerfile`, `ccp/docker-compose.yml` (`profiles: ["scanner"]`), `tools/catalogctl/internal/scanworker` | No terraform in the image (build-time check), `Preflight()` refuses a terraform on PATH or any cloud credential, non-root, read-only rootfs, all caps dropped, tmpfs workspace, no ports/volumes/socket |
| 3 — disarmed by default | `ccp/api/src/domain/scanner.ts` | `CCP_SCANNER=1` **and** a ≥32-char `CCP_SCANNER_KEY`; either missing ⇒ every endpoint answers `SCANNER_DISABLED` |
| 4 — SSRF closed by construction | `buildCloneUrl()` + `POST /projects/:id/scan-jobs` | Scheme hard-coded https, host from a fixed table or an allowlisted `baseUrl`, credentials-in-URL and explicit ports refused, per-segment encoding; the worker never names a target and re-checks the URL it is given; one job in flight per project; lead+isAdmin and audited |
| 6 — untouched ceremonies | — | `POST /projects/:id/trust` and the two-admin first-data activation have zero diff; the worker uploads over the same pre-trust Bearer lane with the same sha binding |
| exactly-once claiming | `POST /scan-jobs/claim` | A compare-and-swap on `status === 'queued'` that simultaneously leaves the queue index; the lifecycle window is re-checked at claim time, so a project that left pre-trust while queued has its job failed rather than scanned |
| worker honesty | `POST /scan-jobs/:jobId/status` | Forward-only transitions validated against the STORED status; terminal jobs never reopen; error text scrubbed of control characters, URLs and token-shaped strings |

**Still to build:** decision 1's credential custody (which is what lifts the
public-repos-only limit), decision 5's one-field register form, and the separate
follow-on question of the control plane generating project *data* as well as the scan —
which this ADR explicitly does not license and which needs its own decision record.

## Action items

1. [ ] Owner reads the plain-language block (spec §"For the owner") and confirms the
       read-access cost is accepted; picks App-first custody as the default story.
2. [ ] Phase 0-1: census `providerConfig` (api schema first — strict parse), scan-job
       routes + broker + internal `mintOnboardToken()` extraction.
3. [ ] Phase 2-3: identity deferral (`PUT /projects/:id/identity`,
       `IDENTITY_UNCONFIRMED` mint refusal); `catalogctl scan-worker` + scanner image +
       compose profile; no-terraform-in-image pin test.
4. [ ] Phase 4: wizard third tab + URL-paste register + forge-connect page; doc sweep
       (`onboarding-security.md`, runbook, go-live); flip to Accepted on the owner's
       word.
