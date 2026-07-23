# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Engineer-authored: a firewall is on the path of every flow it protects — a mis-change can black-hole or expose traffic, so it is never self-service.
# TODO: The ip_configuration subnet must be the dedicated AzureFirewallSubnet in the chosen virtual network — the engineer confirms the subnet before applying.
# TODO: SKU tier changes can force the firewall to be rebuilt and interrupt traffic — the engineer confirms the plan before it runs.
# TODO: The firewall policy binding is set by the engineer during review, to an existing or co-authored firewall policy.

resource "azurerm_firewall" "app_hub_fw" {
  # TODO: location — engineer decides
  # TODO: firewall_policy_id — engineer decides
  name = "app-hub-fw"
  resource_group_name = azurerm_resource_group.app.name
  sku_name = "AZFW_VNet"
  sku_tier = "Standard"
  tags = {
    Name = "app-hub-fw"
    Description = "Hub firewall"
    PIC = "Ops team"
  }
  ip_configuration {
    name = "configuration"
    subnet_id = azurerm_subnet.firewall.id
    public_ip_address_id = azurerm_public_ip.firewall.id
  }
}
