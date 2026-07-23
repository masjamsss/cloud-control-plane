# Cloud Control Plane

A self-service **change-management control plane for Terraform-managed AWS estates**.
Engineers request changes through a reviewed web portal; the system turns each request into
a **Terraform pull request** that a human approves and CI applies. Forms in, reviewed PR
out — no console edits, every change auditable.

This is the open, estate-agnostic core of the tool. It ships **blank**: on first run an
operator onboards their own organisation, accounts, teams, and catalog — nothing about any
particular company is baked in.

## What's in the box

| Component | Path | What it is |
|---|---|---|
| **Portal (web app)** | `ccp/app` | Vite + React 19 + TypeScript-strict SPA — the self-service UI: catalog, change requests, approvals, drift, admin. |
| **API** | `ccp/api` | Node/Hono backend — authoritative state, auth (password + TOTP), the request→PR pipeline. |
| **catalogctl** | `tools/catalogctl` | Go HCL codemod — the only thing that writes Terraform. Deterministic, golden-tested edits. |
| **schemadump** | `tools/schemadump` | Provider-schema reflector (surfaces `ForceNew` ground truth the Terraform CLI omits). |
| **importer kit** | `importer/kit`, `importer/kit-azure` | Toolkit for adopting an existing environment into Terraform (import-first onboarding). |
| **catalog** | `catalog/` | Redaction rules and capability ledgers the portal's action manifests are checked against. |
| **publish gate** | `scripts/publish-gate.sh` | The safety scanner that keeps estate-specific values out of this public tree. |

## How it works (the short version)

1. An engineer picks a catalog action in the portal (e.g. *resize an instance*, *add a tag*)
   and fills in a small form.
2. The API validates it against the action manifest, then `catalogctl` rewrites the relevant
   Terraform and opens a **pull request**.
3. A reviewer reads the plan on the PR and approves; CI applies it behind a gated environment.
4. Drift and out-of-band changes are surfaced back in the portal for triage.

The design principle throughout: **the running system reads its estate — organisation name,
accounts, region, teams, catalog — from configuration and first-run setup, never from
hard-coded values.** A fresh install starts empty and onboards the operator's own data.

## Getting started

```bash
# Portal + API (Docker)
cd ccp && cp .env.example .env   # then edit; ccp/scripts/setup.sh helps
docker compose up

# catalogctl (Go 1.25+)
cd tools/catalogctl && go build ./... && go test ./...

# Portal dev server (Node 20+)
cd ccp/app && npm ci && npm run dev
```

See `ccp/docs/` for the API spec, domain model, permissions, settings catalog, and the
onboarding runbook.

## Documentation

- **Product intent:** [`PRD.md`](PRD.md)
- **API / domain / permissions / settings:** [`ccp/docs/`](ccp/docs/)
- **Architecture decisions:** [`docs/adr/`](docs/adr/)
- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md) · **Security:** [`SECURITY.md`](SECURITY.md)

## Status

Actively developed. The self-service portal and the request→reviewed-PR pipeline are the
mature core; hands-off auto-apply is a documented direction, not a shipped feature — changes
land through the reviewed-PR path today.

## License

[Apache-2.0](LICENSE). The provider capability catalogs under `catalog/` and
`tools/schemadump/` are generated from the published schemas of HashiCorp's
`terraform-provider-aws` and `terraform-provider-azurerm` (MPL-2.0) — see
`tools/schemadump/README.md` for attribution.
