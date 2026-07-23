# catalogctl onboard sandbox

The committed contract for the schema-extraction step of `catalogctl onboard`
(spec §6.3). Docker is **not** installed in the build environment — this
directory is paper-verified: the guarantees are readable from the files.

## Files

- `run.sh` — the fail-closed wrapper. Asserts the environment carries no
  `AWS_*` / `GOOGLE_*` / `ARM_*` / `TF_TOKEN_*` credential (exit 1 otherwise),
  then runs `terraform init -backend=false -input=false` and
  `terraform providers schema -json`. `-backend=false` is enforced by the script,
  never left to convention, so the repo's real state backend (e.g. the live prod
  bucket) is never negotiated.
- `Dockerfile` — `FROM hashicorp/terraform:<pinned>`, a non-root `onboard` user,
  and the wrapper as entrypoint.

## Required run-time invariants (enforced by the caller)

- `--network` restricted to the two registry hosts (`registry.terraform.io`,
  `releases.hashicorp.com`); no other egress.
- `--read-only` container with the clone bind-mounted read-only (`:ro`).
- No cloud/registry credentials in the environment.
- Non-root user, hard timeout.

## In-repo exception

A self-trusted in-repo root (e.g. `importer/bootstrap`) may run the wrapper
**host-side** with the same `-backend=false` + no-credentials guarantees, because
its trust is intrinsic. **External** repos MUST use this container. The full
trust boundary is documented in `ccp/docs/onboarding-security.md`.
