# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Engineer-authored: a virtual-network link decides which networks can resolve a private zone — a wrong link can break or wrongly expose name resolution, so it is never self-service.
# TODO: Auto-registration writes DNS records for every virtual machine on the linked network — confirm that is intended before enabling it.
# TODO: The link's resource group must match the private DNS zone's own resource group — the engineer confirms the pairing.

resource "azurerm_private_dns_zone_virtual_network_link" "app_hub_dns_link" {
  name = "app-hub-dns-link"
  resource_group_name = azurerm_resource_group.app.name
  private_dns_zone_name = azurerm_private_dns_zone.privatelink_blob.name
  virtual_network_id = azurerm_virtual_network.hub.id
  registration_enabled = false
  tags = {
    Name = "app-hub-dns-link"
    Description = "Private DNS link for the hub network"
    PIC = "Ops team"
  }
}
