# catalogctl

A Go CLI that applies a **manifest-declared operation** to real `.tf` files with
`hashicorp/hcl/v2`'s `hclwrite` — a deterministic HCL codemod, not a text-templating script.
It is **the only thing that writes Terraform** on Cloud Control Plane's behalf: neither the SPA
([`ccp/app`](../../ccp/app/)) nor the backend ([`ccp/api`](../../ccp/api/))
edits `.tf` files directly. See [`ccp/README.md`](../../ccp/README.md) for how the
three components fit together, and
[`docs/proposals/0012-review-is-the-gate-catalogctl-proposes.md`](../../docs/proposals/0012-review-is-the-gate-catalogctl-proposes.md)
for why "proposes, never applies" is the whole point: `catalogctl` writes a file; it never
runs `terraform apply`, and nothing here has AWS credentials.

## Prerequisites & install

| Needs | Version | Install |
|---|---|---|
| Go | `1.25` (pinned in [`go.mod`](go.mod)) | `brew install go` or https://go.dev/dl — CI resolves the version straight from `go.mod` (`go-version-file`), so there is exactly one source of truth; don't hardcode a version in a script or a second doc. |

No other runtime dependency — no Node, no Python, no Docker required to build or run the
golden tests (the [`sandbox/`](sandbox/) container is documented, not required, for local
work). Two Go modules live under `tools/`: this one and the sibling
[`../schemadump/`](../schemadump/) (`1.25.8`, its own `go.mod`) — they are independent
modules, not a shared build.

```bash
cd tools/catalogctl
go build -o catalogctl ./cmd/catalogctl
```

## Safety model

- **Guards are refusals, not exceptions.** Every unsafe or ambiguous edit exits **2** with a
  machine-greppable `REFUSE <CODE>: <reason>` line (`internal/cli.Refuse`) instead of writing
  anything. Categories seen across the codebase: destructive/replace guards
  (`FORCES_REPLACE`, `PREVENT_DESTROY`, `SHRINK`), targeting/resolution guards
  (`SELECTOR_AMBIGUOUS`, `MISSING_BLOCK_TARGET`, `PATH_NOT_FOUND`, `KEY_CONFLICT`,
  `ALREADY_EXISTS`, …), untrusted-repo prescan guards (`PROVISIONER`, `DATA_EXTERNAL`,
  `PROVIDER_SOURCE`, `MODULE_SOURCE`, `NONSTATIC_SOURCE`), and PR-bundle guards
  (`UNAPPROVED`, `TARGET_MISMATCH`, `DIGEST_DISAGREEMENT`, `EMPTY_DIFF`, `FMT_DIRTY`). Treat
  this list as illustrative, not exhaustive — grep `Refuse(` under `internal/` for the current,
  authoritative set; it changes as ops are added.
- **Exit codes are the contract** (spec §1): `0` ok · `2` refusal · `3`
  resolution/schema error · `1` internal error. Scripts and CI can dispatch on exit code alone.
- **`forcesReplace` and `exposure` are manifest data, not code.** Both are fields on the `Op`
  struct (`internal/manifests`), loaded from the `ServiceManifest` JSON that ships with
  `ccp/app`. `catalogctl` refuses a forces-replace edit unless the manifest says the op is
  meant to replace; it does not independently infer replacement semantics. This means the
  safety property is only as good as the manifest — see
  [`docs/superpowers/2026-07-11-catalogctl-census.md`](../../docs/superpowers/2026-07-11-catalogctl-census.md)
  for the measured gap between "manifest says safe" and "provider schema agrees." Provider
  documentation's "in-place update" labels have been found to miss real `ForceNew`
  attributes — see
  [`docs/superpowers/plans/2026-07-11-1-forcenew-verify-gate.md`](../../docs/superpowers/plans/2026-07-11-1-forcenew-verify-gate.md).
  Verify against `tools/schemadump`'s reflected schema, not provider docs prose.
- **`--dry-run` / `expected-diff`** prints the diff without writing (see Subcommands below) —
  the normal way to check an op before it touches a file.
- **Onboarding an untrusted repo is ordered on purpose**: prescan (pure static parse, nothing
  executed) always runs before any trust decision, and `terraform init` never runs for a
  rejected or untrusted repo. See
  [`ccp/docs/onboarding-security.md`](../../ccp/docs/onboarding-security.md) for the
  full trust boundary.

## Subcommands

The single entrypoint is `internal/cli.Run` (`cmd/catalogctl/main.go`); each subcommand
installs itself via its package's `init()`. Verified directly against
`internal/cli/cli.go` — this is the complete list, no more, no fewer:

