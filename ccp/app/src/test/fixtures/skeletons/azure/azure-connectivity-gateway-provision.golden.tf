# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Engineer-authored: a gateway terminates the tunnels that carry cross-site connectivity — a wrong change can drop every connection through it, so it is never self-service.
# TODO: The ip_configuration subnet must be the dedicated GatewaySubnet in the chosen virtual network — the engineer confirms it before applying.
# TODO: Confirm the chosen SKU matches the gateway type — VpnGw* for a VPN gateway, ErGw* for an ExpressRoute gateway.
# TODO: Gateway creation can take up to 45 minutes, and SKU or type changes rebuild it — the engineer schedules the change.

resource "azurerm_virtual_network_gateway" "app_vpn_gw" {
  # TODO: location — engineer decides
  name = "app-vpn-gw"
  resource_group_name = azurerm_resource_group.app.name
  type = "Vpn"
  vpn_type = "RouteBased"
  sku = "VpnGw1"
  tags = {
    Name = "app-vpn-gw"
    Description = "Site-to-site VPN gateway"
    PIC = "Ops team"
  }
  ip_configuration {
    name = "vnetGatewayConfig"
    subnet_id = azurerm_subnet.gateway.id
    public_ip_address_id = azurerm_public_ip.gateway.id
    private_ip_address_allocation = "Dynamic"
  }
}
