# importer/kit-azure — the reusable Azure-estate importer

The parameterized machinery for taking an existing **Azure** subscription from zero →
imported Terraform code → ready for Cloud Control Plane onboarding. It is the Azure
sibling of [`importer/kit`](../../importer/kit/README.md) and ports it file-for-file; the
two kits are intended to read as siblings. It provides the automated, pinned tooling for the
"draft the import" step of the per-subscription ceremony in
[docs/runbooks/azure-subscription-import.md](../../docs/runbooks/azure-subscription-import.md)
(Stage 3). Direction + rationale: [ADR-0015](../../docs/adr/0015-ccp-azure-second-provider.md)
and the Azure second-provider concept (internal design doc, not published).

```
kit/
├── azure-services.json  resource-type allowlist (DATA): fixed ARG graphCaptures + per-type
│                        typeHint/service/phase/stateful/providerHint + a manual[] long-tail
├── discover.sh          LIVE capture driver — the ONLY thing that talks to Azure
│                        (read-only `az graph query` + one `az account show` identity check;
│                        dual subscription+tenant GUID guard; --dry-run; skip-token paging)
├── discover.py          captures -> discovery-manifest.json (offline, stdlib-only) +
│                        full Microsoft.Provider/type coverage classification
├── gen-imports.py       manifest -> imports.tf (the SOLE import-block emitter; stdlib-only)
├── reconcile.py         inverts aztfexport's silent best-effort into loud gaps (stdlib-only)
├── run-aztfexport.sh    pinned, STATE-FREE --hcl-only wrapper around Microsoft's aztfexport
│                        (bodies only; a tripwire refuses if any *.tfstate appears)
├── normalize.py         scaffold / split / guard / check (needs python-hcl2 == 5.1.1)
├── verify.sh            acceptance gates: fmt clean, validate clean, plan import-only or no-op
├── templates/           versions/providers/variables/main/backend/tfvars — azurerm + azapi pins
├── testdata/            recorded synthetic captures + stub az/terraform/aztfexport binaries
│                        (fixture subscription 00000000-… — the kit NEVER needs real Azure to test)
└── tests/               python3 -m unittest discover -s importer/kit-azure/tests
```

## Status — the exporter under Azure-as-second-provider

Azure is the **accepted** second cloud provider
([ADR-0015](../../docs/adr/0015-ccp-azure-second-provider.md), concept
the Azure second-provider concept (internal design doc)). This kit is the
read-only **exporter**: the automated, pinned tooling for the step the import runbook still
describes as manual — *"`aztfexport` … the scope … and the flag that emits native `import {}`
blocks … is not pinned in this repo"*
([azure-subscription-import.md](../../docs/runbooks/azure-subscription-import.md) Stage 3). It
**complements, does not duplicate**, the committed Azure bootstrap
([`importer/bootstrap-azure/`](../../importer/bootstrap-azure/README.md): state backend + federated
CI identities) and the control-plane capability data
([`catalog/azure-capability-ledger.json`](../../catalog/azure-capability-ledger.json)). Nothing here
runs against a cloud on its own or changes the AWS estate: discovery is read-only under the built-in
**Reader** role, and the apply lane is armed last per ADR-0015 — this kit stops at a clean,
plannable, import-only Terraform root.

## Why aztfexport for bodies only

The kit **owns** the risky, repo-defining parts (read-only discovery, coverage, curation,
import-block emission, the no-op-plan gate) and delegates ONLY schema-accurate HCL-**body**
generation to Microsoft's [aztfexport](https://github.com/Azure/aztfexport), run strictly in
`--hcl-only` mode. Two properties fall out of that split:

- **`gen-imports.py` is the sole emitter of `imports.tf`.** aztfexport can emit import blocks
  too; the kit never lets it. Keeping emission here means the plannable PR artifact is
  deterministic, stdlib-only, and **secret-free by construction** (a block carries only
  type/label/id, never an attribute value).
- **Read-only correctness never hard-depends on the external binary.** aztfexport raises HCL
  fidelity where `aztft` maps a type, and native `terraform plan -generate-config-out` is the
  guaranteed-safe fallback everywhere else. The only acceptance oracle is `verify.sh`'s no-op
  plan — never aztfexport's exit code.

`reconcile.py` closes the loop: aztfexport's default is best-effort and **silent** (with
`--continue` it drops what it cannot map). `reconcile.py` set-diffs the Azure Resource Graph
ground truth against aztfexport's `aztfexportResourceMapping.json` and turns any unmapped /
skipped / errored resource into a loud manifest array or a hard `REFUSE COVERAGE_GAP` — the
repo's gaps-are-loud rule, restored around a silent engine.

