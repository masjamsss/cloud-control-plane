# Onboarding security — the untrusted-repo trust boundary

`catalogctl onboard` imports an arbitrary Terraform repository into Cloud Control Plane as a
new project. The repository is **untrusted input** until a Lead explicitly
trust-acks a specific commit. This document is the trust boundary in plain words:
what runs, in what order, and why. The order is not an implementation detail — it
is the security property.

## The ordered pipeline (order is the security property)

`catalogctl onboard <path> --project-id <id> [--trusted-commit <sha>]` runs:

1. **Record `commitSha`** — `git rev-parse HEAD` of the repo (best-effort).
2. **Pre-scan** — a pure static parse (`hashicorp/hcl/v2`). Nothing is executed:
   no `terraform init`, no provider download, no evaluation of repo expressions.
   The full report — verdict, findings, census — is persisted as
   `prescan-report.json` on **both** verdicts (0033 §3): the Lead reviews those
   exact bytes, never a vanished stdout. On any finding the verdict is `reject`;
   the command prints the findings and exits `2`. **No `terraform init` — no
   runner call of any kind — happens for a rejected repo.** This is unit-tested
   with a fake runner that must record zero calls, including for a provisioner
   hidden in `*.tf.json` syntax.
3. **Trust request** — for a clean repo with no `--trusted-commit`, the command
   writes `trust-request.json` (`repo`, `commitSha`, `prescanSha256`) and stops
   with exit `0`. The `prescanSha256` binds the ack to the exact scanned bytes —
   it is `sha256(prescan-report.json)`, and ccp-api recomputes it over the
   uploaded report bytes at `PUT /projects/:id/trust-request`, refusing a
   mismatch (`PRESCAN_SHA_MISMATCH`).
4. **Lead trust-ack** — a Lead with `isAdmin` uploads both artifacts and reviews
   the rendered verdict/findings in the Cloud Control Plane admin UI (`/admin/projects`
   wizard, step 3). The trust decision is dual-controlled: the Lead's confirm
   proposes; a second distinct admin's ack applies it, recording audit action
   `Trusted repo for onboarding` with the `commitSha` and `preScanReportSha256`
   (ccp-api `POST /projects/:id/trust`; a `reject` verdict is refused —
   `TRUST_VERDICT_NOT_CLEAN` — so no rejected repo can ever be trusted). The CLI
   proceeds only when the supplied `--trusted-commit` matches HEAD; a mismatch
   refuses (`UNTRUSTED_COMMIT`, exit `2`) with **no runner call**.
5. **Required-version gate** — if the installed Terraform cannot satisfy the
   repo's `required_version`, the command refuses (`VERSION_UNSATISFIED`) before
   invoking Terraform.
6. **Sandboxed `init` + `providers schema`** — only now, on a trusted repo, does
   `terraform init -backend=false -input=false` then
   `terraform providers schema -json` run, producing `providers-schema.json`.
7. **Empty-inventory guard** — if the pre-scan counted resources but extraction
   produced none, the command refuses (`EMPTY_INVENTORY`) rather than scaffold a
   silently-empty import.
8. **Scaffold checklist** — the census report (module count, fmt-dirty count,
   `.tf.json` count, provider pins) plus the extractor commands to fill
   `public/projects/<id>/`.

## What pre-scan rejects

Each rule maps to a machine-readable finding code; any finding ⇒ verdict
`reject`. The walk covers **both** `*.tf` (native HCL) and `*.tf.json` (JSON
syntax), so an evasion written in JSON is caught exactly as in HCL.

| Code | Rejected construct |
|------|--------------------|
| `DATA_EXTERNAL` | any `data "external"` block (arbitrary program execution at plan time) |
| `PROVISIONER` | any `provisioner` block, nested anywhere, including a `dynamic "provisioner"` |
| `PROVIDER_SOURCE` | a `required_providers` source outside the project's provider allowlist (default `registry.terraform.io/hashicorp/*`) |
| `MODULE_SOURCE` | a `module` source that is neither a relative path nor an allowlisted registry namespace (git/VCS/HTTP/bucket sources fail closed) |
| `NONSTATIC_SOURCE` | any provider or module `source` that is not a static string literal (a `var`/`local`/expression) — fail-closed, so a source cannot be hidden behind indirection |

## Why `-backend=false`, always

The wrapper (`tools/catalogctl/sandbox/run.sh`) enforces `-backend=false` itself,
never by convention. An untrusted (or even a trusted-but-imported) repo must
never cause Cloud Control Plane to negotiate a real state backend — for example the live
production state bucket declared in the estate repository's `backend.tf`. Schema
extraction needs providers, not state, so the backend is disabled outright.

## Why no credentials may exist in the environment

The wrapper asserts the environment carries no `AWS_*`, `GOOGLE_*`, `ARM_*`, or
`TF_TOKEN_*` variable and exits non-zero if any is present. Combined with the
read-only-AWS rule, this means the schema step cannot authenticate to any cloud
or private registry: the worst an adversarial repo can do during onboarding is
attempt an unauthenticated provider download from the public registry, over a
network restricted to the two registry hosts.

## The in-repo exception

A self-trusted in-repo root — notably `importer/bootstrap`, the second project
used to prove multi-project onboarding — carries intrinsic trust (it lives in
this repository and is reviewed like any other file here). Its schema step may
therefore run the wrapper **host-side**, with the identical `-backend=false` and
no-credentials guarantees. **External** repositories get no such exception: they
must run inside the container (`tools/catalogctl/sandbox/Dockerfile`) with the
egress-restricted network, read-only bind mount, and non-root user.

