# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Public network access is blocked by default — confirm a private endpoint already reaches this vault, or the engineer relaxes it consciously during review.
# TODO: Purge protection is on from creation and can never be turned off again — confirm this vault should be permanently protected before applying.
# TODO: Access policies and RBAC role assignments granting who can read or manage secrets are not captured here — grant them as a separate, engineer-authored follow-up once the vault exists.
# TODO: Confirm the chosen region matches where the rest of the workload runs.

resource "azurerm_key_vault" "app_secrets" {
  # TODO: tenant_id — engineer decides
  location = azurerm_resource_group.app.location
  name = "app-secrets"
  resource_group_name = azurerm_resource_group.app.name
  sku_name = "standard"
  rbac_authorization_enabled = true
  public_network_access_enabled = false
  purge_protection_enabled = true
  soft_delete_retention_days = 90
  tags = {
    Name = "app-secrets"
    Description = "Application secrets vault"
    PIC = "Ops team"
  }
}
