# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Over-broad access is a standing escalation path: a role wider than the read-only allowlist, or a scope wider than the chosen resource group, is authored by an engineer and never self-service.
# TODO: Confirm the principal ID names the intended identity — a role granted to the wrong object ID is silent over-permission until someone audits it.
# TODO: A subscription- or management-group-wide scope multiplies the blast radius across every resource beneath it; widen the scope only with a reviewed reason.

resource "azurerm_role_assignment" "app_storage_reader" {
  role_definition_name = "Storage Blob Data Reader"
  scope = azurerm_resource_group.app.id
  principal_id = "11111111-1111-1111-1111-111111111111"
  principal_type = "Group"
  description = "Read-only blob access for the reporting group"
}
