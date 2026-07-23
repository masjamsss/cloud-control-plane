# Azure Discovery Guide

How to enumerate everything that exists in an Azure estate before importing it —
**read-only, always**. This mirrors the AWS discovery guide
([importer/docs/discovery-guide.md](../../../importer/docs/discovery-guide.md)), but where AWS
needs a broad tag sweep plus dozens of targeted per-service `list`/`describe` calls, Azure
has **one** unified control-plane inventory API: Azure Resource Graph.

Output feeds `discovery-manifest.json`, built offline by
[../discover.py](../discover.py). The runnable driver is
[../discover.sh](../discover.sh); the operator procedure is
[docs/runbooks/azure-subscription-import.md](../../../docs/runbooks/azure-subscription-import.md).
Governance: [proposal 0039](../../../docs/proposals/0039-azure-second-provider-concept.md).

## 1. Unified sweep — Azure Resource Graph

Azure Resource Graph (`az graph query`) sees **all** ARM control-plane resources across a
subscription in one read-only query — not just taggable ones — so it is both the resource
source and the coverage sweep. There is no separate "untagged resources" pass to run.

```bash
# The primary whole-estate inventory query (from azure-services.json graphCaptures[]):
az graph query -q "Resources | project id, name, type, location, resourceGroup, subscriptionId, kind, tags | order by id asc" \
  --first 1000 --output json --subscriptions <subscription-guid>
```

The kit runs a small **fixed** set of these captures — `Resources`,
`ResourceContainers` (resource groups + subscriptions), `AuthorizationResources` (role
assignments), and `PolicyResources` (policy assignments) — enumerated as DATA from
[../azure-services.json](../azure-services.json). The queries are read-only
projections: they contain no `limit`, `take`, or `sample` (those suppress the paging skip
token and silently cap results at 1000 rows — `discover.py` refuses a query containing
them).

## 2. The `discover.sh` dual-guard flow

[../discover.sh](../discover.sh) is the only file in the kit that talks to Azure,
and it only ever runs the read-only `az graph query` verb plus one read-only
`az account show` identity check. Its flow:

1. **Dual identity guard.** Azure has no single "account" primitive, so the guard checks
   **both** axes: it refuses unless the active `az` context reports *exactly* the requested
   `--subscription` **and** `--tenant` (`SUBSCRIPTION_MISMATCH` / `TENANT_MISMATCH`). A
   wrong-subscription or wrong-directory capture dies here, not as a confusing manifest
   later. Both must be 8-4-4-4-12 GUIDs.
2. **Paginated, read-only captures.** Each fixed ARG query runs with `--first 1000`, and
   the **skip-token paging loop** follows every page (`discover.py next-token` reads the
   continuation token back — bash never parses JSON) so a >1000-row estate is never
   silently truncated.
3. **Provenance.** Writes `capture-meta.json` (subscription / tenant / location /
   capturedAt).
4. **Offline build.** Builds `discovery-manifest.json` via `discover.py build`, which
   re-checks the subscription+tenant offline. A capture that failed (RBAC/scope) is a loud
   `PARTIAL_CAPTURE` refusal, and its types appear under `missing_captures` — never
   quietly absent.

Run it against a **Reader** principal (control-plane `*/read`, no `DataActions`). The
capture directory holds real resource ids — keep it in `../work/` (gitignored) or
outside the repo. Preview the exact commands without touching Azure via `--dry-run`.

## 3. Classify every resource

The manifest tags each row with a disposition; confirm and assign owners:

- **Import** — in active use, bring under Terraform as-is (the default for known types).
- **Replace** — rebuild properly via IaC, then cut over.
- **Deprecate** — unused; confirm with owner, then delete manually (with backup).
- **Ignore** — Azure-managed / system resources (e.g. the SQL `master` database, which the
  allowlist skips with a recorded reason).

Classification is by the ARM resource `type` (`Microsoft.Provider/type`), which ARG returns
uniformly on every row — so the coverage sweep classifies at **full type granularity**, a
strict upgrade over the AWS kit's coarser ARN-service-family bucket. A type not in the
allowlist is reported as `unrecognized` (loud), never dropped.

## 4. Azure Resource Graph blind spots (surfaced as `manual_followup`)

ARG enumerates top-level ARM resources, but some things are not top-level rows. The kit
lists these in `azure-services.json manual[]` and copies them verbatim into every manifest
as `manual_followup`, so they are **never a silent gap** (the loud-gaps doctrine). Known
blind spots:

- **Child resources** — e.g. `azurerm_subnet`
  (`microsoft.network/virtualnetworks/subnets`) is a child of its virtual network and is
  not returned as its own row; enumerate per vnet (`az network vnet subnet list`).
- **Per-scope authorization/policy resources** — role assignments
  (`AuthorizationResources`), management locks, and policy assignments
  (`PolicyResources`) are scope-qualified; the kit captures the first and last into their
  own graph captures and flags the import-id shape for a deliberate adopt.
- **Per-target proxy resources** — diagnostic settings
  (`microsoft.insights/diagnosticsettings`) are enumerated per target resource
  (`az monitor diagnostic-settings list`), not as ARG rows.
- **One ARM type → several Terraform types** — `microsoft.compute/virtualmachines`
  (Linux vs Windows), scale sets (uniform vs orchestrated), and `microsoft.web/sites`
  (web app vs function app, Linux vs Windows) split on properties the default projection
  omits; disambiguate before mapping.
- **Soft-deleted Key Vaults** — a purge-protected, soft-deleted vault still holds the name
  and must be recovered or purged deliberately; it will not appear as a live `Resources`
  row.

Everything downstream of discovery — `gen-imports.py`, `reconcile.py`, `normalize.py`,
`verify.sh` — is offline and fixture-tested with zero real cloud.
