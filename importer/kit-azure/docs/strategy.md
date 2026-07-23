# Migration Strategy: Portal-Managed Azure → Terraform

**Approach: import-first.** We bring existing Azure resources under Terraform management
*without recreating them*, in phases ordered by risk. Recreation is the exception
(disposition = Replace), never the default. This mirrors the AWS import-first strategy
([importer/docs/strategy.md](../../../importer/docs/strategy.md)), translated to Azure —
where one unified read-only inventory API (Azure Resource Graph) replaces AWS's many
per-service describe calls.

This is a **live** strategy for adopting an Azure estate with [the kit](..). Azure is the
**accepted** second cloud provider: see
[ADR-0015](../../../docs/adr/0015-ccp-azure-second-provider.md) and the concept
[proposal 0039](../../../docs/proposals/0039-azure-second-provider-concept.md). The step-by-step
operator procedure is
[docs/runbooks/azure-subscription-import.md](../../../docs/runbooks/azure-subscription-import.md).

## Guiding rules

1. **A no-op plan is the definition of done** for every import PR. `terraform plan` after
   import must show `No changes` (or only additive tag changes, explicitly listed in the
   PR). The kit enforces this two-stage: [../verify.sh](../verify.sh) `--phase
   import` requires an import-only plan (`N to import, 0 to add, 0 to change, 0 to
   destroy`), and `--phase steady` requires a true no-op (`plan -detailed-exitcode` = 0).
2. **Never destroy during migration.** `terraform destroy` is forbidden in shared
   environments; stateful resources get `lifecycle { prevent_destroy = true }` *before*
   import. The kit inserts these mechanically — [../normalize.py](../normalize.py)
   `guard` reads the `stateful` flag in [../azure-services.json](../azure-services.json)
   and adds the guard block, refusing rather than corrupting a resource that already has a
   lifecycle block.
3. **Small batches.** One service or one resource group per PR. If a plan shows a surprise,
   stop and understand it — never apply through a diff you can't explain. Coverage gaps are
   surfaced loudly by [../reconcile.py](../reconcile.py), never dropped silently.
4. **Freeze as you go.** Once a resource is imported, portal changes to it are banned
   (emergency runbook excepted).
5. **Dev first, prod last** within every phase.

## Phases

### Phase 0 — Foundations (before touching any resource)

The one-time bootstrap — the Azure analog of `importer/bootstrap`. This is the **single**
stack applied by hand; everything after it rides a gated PR. See doctrine: nothing else
applies Terraform.

- Create the state backend: a **Storage Account** (blob versioning on, TLS-only, public
  network access disabled, a private `tfstate` container) — the azurerm backend target.
- Stand up CI authentication with **Workload Identity Federation** (OIDC): a federated
  credential on a Microsoft Entra app / user-assigned managed identity, so CI needs **no
  client secret** and no long-lived credential. Humans authenticate via Entra ID SSO.
- Grant least-privilege **RBAC**: the plan/discovery principal gets built-in **Reader**
  (control-plane `*/read`, no `DataActions` — it cannot read Key Vault values or blob
  contents); the CI apply principal gets **Storage Blob Data Contributor** scoped to the
  state container so it can read and write state, plus whatever contributor scope the
  managed resources genuinely require.
- Repo + branch protection + CODEOWNERS + gated `prod` environment already exist
  ([../../../docs/cicd.md](../../../docs/cicd.md)); wire the Azure env root's backend to the new
  Storage Account.

### Phase 1 — Discovery & classification

- Run the [discovery guide](discovery-guide.md): [../discover.sh](../discover.sh)
  drives read-only `az graph query` sweeps behind a dual subscription+tenant guard and
  builds a `discovery-manifest.json`.
- Classify every resource (Import / Replace / Deprecate / Ignore) and assign owners. The
  kit's allowlist already tags each known type with a phase and a stateful flag;
  resources it cannot enumerate as top-level rows are surfaced as `manual_followup`.
- **Exit criteria:** manifest complete for the in-scope subscription; dispositions agreed;
  `manual_followup` triaged.

### Phase 2 — Low-risk, low-state resources

Resource groups, user-assigned managed identities, Log Analytics workspaces, Application
Insights, monitor action groups, public DNS zones.
- Practice the import workflow here; refactor generated HCL into per-service files with
  [../normalize.py](../normalize.py) `split`.
- **Exit criteria:** team fluent with import blocks; first per-service files extracted.

### Phase 3 — Networking (import, never recreate)

Virtual networks, subnets (a child-resource `manual_followup` — see the discovery guide),
network security groups, route tables, public IPs, network interfaces, NAT gateways, load
balancers, private DNS zones, private endpoints.
- Recreating networking breaks everything attached to it. Import in place; verify with
  no-op plans.
- **Exit criteria:** all network primitives imported per env; topology docs match reality.

### Phase 4 — Compute & services

AKS managed clusters, container registries, App Service plans, web apps / function apps
(one ARM type splits by `kind` — a `manual_followup`), virtual machines and scale sets
(the Linux/Windows/orchestration split is a `manual_followup`).
- Watch for attributes that force replacement — align config to live values first, and let
  the azurerm/azapi provider pins in [../templates/](../templates) hold the
  ForceNew story steady.
- **Exit criteria:** all Import-disposition compute under Terraform, no-op plans.

### Phase 5 — Stateful data stores ⚠️

Storage accounts (with data), Key Vaults, managed disks, Azure SQL databases, PostgreSQL /
MySQL flexible servers, Cosmos DB accounts, Recovery Services vaults.
- **Before import:** the kit's `guard` step inserts `prevent_destroy` on every stateful
  type *first* (rule 2). In parallel, confirm Azure-side protection: resource locks
  (`CanNotDelete`), soft-delete + purge protection on Key Vaults, geo-redundant backups /
  point-in-time restore on databases.
- Import during a quiet window; verify the plan is a no-op; test a trivial change (e.g., a
  tag) end-to-end through the gated PR lane.
- **Exit criteria:** data stores imported with protection verified in both Azure *and*
  code.

### Phase 6 — Lockdown & steady state

- Restrict portal write access for imported services (Azure RBAC scoped to Reader for most
  humans, deny-assignments / management locks where appropriate).
- Scheduled drift detection ([runbook](../../../docs/runbooks/drift-detection.md)); wire the
  Azure env root into the drift job. Security-posture drift is surfaced and **reverted**,
  never adopted.
- Deprecate-disposition resources cleaned up (backup → owner sign-off → delete).
- **Exit criteria:** drift job green for 2+ weeks; every Import row in the manifest is
  under Terraform with a no-op plan.

## Progress tracking

| Phase | Dev | Staging | Prod | Notes |
|---|---|---|---|---|
| 0 Foundations | ☐ | ☐ | ☐ | bootstrap applied by hand, once |
| 1 Discovery | ☐ | ☐ | ☐ | |
| 2 Low-risk | ☐ | ☐ | ☐ | |
| 3 Networking | ☐ | ☐ | ☐ | |
| 4 Compute | ☐ | ☐ | ☐ | |
| 5 Data stores | ☐ | ☐ | ☐ | |
| 6 Lockdown | ☐ | ☐ | ☐ | |