## Where the first scan may run

The pre-scan stage (step 2 above) can be started from three places. The invariants on this
page apply identically wherever it runs — moving WHERE it starts never moves WHAT is allowed
to happen:

1. **A laptop**, in a credential-free shell — `catalogctl onboard`, unchanged, the original
   path. Kept as the fallback for an air-gapped estate, or one with no usable CI
   (`ccp/docs/onboarding-runbook.md` step 2, "Run locally").
2. **The estate repository's own CI** — a dispatch-only workflow
   (`.github/workflows/ccp-onboard.yml` / `.gitlab/ci/ccp-onboard.gitlab-ci.yml`), the
   recommended path (`ccp/docs/onboarding-runbook.md` step 2, "Run in the repo's CI"). This
   runs the SAME `catalogctl onboard` binary with NO `--trusted-commit`, so it stops at the
   trust gate by construction (`onboard.go:140-157`) before the required-version gate or any
   runner call (`onboard.go:163-194`, unreached). The workflow's own `permissions:
   contents: read` and total absence of a terraform setup step or a cloud secret are the same
   guarantee, restated at the CI-config level. The two artifacts travel to the control plane
   over a narrow, pre-trust-only onboarding token — `PUT /projects/:id/trust-request` with
   `Authorization: Bearer <tokenId>.<secret>`, minted by `POST /projects/:id/onboard-tokens`
   (legal only while draft/pending-trust — the *inverse* of the CI upload token's
   trusted/ready gate, so the two credentials' lifetimes never overlap; argon2id at rest,
   shown once, revocable, rate-limited, audited — `ccp/api/src/routes/projects.ts`). This lane
   authorizes EXACTLY that one verb: it cannot trust, cannot read, cannot upload data, cannot
   touch any other project.
3. **The control plane itself never runs it, either way.** The api process never checks out a
   repository and never invokes terraform (`ccp/api/src/routes/projects.ts`) — it only
   verifies uploaded bytes and records a human decision. Neither the laptop path nor the
   estate-CI path changes this; both are producers the api receives artifacts from, nothing
   more.

**The two-admin trust ceremony is identical regardless of transport.** Whichever path produced
`trust-request.json` + `prescan-report.json`, the SAME code path validates them (sha binding,
strict parse, artifact-disagreement refusal, status gate) and the SAME dual-controlled
`POST /projects/:id/trust` decides trust — a Lead proposes, a second distinct admin acks, and
a `reject` verdict can never be trusted (`TRUST_VERDICT_NOT_CLEAN`). The upload schema also
carries an optional, strictly validated `ci: {host, runUrl}` provenance block the two
reviewing admins can cross-check against the repository's own Actions/pipeline log —
provenance for the human review, never a substitute for it. It is stored and rendered wherever
present; the `ccp-onboard.yml` / `ccp-onboard.gitlab-ci.yml` workflows do not populate it yet
(`catalogctl onboard --server`'s upload body carries only the trust-request triple and the raw
report — see `tools/catalogctl/internal/onboard/upload.go`), so today it is populated only by
a caller that fills it in directly against the same endpoint; teaching the CLI or the workflow
to fill it in automatically is a natural, still-open follow-up.

**Hard rule: do not add a `--trusted-commit` step to the estate-CI workflow.** The post-trust
schema step (`terraform init -backend=false` + `providers schema`, `onboard.go:180-194`) is
EXECUTION against a now-trusted repository's code, and "The in-repo exception" above only ever
licenses that execution in two places: host-side, for the self-trusted in-repo root
(`importer/bootstrap` and this repository's own tooling); or inside the sandbox container
(`tools/catalogctl/sandbox/Dockerfile` — egress restricted to the two registry hosts,
read-only bind mount, non-root user), for every external repository. A GitHub-/GitLab-hosted
estate runner is neither of those: it is not the sandbox container, and an estate repo is not
the self-trusted in-repo root. Adding `--trusted-commit` to `ccp-onboard.yml` or
`ccp-onboard.gitlab-ci.yml` would run the schema step, unsandboxed, against an external
repository's code on that runner — a real execution-boundary violation, not a paperwork one.
If a CI-run schema step is ever wanted, it must ship the sandbox container first; nothing in
this design licenses it without that.

## Standing invariants for every onboarded project

- Blocks for any project are generated only through the redacting extractor; the canonical `catalog/redaction-rules.json` always applies, an optional per-project extension may add rules, and the extension's absence never disables the canonical rules (fail-closed).
- Onboarding and every project's request path are deterministic code — no AI component anywhere (ADR-0007), for imported projects exactly as for sample.
- An onboarded project gains no apply path; no project — imported or sample — may arm apply until the approved-plan = applied-plan digest guard exists for that project.
- `catalogctl edit`'s `FMT_DIRTY` refusal applies unchanged to onboarded projects — a non-canonical imported file is refused, never reformatted or corrupted; onboarding reports the fmt-dirty file count with the remediation (`terraform fmt -recursive` as a one-time normalization PR).

## Provider-version binding (0007 C1)

`forcesReplace` (ForceNew) labels are audited against a specific provider
version. An imported project's day-2 ops MUST NOT be enabled until the ForceNew
map has been rebuilt and passed at that project's pinned provider version;
`project.json` records the pin as `providerTag`, and the map is version-tagged.
