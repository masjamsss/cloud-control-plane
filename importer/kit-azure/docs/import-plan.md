# Per-resource import workflow (Azure)

The Azure sibling of [`importer/docs/import-plan.md`](../../../importer/docs/import-plan.md): the
mechanical loop each resource goes through, from a discovered id to a no-op plan under Terraform.
The operator procedure that wraps this is [docs/runbooks/azure-subscription-import.md](../../../docs/runbooks/azure-subscription-import.md);
the phased ordering is [strategy.md](strategy.md).

## The loop (one batch — a service or a resource group — at a time)

1. **Import block.** `gen-imports.py --phase N` emits, into `imports.tf`, one
   `import { to = <type>.<label>  id = "<arm-id>" }` block per import-disposition resource. The
   block carries **only** type/label/id — no attribute values — so it is secret-free by
   construction. Copy `imports.tf` into `environments/<env>-azure/`.

2. **Generate the body.** For each block, produce the resource HCL:
   - **Preferred:** `run-aztfexport.sh --mode hcl` (Microsoft's `aztfexport`, `--hcl-only`,
     schema-accurate) for the types `aztft` maps.
   - **Fallback (guaranteed-safe):** `terraform plan -generate-config-out=generated.tf` for any
     type `aztfexport` cannot model. Native, no external binary, read-only.

   `reconcile.py --strict` first proves every ground-truth id was mapped — a gap is loud, never a
   silent drop.

3. **Refactor to live.** `terraform plan` will show diffs where the generated body does not match
   the live resource. Align the config to the **live** values (never the other way — this is an
   import, not a change) until the only thing left is the import.

4. **Normalize.** `normalize.py split` (per-service files) → `guard` (inserts
   `lifecycle { prevent_destroy = true }` on stateful types **before** the import lands) →
   `check` (fail-closed on Azure secret literals, `catalog/azure-redaction-rules.json`).

5. **No-op is done.** `verify.sh --phase import` must report
   `Plan: N to import, 0 to add, 0 to change, 0 to destroy`. If `add`/`change`/`destroy` are not
   all zero, go back to step 3 — never apply through a diff you cannot explain.

6. **PR → gated apply → steady.** One batch per PR (small blast radius). A human applies with the
   scoped Reader + Storage-Blob-Data-Contributor identity (state-only). Then
   `verify.sh --phase steady` must be a true no-op (`plan -detailed-exitcode` == 0).

## Import ids

Azure import ids are the ARM resource id verbatim
(`/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.<ns>/<type>/<name>`), which
Azure Resource Graph returns directly — no per-region id suffix is needed (contrast the AWS
kit's `@<region>` form). Child/proxy resources (subnets, diagnostic settings, role assignments)
carry composite ids and are handled via `azure-services.json` `manual[]` — see
[discovery-guide.md](discovery-guide.md).

## Casing

ARG and `aztfexport` can disagree on ARM-id segment casing. `reconcile.py` matches
case-insensitively so a cosmetic case delta never reads as a coverage gap; but if a **plan**
shows a spurious diff on an id-bearing attribute, normalize the casing deliberately to the value
`terraform plan` expects.
