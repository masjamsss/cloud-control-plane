# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Public network access and shared-key authentication are off by default — confirm a private endpoint or VNet service endpoint reaches this account and that the workload can authenticate via Azure AD/RBAC, or the engineer relaxes the relevant setting consciously during review.
# TODO: Confirm the chosen region matches where the rest of the workload runs.
# TODO: Customer-managed encryption keys, network firewall rules, and blob versioning/soft-delete are not captured here — request them as a separate engineer-authored change if needed.

resource "azurerm_storage_account" "appdata001" {
  location = azurerm_resource_group.app.location
  name = "appdata001"
  resource_group_name = azurerm_resource_group.app.name
  account_tier = "Standard"
  account_replication_type = "GRS"
  min_tls_version = "TLS1_2"
  public_network_access_enabled = false
  allow_nested_items_to_be_public = false
  shared_access_key_enabled = false
  https_traffic_only_enabled = true
  tags = {
    Name = "appdata001"
    Description = "Application blob storage"
    PIC = "Ops team"
  }
}