## 60-second fixture demo (no Azure, no credentials)

```bash
python3 importer/kit-azure/discover.py build \
  --capture-dir importer/kit-azure/testdata/capture-happy \
  --out /tmp/az-demo/discovery-manifest.json
python3 importer/kit-azure/gen-imports.py \
  --manifest /tmp/az-demo/discovery-manifest.json --out /tmp/az-demo/imports.tf
head -30 /tmp/az-demo/imports.tf
```

## Pipeline (one line per phase — the runbook has the full procedure)

1. **Discover** (read-only Reader creds): `discover.sh --subscription S --tenant T --out work/<env>/`
   → per-capture ARG pages + `discovery-manifest.json`. Everything undiscoverable is IN the
   manifest (`missing_captures`, `unmapped_captures`, `manual_followup`,
   `coverage.unrecognizedResourceTypes`) — gaps are loud, never silent.
2. **Curate**: edit labels/dispositions in the manifest (`--classify`).
3. **Reconcile**: `run-aztfexport.sh --mode mapping` → `aztfexportResourceMapping.json`;
   `reconcile.py` set-diffs it against the manifest (loud gaps / `--strict` refuse).
4. **Generate**: `gen-imports.py` → `imports.tf`; `normalize.py scaffold` → root files; copy both
   into `environments/<env>-azure/`; then `run-aztfexport.sh --mode hcl` (or `terraform plan
   -generate-config-out=generated.tf`) for the bodies.
5. **Normalize**: `normalize.py split` (per-service files) → `guard` (prevent_destroy on stateful)
   → `check` (secret-literal refusal battery, `catalog/azure-redaction-rules.json`).
6. **Verify + apply**: `verify.sh --phase import` (plan must be *N to import, 0/0/0*), PR, apply
   with the Reader + Storage-Blob-Data-Contributor identity, archive `imports.tf` to
   `importer/kit-azure/<env>/`, `verify.sh --phase steady`.
7. **Hand off to Cloud Control Plane**: `catalogctl onboard environments/<env>-azure …`.

## From imported root to onboarded estate — the portal bridge

The kit's job ends at step 7 above: a clean, plannable Terraform root and the
first `catalogctl onboard` scan. Everything downstream is the SAME
register → trust → CI-generate/upload → activate ladder every account rides,
regardless of provider — provider is a property of the *project*, not of the
onboarding mechanism ([ADR-0015](../../docs/adr/0015-ccp-azure-second-provider.md)) —
including the very first account onboarded onto a fresh install (data-birth,
the data-birth onboarding design (internal design doc, not published)
§6):

1. **Register** the project in Admin → Projects — for an Azure estate this
   step asks for the tenant id and subscription id (both GUIDs) and the
   location instead of an AWS account id/region. A draft grants nothing yet.
2. **Scan locally, credential-free** (step 7 above): `catalogctl onboard
   environments/<env>-azure --project-id <id> --out out/` writes
   `trust-request.json` + `prescan-report.json`; upload both in the wizard.
3. **Trust** (two admins): a Lead reviews the verdict and proposes trust; a
   second, different admin acknowledges it under Admin → Pending changes.
   Only a clean verdict can be trusted.
4. **Generate and upload the estate's data**: install
   `.github/workflows/ccp-data.yml` (or the GitLab twin) in the estate
   repo that now holds `environments/<env>-azure/`, pointing
   `CCP_SCAN_ROOT` at that root — full setup in
   [docs/runbooks/account-data-ci.md](../../docs/runbooks/account-data-ci.md)
   (the same generic job as the AWS kit; it scans whatever Terraform root it
   is pointed at). Every merge to the default branch re-scans and PUTs a
   staged data bundle to the control plane. Generation is deterministic CI
   tooling, never portal-triggered and never AI-assisted (ADR-0007) — the
   portal only stages what CI uploads.
5. **Activate** (two admins): a second admin activates the staged version —
   the project flips ready, appears in the project switcher, and is served
   at runtime. No app rebuild, no redeploy.

The full operator walkthrough — wizard steps, the status ladder, and the
failure-mode table — is
[ccp/docs/onboarding-runbook.md](../../ccp/docs/onboarding-runbook.md).
Nothing in this bridge grants an apply path: onboarding a data plane and
applying Terraform changes are separate lanes end to end.

