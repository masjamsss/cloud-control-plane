# ADR-0032: One estate CI file per host + a one-block repo setup — fewer onboarding actions, same ceremonies, same two credentials

**Status:** Proposed (design lane; build gated on owner sign-off — the design spec is held
in the private planning space; this ADR is written to stand alone).
**2026-07-25 — superseded in part by [0033](0033-ccp-zero-touch-first-scan.md)** for
deployments that opt in: the Context's "never holds repo credentials" framing gains a
contained read-only exception there. Unweakened everywhere: decision 4's rejection of
server-held repo-**write** credentials, and this ADR's design for the non-opt-in path.
**Date:** 2026-07-25
**Deciders:** Owner (Jamal) + maintainers

## Context

ADR-0031 removed the laptop from the first onboarding scan. What remains is still ~12
discrete operator actions per repo: a 6–7-field register form
(`ccp/app/src/features/admin/ProjectsAdmin.tsx:328-344`), TWO workflow files to commit
(`ccp/app/src/features/admin/ciTemplates.ts:25,59` + GitLab twins), TWO credentials each
minted and pasted at different moments (`CCP_ONBOARD_TOKEN`, `CCP_UPLOAD_TOKEN`), 2–3 CI
variables, and TWO manual workflow dispatches. Verified defects ride along: the GitHub
templates' skip-guard keys on a `CI_RUNNER` variable documented in no runbook
(`ciTemplates.ts:124,308`), so a faithfully-configured estate job silently never runs; and
a `ccp-data.yml` committed pre-trust — which `ccp/docs/onboarding-runbook.md:67-70`
explicitly recommends — fails red on every merge until the upload key exists
(`scripts/gen-project-data.sh:360-361`).

The constraints are the product: the two-admin trust ceremony and two-admin first-data
activation stay (`ccp/docs/onboarding-security.md`); the scan executes nothing and estate
CI never runs terraform; the control plane never checks out repos and never holds repo
credentials; and the pre-trust onboarding token and post-trust upload token have
exact-inverse mint gates so their lifetimes never overlap (`ONBOARDABLE = {draft,
pending-trust}`, `ccp/api/src/routes/projects.ts:391,543,706`; `UPLOADABLE = {trusted,
ready}`, `ccp/api/src/routes/projectData.ts:71,129,217` — "the two must never be
cross-usable", `projects.ts:373`).

## Decision

Collapse the estate-side surface, touching no API route, no CLI, and no trust code:

1. **One CI file per host.** `.github/workflows/ccp.yml` (and
   `.gitlab/ci/ccp.gitlab-ci.yml`) replaces the onboard/data file pair: a dispatch-only
   `onboard` job behind a `lane` choice input (default `onboard`), and the `data` job on
   the default-branch push trigger plus `lane=data` dispatch. Byte-pinned to the wizard
   verbatim, as today (`ccp/app/src/test/projectsLifecycle.test.ts:511-558`). The
   no-terraform template assertion now covers both lanes in one body — strictly stronger
   than today, where it covered only the onboard files (`projectsLifecycle.test.ts:583-590`;
   the data generator's only "terraform" strings are comments,
   `scripts/gen-project-data.sh:64,211`). The skip-guard becomes
   `if: vars.CCP_PROJECT_ID != ''` — a variable the estate sets anyway — retiring the
   undocumented `CI_RUNNER` requirement; and the data job exits neutrally with a loud
   notice (instead of red) while the upload key doesn't exist yet.
2. **One setup block.** The wizard emits a prefilled `gh`/`glab` command block that sets
   the secret (via stdin prompt — the token never rides a command line, extending the
   env-only rule of `ciTemplates.ts:19-21` / `projectsLifecycle.test.ts:571-573`) and both
   CI variables in one go; the settings-page path stays documented as the fallback.
3. **The second dispatch becomes optional.** After trust and the upload key, the next
   merge to the default branch produces the first staged data; the wizard adds a
   "run it now" deep-link (lane=`data`) as a convenience only.
4. **Two credentials stay — explicitly reaffirmed.** A single token identity whose
   authority derives from project status was considered and **rejected as a weakening of
   the token-separation invariant**: the one string would be distributed during the
   untrusted window, and trust-ack would retroactively upgrade a credential whose custody
   predates the vetting. The upload key stays born-after-trust by a deliberate admin mint;
   auto-minting at ack is also rejected (the one-time reveal needs a present human).
   Server-side "set it in the repo for you" is rejected wholesale — the control plane
   never holds repo-write credentials.
5. **Form prefill, not inference.** Project id/display name get editable suggestions from
   the operator-entered repo name; cloud identity fields stay typed — the credential-free
   static scan has nothing trustworthy to detect them from, and the operator's assertion
   is part of what the two admins review.

Headline: ~12 operator actions → 7 (8 with an immediate first data run). Unchanged by
design: the four human approval actions and the two one-time token reveals.

## Options considered

### Option A: merged file + one-block setup + optional second dispatch (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low-Med (workflow YAML, `ciTemplates.ts` collapse 4→2, wizard copy, test reshape — zero server/CLI code) |
| Cost | ~2–3 days incl. both hosts' templates and doc sweep (13 files reference the old lane names) |
| Team familiarity | High — same byte-pin discipline, same lanes, same gates |

**Pros:** one setup PR and one drift-pinned file per host; 4–6 settings-page navigations
become one pasted block; kills two verified traps (silent `CI_RUNNER` skip, pre-trust red
X); no security-relevant code moves at all.
**Cons:** the merged file's dispatch needs a `lane` dropdown (one extra pick on the rare
manual data run); a typo'd upload-key secret name now skips politely instead of failing
red — compensated by the notice text and the wizard's visible "no uploads yet" state.

