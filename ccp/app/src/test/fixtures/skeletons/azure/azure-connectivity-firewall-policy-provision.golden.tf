# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Engineer-authored: a firewall policy decides what traffic is allowed and inspected across the estate — a wrong change can open or sever reachability, so it is never self-service.
# TODO: Rule collection groups, DNS proxy, and TLS inspection are added as separate engineer-authored follow-ups once the policy exists.
# TODO: Confirm the region during review — a firewall policy is consumed by firewalls in its own region.

resource "azurerm_firewall_policy" "app_hub_fw_policy" {
  # TODO: location — engineer decides
  name = "app-hub-fw-policy"
  resource_group_name = azurerm_resource_group.app.name
  sku = "Standard"
  threat_intelligence_mode = "Alert"
  tags = {
    Name = "app-hub-fw-policy"
    Description = "Hub firewall policy"
    PIC = "Ops team"
  }
}
