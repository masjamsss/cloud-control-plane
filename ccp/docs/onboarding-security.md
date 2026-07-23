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
