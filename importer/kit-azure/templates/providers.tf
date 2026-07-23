# provider "azurerm" requires a features {} block (no AWS analog) — it is MANDATORY even
# when empty, so validate/plan work offline the moment the root is scaffolded.
#
# use_oidc = true selects Workload Identity Federation (keyless GitHub -> Entra), the Azure
# analog of the AWS estate's GitHub OIDC roles — no client secret is ever stored. subscription_id
# and tenant_id are passed as variables (never hardcoded) so the same root can target the
# scoped Reader/state-writer identities the runbook provisions.
#
# NOTE: there is deliberately NO default tags block here. As with environments/prod's deferred
# default_tags, tag governance is its own reviewed PR AFTER the import lands zero-write — adding
# tags at import time would show as a diff and break the import-only plan.
#
# azapi mirrors the same subscription/tenant/OIDC wiring; keep it only if azapi-hinted types exist.

provider "azurerm" {
  features {}

  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
  use_oidc        = true
}

provider "azapi" {
  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
  use_oidc        = true
}