| Subcommand | Package | What it does |
|---|---|---|
| `drift-propose` | `internal/driftpropose` | Deterministic drift adopt/revert proposal generator (spec [2026-07-20-ccp-drift-portal](../../docs/superpowers/specs/2026-07-20-ccp-drift-portal.md) §6): reads a stored `ccp.drift/v1` envelope + a scratch checkout, partitions every verdict into adopt / revert / not-generatable, and writes a digest-pinned `proposals.json`. Pure — no network, no AWS, no LLM, no wall-clock in the output. |
| `edit` | `internal/edit` | Applies one manifest op to a `ccp.request/v1` YAML's target HCL. The resolution pipeline + codemod dispatch (spec §2–§3). |
| `expected-diff` | `internal/edit` | Alias for `edit --dry-run` — prints the diff, writes nothing. |
| `onboard` | `internal/onboard` | The untrusted-repo onboarding orchestrator (spec §6.3–§6.4): prescan → trust-ack gate → sandboxed `init` + schema → census. See [Adopt Cloud Control Plane in a foreign repo](../../ccp/README.md#adopt-cloud-control-plane-in-a-foreign-repo) in the Cloud Control Plane README for the end-user flow. |
| `plan-check` | `internal/plancheck` | The mechanical L2 verifier (spec §6, proposal 0012): parses `terraform show -json` and enforces the planned diff is a subset of what the request asked for. Pure — no file access. |
| `pr-prepare` | `internal/prprep` | Turns an **approved** request into the bot-PR artifact bundle (edited `.tf`, the request, a plan-digest placeholder, PR body, redacted diff). Deterministic, fully offline — `gh pr create` is a documented seam, not executed here. |

Run `catalogctl <subcommand> -h` for real flag names — don't trust a copy of them pasted into
a second doc; verify against the package's `flag.NewFlagSet` calls directly (e.g.
`internal/onboard/onboard.go`'s `run()`).

### The `edit` verbs (12)

`internal/edit/edit.go` dispatches on the request's `codemodOp` through three tables — this
*is* the exhaustive list (grep `dispatch`, `fileDispatch`, `instantiateHandlers` in that file
to reconfirm, rather than trust a count in prose):

`set_attribute` · `set_attributes` · `append_foreach_entry` · `remove_foreach_entry` ·
`append_list_entry` · `remove_list_entry` · `append_block` · `set_association_attribute` ·
`swap_child_block` · `remove_block` · `moved_block` · `instantiate_module`

## Testing

```bash
cd tools/catalogctl
go build ./...
go vet ./...
go test ./...
gofmt -l internal/     # should print nothing
```

**Run tests from inside `tools/catalogctl/`, not the repo root.** The golden-fixture and
onboarding tests write scratch output under relative `testdata/...` paths; invoking them from
the wrong working directory has previously left stray empty fixture directories at the repo
root (since cleaned up — see
[`docs/proposals/0017-project-cleanup-plan.md`](../../docs/proposals/0017-project-cleanup-plan.md)).
`./scripts/gate.sh go` (from the repo root) already does this correctly — prefer it over a raw
`go test` invocation when in doubt.

**Golden tests** (`golden_test.go`, `plancheck_gate_test.go`, `plancheck_test.go`,
plus per-package `*_test.go`) diff real output against committed fixtures
under [`testdata/golden/`](testdata/golden/) (28 scenarios: `set-attribute`, `append-block`,
`remove-foreach`, `dynamic-target`, `swap-child-block`, `instantiate`, …) and
[`testdata/manifests*/`](testdata/) / [`testdata/onboarding/`](testdata/onboarding/) /
[`testdata/plans/`](testdata/plans/). Never hand-edit a
golden file to make a test pass — a failing golden is either a real regression or an
intentional behavior change that needs a reviewed fixture update.

The [`sandbox/`](sandbox/) directory documents (paper-verified; Docker isn't installed in the
build environment) the containerized, network-restricted, no-credential contract for the
schema-extraction step of `onboard` — see [`sandbox/README.md`](sandbox/README.md).

## Coverage census

The executable-coverage census (what fraction of the real capability catalog actually executes
a correct edit against the live estate) is generated by `scripts/census.sh` /
`scripts/census.py` (repo root) into
[`docs/superpowers/2026-07-11-catalogctl-census.md`](../../docs/superpowers/2026-07-11-catalogctl-census.md).
That doc is regenerated by a different lane — don't hand-edit it; re-run the script instead.

## Dependencies

Two direct Go module dependencies (see [`go.mod`](go.mod)): `hashicorp/hcl/v2` (parse/write
HCL — the whole codemod engine) and `gopkg.in/yaml.v3` (the `ccp.request/v1` schema). See
[`../schemadump/README.md`](../schemadump/README.md) for the sibling tool that reflects
provider schemas (including `ForceNew`, which `terraform providers schema -json` omits) —
`catalogctl`'s manifest-verification story depends on schemadump's output, not on provider
docs prose.
