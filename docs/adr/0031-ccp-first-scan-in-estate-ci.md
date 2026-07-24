# ADR-0031: The first onboarding scan runs in the estate repo's own CI — the control plane still never checks out repos

**Status:** Proposed (design lane; build gated on owner sign-off — spec:
[easy first import](../superpowers/specs/2026-07-24-easy-first-import.md))
**Date:** 2026-07-24
**Deciders:** Owner (Jamal) + maintainers

## Context

Onboarding a new estate repo is automatic *after* first trust — the repo's own CI
regenerates and uploads project data on every merge (`.github/workflows/ccp-data.yml`,
`docs/runbooks/account-data-ci.md`). Day zero is not: the wizard's step 2 requires a
laptop run of `catalogctl onboard` in a credential-free shell, then a copy-paste of the
two files it writes (`trust-request.json`, `prescan-report.json`) into the app
(`ccp/docs/onboarding-runbook.md:50-70`). The owner asked why the system cannot run
that scan itself.

The constraint is a deliberate security property, not an accident: the repo is
untrusted input until two admins ack a specific commit; the pre-scan is a pure static
parse with no execution, no cloud credentials, always `-backend=false`, and the
control-plane process never checks out repos or runs terraform
(`ccp/docs/onboarding-security.md`; `ccp/api/src/routes/projects.ts:51-53`). Any
"easier" path must preserve every one of those invariants, including the two-admin
trust ceremony — that ceremony is the security property, not the friction.

Two verified facts unlock a boundary-preserving path: (1) the two artifacts the server
needs are produced by prescan alone — a hermetic parse needing no terraform binary, no
network, no credentials (`tools/catalogctl/internal/onboard/onboard.go:79-124`); and
(2) the post-trust laptop run's output, `providers-schema.json`, has no server-side
consumer — `ready` requires only trust plus the first dual-controlled data activation
(`ccp/api/src/routes/projectData.ts:358-367`).

## Decision

The first onboarding scan moves to the **estate repository's own CI** as a one-shot,
operator-dispatched workflow (sibling of the recurring data lane): it runs the
unchanged `catalogctl onboard` pre-scan (no execution, no terraform, no cloud secrets)
and uploads the two artifacts to the existing `PUT /projects/:id/trust-request`
endpoint over a new, narrow, pre-trust **onboarding token** (mint: lead+isAdmin;
valid only while draft/pending-trust; argon2id at rest; shown once; revocable;
rate-limited; audited). As a complementary quick win on the same lane,
`catalogctl onboard` gains `--server`/`CCP_ONBOARD_TOKEN` so the local path becomes
one command with no paste. The two-admin trust ceremony, the sha binding, the ordered
pipeline, and the control plane's never-checkout/never-terraform posture are unchanged.

## Options considered

### Option A: one-shot scan in the estate repo's own CI (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Med (one token type, one Bearer lane on an existing endpoint, two workflow templates, wizard tabs) |
| Cost | ~3–4 days total with option C bundled |
| Team familiarity | High — clones the existing data-lane pattern (`ciTemplates.ts`, byte-pinned templates, token-authed PUT) |

**Pros:** no laptop, no paste; same architecture sentence as the data lane (repo's CI
runs next to the code, server verifies and records); adds reviewable CI provenance to
the trust review; nothing from the untrusted repo executes anywhere.
**Cons:** estate repo needs a one-time setup PR; a new (narrow) credential to operate;
GitLab's dispatch UX is clunkier.

### Option B: packaged scanner companion service dispatched by the control plane
| Dimension | Assessment |
|---|---|
| Complexity | High (new service/trust zone, repo read tokens held server-side, clone hardening) |
| Cost | ~2 weeks incl. hardening |
| Team familiarity | Low |

**Pros:** works for estates with no usable CI; keeps the scan out of the api process.
**Cons:** the *deployment* starts cloning untrusted repos and holding repo
credentials — the spirit of the never-checkout rule thins even where its letter
survives; significant new attack surface; duplicates what estate CI gives free.
**Deferred, not chosen.**

### Option C: `catalogctl onboard --server` direct upload (bundled quick win)
| Dimension | Assessment |
|---|---|
| Complexity | Low (~80 lines Go + tests on the option-A lane) |
| Cost | ~1 day once the lane exists |
| Team familiarity | High |

**Pros:** one command instead of run-then-paste-two-files; serves air-gapped/no-CI
operators; zero new authority (the token's scope caps it).
**Cons:** still a local run; needs the same server lane as A (shared, so effectively free).

## Consequences

- Easier: day-zero import becomes register → setup PR → "Run workflow" → two-admin
  trust → data lane dispatch → two-admin activate. No laptop, nothing hand-copied.
- Easier: the trust review gains provenance (CI run URL + commit) instead of an
  unverifiable laptop attestation.
- Harder: one more credential type (pre-trust onboarding token) to mint, revoke,
  audit, and document; two more byte-pinned CI templates to keep in drift-tested sync.
- Unchanged, by design: every invariant in `ccp/docs/onboarding-security.md`; the
  post-trust upload token still cannot exist before the human trust review.
- Revisit: option B only if a real estate materializes with no CI and no local path;
  running the post-trust schema step in CI would additionally require shipping the
  sandbox container invariants (`tools/catalogctl/sandbox/README.md:26-31`) — out of
  scope here and explicitly not licensed by this ADR.

## Action items

1. [ ] Owner go/no-go on A+C (and the token-TTL default, 24h proposed).
2. [ ] Phase 1: onboarding-token type + mint/revoke + Bearer lane on
       `PUT /projects/:id/trust-request`; `catalogctl onboard --server`; regen the
       code-derived docs.
3. [ ] Phase 2: `ccp-onboard.yml` + GitLab twin + `ciTemplates.ts` functions +
       drift-test pins + wizard step-2 tabs; runbook + security-doc updates.
4. [ ] Phase 3: demote the post-trust laptop run to a day-2 provider-audit task in
       the runbook; flip this ADR to Accepted on the owner's word.
