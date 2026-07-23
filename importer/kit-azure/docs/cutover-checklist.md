# Cutover Checklist (per service / resource group)

Run this when declaring an Azure service "fully IaC-managed". It mirrors the AWS cutover
checklist ([importer/docs/cutover-checklist.md](../../../importer/docs/cutover-checklist.md)),
translated to Azure and to the kit's automated gates. The operator procedure is
[docs/runbooks/azure-subscription-import.md](../../../docs/runbooks/azure-subscription-import.md);
governance is [proposal 0039](../../../docs/proposals/0039-azure-second-provider-concept.md).

## Before

- [ ] Every import-disposition resource for this service is in `imports.tf`, emitted solely
      by [../gen-imports.py](../gen-imports.py) (blocks carry only type/label/id —
      never an attribute value, so no secret enters git through them).
- [ ] Coverage reconciled: [../reconcile.py](../reconcile.py) `--strict` shows **no
      `COVERAGE_GAP`** — every manifest `import` row was actually handled, nothing silently
      skipped by aztfexport.
- [ ] **Import-only plan verified:** [../verify.sh](../verify.sh) `--phase import`
      passes — `Plan: N to import, 0 to add, 0 to change, 0 to destroy` (fmt clean,
      validate clean, imports only, zero mutations).
- [ ] **Stateful resources carry `prevent_destroy`:** [../normalize.py](../normalize.py)
      `guard` has inserted `lifecycle { prevent_destroy = true }` on every stateful-type
      resource, and Azure-side protection is on (resource lock / Key Vault soft-delete +
      purge protection / database backups within retention).
- [ ] **Secret-literal check clean:** `normalize.py check` against
      [catalog/azure-redaction-rules.json](../../../catalog/azure-redaction-rules.json) finds
      no secret literals in the generated HCL.
- [ ] Runbooks reviewed by the on-call owner.

## Cutover

- [ ] Apply the imports through the gated `prod` PR lane (CI only — never a local apply;
      the one hand-applied stack is the Phase-0 bootstrap).
- [ ] **Steady no-op:** after the apply and archival, `verify.sh --phase steady` exits 0 —
      `terraform plan -detailed-exitcode` shows a true no-op.
- [ ] Make one trivial, real change (e.g., add a tag) via PR → CI apply; verify it lands in
      Azure.
- [ ] **Archive `imports.tf`** to `importer/kit-azure/<env>/` and remove the import blocks from
      the live root (a completed import block is inert; keep it as the record of what was
      adopted).
- [ ] Revoke/limit portal write access for this service's resources (Azure RBAC to Reader
      for most humans; locks where appropriate).
- [ ] Announce in the team channel: "changes to X now go through the IaC repo".

## After (first 2 weeks)

- [ ] **Drift job wired** and green for 14 consecutive days
      ([runbook](../../../docs/runbooks/drift-detection.md)). Security-posture drift is
      surfaced and reverted, never adopted.
- [ ] No emergency portal changes — or all reconciled per
      [runbook](../../../docs/runbooks/emergency-changes.md).
- [ ] Manifest + topology docs updated.
