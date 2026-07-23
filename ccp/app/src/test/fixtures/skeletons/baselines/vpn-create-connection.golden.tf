# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A site-to-site VPN connection extends the VPC's private network to on-premises — confirm the on-prem routing/firewall team is coordinated before cutover, and that this does not unintentionally expose internal ranges
# TODO: Tunnel pre-shared keys, inside CIDRs and BGP details are left to AWS defaults if unset — set them afterward with the existing rotate/change actions if the on-prem side requires specific values
# TODO: Static routes into this connection are a separate follow-up step (the existing add-a-static-route action)

resource "aws_vpn_connection" "app_tier_secondary_vpn" {
  vpn_gateway_id = aws_vpn_gateway.prod_onprem.id
  customer_gateway_id = aws_customer_gateway.onprem_dc1.id
  type = "ipsec.1"
  static_routes_only = true
  tags = {
    Name = "APP-TIER-SECONDARY-VPN"
    Description = "Secondary site-to-site VPN to the on-prem data center"
    PIC = "Ops team"
  }
}