## Discovery model — Azure Resource Graph

Where the AWS kit issues one `describe`/`list` call per service, the Azure kit issues a small
**fixed** set of `az graph query` captures (`graphCaptures` in `azure-services.json`) because
Azure Resource Graph is one unified, read-only inventory API. The primary `Resources` query is
BOTH the resource source and the account-wide coverage sweep — so, unlike the AWS tagging-API
sweep, it is **not** "taggable only": it sees all ARM control-plane resources. `discover.py`
classifies every swept row at full `Microsoft.Provider/type` granularity into
covered / manual / unrecognized — a strict upgrade over the AWS kit's coarser ARN-service-family
bucket. ARG pages at 1000 rows; `discover.sh` follows the `skip_token` (a `kql` containing
`limit`/`take`/`sample` is refused, because those suppress the token and would silently truncate).

## Multi-subscription estates

A tenant almost always spans **many** subscriptions (often under one management group), and the
kit imports **one subscription per run** — so estate coverage is a per-subscription loop, not a
single pass. Two things keep that safe *and* complete:

- **Enumerate first.** `discover.sh --list-subscriptions --tenant <tenant-guid>` lists every
  subscription the Reader can see in the tenant, with its management-group chain. It queries only
  the ARG `ResourceContainers` table (subscription metadata) — never resources — so it doesn't
  widen resource discovery beyond one subscription. A subscription it does **not** list is a
  Reader-RBAC gap (you lack read access): a loud, resolve-before-you-claim-coverage signal, not a
  silent hole. Track each listed subscription to *done* — an un-imported one is the estate-level gap.
- **Isolate per subscription.** Run the import once per subscription with a **distinct** capture
  dir, `environments/<env>-azure` root, and backend state key each. The dual subscription+tenant
  guard refuses a wrong-subscription capture, so runs cannot cross-contaminate. Management-group
  scope (adopting many subscriptions in a single pass) is deliberately out of scope — you iterate.

## Extending coverage

Add an entry to `azure-services.json` `types` (schema documented in the file), author a fixture
row under `testdata/capture-happy/resources.json`, and extend the tests. One ARM type maps to
exactly one Terraform type here; genuinely ambiguous types (Linux vs Windows VMs, web vs function
apps) and per-scope children (role assignments, diagnostic settings, subnets) belong under
`manual` — they surface in every manifest as `manual_followup` instead of silently missing.

## Stated limits, honestly

- **The `check` gate is line-oriented.** It matches an attribute *name* against
  `catalog/azure-redaction-rules.json`; it does **not** yet honor `maskAllValuesInBlocks`, so a
  secret under an arbitrary key inside an `app_settings` / Key Vault body block can pass. Close
  this with block-aware scanning before importing Function Apps / Key Vaults (proposal 0039
  *Honest limits*).
- **The no-op-plan oracle only runs against live Azure.** The fixture suite proves the kit
  correctly *handles* a canned aztfexport output and enforces every gate; it cannot prove
  aztfexport produced plan-clean HCL — `verify.sh` catches that at real-plan time.
- **One-provider-per-run.** aztfexport emits azurerm *or* azapi per run; the long tail that needs
  `azapi` is surfaced by `reconcile.py`, not silently dropped.

## Testing

```bash
pip install python-hcl2==5.1.1     # the repo-pinned version (terraform.yml); normalize.py only
python3 -m unittest discover -s importer/kit-azure/tests -v
```

Fixture-driven, subprocess-style (mirrors `importer/kit/tests` and
`ccp/app/scripts/test_build_inventory.py`); stub `az`/`terraform`/`aztfexport` binaries under
`testdata/stub-bin/` let the shell scripts' logic run with zero network and zero real toolchain,
and `clean_env()` strips every `AWS_*`/`ARM_*`/`AZURE_*` credential variable so no ambient
identity can reach a test. Like `importer/kit/tests`, these are a developer check, not (yet) a CI
gate.

## Hard rules

- Tests and fixtures NEVER touch Azure or `environments/**`. The live path is `discover.sh` only,
  with read-only Reader credentials, run by a human.
- Capture dirs contain real resource ids → keep them under `work/` (gitignored) or outside the repo.
- Nothing here applies Terraform. The import apply is a human, PR-reviewed step with the scoped
  Reader + Storage-Blob-Data-Contributor identity; the one intentional apply is the Phase-0
  bootstrap ([importer/bootstrap-azure/](../bootstrap/README.md)).
