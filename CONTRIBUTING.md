# Contributing

Thanks for your interest in the Cloud Control Plane.

## Ground rules

- **Keep it estate-agnostic.** This is a product, not a deployment. Nothing about any
  particular organisation — names, account ids, regions, people, workloads — belongs in
  shared code, tests, or the catalog. Real values are operator configuration and first-run
  setup inputs. Demo and test data use neutral placeholders (`Sample`/`Example`, account
  `123456789012`, `example.com`).
- **Fixtures and golden files are the law.** Tests regenerate outputs from inputs via their
  harnesses; never hand-edit a golden to make a test pass. If an oracle looks wrong, stop and
  raise it.
- **Deterministic tooling.** `catalogctl` is the only thing that writes Terraform, and its
  edits are golden-tested — add a case, regenerate, review the diff.

## Development

| Area | Toolchain | Checks |
|---|---|---|
| `ccp/app` | Node 20+ | `npm ci && npm test && npm run build` |
| `ccp/api` | Node 20+ | `npm ci && npm test` |
| `tools/catalogctl` | Go 1.25+ | `go build ./... && go vet ./... && go test ./... && gofmt -l .` |
| `importer/kit` | Python 3.11+ | `python3 -m unittest discover -s importer/kit/tests` |

`scripts/gate.sh` runs the same checks locally that CI runs.

## Pull requests

- One focused change per PR; explain what and why.
- Green tests for every component you touched.
- Update the relevant doc under `ccp/docs/` or `docs/adr/` when behaviour or a decision
  changes.

## Reporting security issues

Please don't open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).