### Option B: single token identity, authority derived from status at request time
| Dimension | Assessment |
|---|---|
| Complexity | Med (new token type or gate rewrite on both routes) |
| Cost | ~2 days + the security argument |
| Team familiarity | High |

**Pros:** one secret to paste, once.
**Cons:** **weakens the separation invariant in intent** — the data authority would attach
to a string minted and distributed before any human vetted the repo; merges two audit
trails; destroys the exact-inverse mint gates that make the invariant mechanically
checkable. **Rejected.**

### Option C: control plane triggers/config-writes the estate repo itself
| Dimension | Assessment |
|---|---|
| Complexity | High (server-held repo credentials, per-host API surface) |
| Cost | ~1–2 weeks + standing credential custody |
| Team familiarity | Low |

**Pros:** true zero-touch repo setup and "run now".
**Cons:** the control plane starts holding repo-scoped write credentials — the same
surface ADR-0031's option B rejected, against the never-checkout posture's spirit.
**Rejected.**

## Consequences

- Easier: onboarding drops to 7 operator actions; one reviewed file wires a repo for its
  whole life; variable/secret-name typos largely disappear with the emitted block.
- Easier: the estate-CI trust-boundary prose lives in ONE file header per host, and the
  drift test's no-terraform pin covers the data lane for the first time.
- Harder: the byte-pinned template reshape is a 13-file rename sweep (ADR-0031's own
  mentions stay — immutable history); GitLab operators get one `include:` instead of two.
- Unchanged, by design: every invariant in `ccp/docs/onboarding-security.md`; both token
  types, their exact-inverse mint gates, and `POST /projects/:id/trust` byte-identical;
  estates already on the two-file layout keep working forever — consolidation optional.
- Revisit: if GitHub ever exposes secret-presence to job-level `if`, the `lane` input
  could be retired; if a real estate needs server-driven setup, that is option C's
  argument to have then, not now.

## Action items

1. [ ] Owner go/no-go on the merged-file + one-block direction (and the two plain-words
       questions: the polite pre-trust skip, and "run it now" as a link only).
2. [ ] Phase A: `ccp.yml` + GitLab twin; delete the four old lane files;
       `ciTemplates.ts` collapse; `projectsLifecycle.test.ts` reshape; 13-file
       reference sweep (incl. `gate.sh`, `gen-project-data.sh`, both runbooks,
       `onboarding-security.md`).
3. [ ] Phase B: wizard — shared file panel, provenance-aware step-4 copy, `gh`/`glab`
       blocks (token via prompt only, test-pinned), post-trust dispatch deep-link,
       form prefill.
4. [ ] Phase C: runbook walkthrough against one GitHub and one GitLab estate; flip to
       Accepted on the owner's word.
