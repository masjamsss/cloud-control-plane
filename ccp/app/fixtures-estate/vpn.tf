# Site-to-site VPN back to the (synthetic) on-prem data center.

resource "aws_vpn_gateway" "main" {
  vpc_id          = aws_vpc.main.id
  amazon_side_asn = 64512

  tags = {
    Name = "app-vgw"
    PIC  = "user02@example.com"
  }
}

resource "aws_customer_gateway" "onprem" {
  bgp_asn    = 65000
  ip_address = "203.0.113.10"
  type       = "ipsec.1"

  tags = {
    Name = "onprem-cgw"
    PIC  = "user02@example.com"
  }
}

resource "aws_vpn_connection" "site_to_site" {
  vpn_gateway_id      = aws_vpn_gateway.main.id
  customer_gateway_id = aws_customer_gateway.onprem.id
  type                = "ipsec.1"
  static_routes_only  = true

  tags = {
    Name = "onprem-vpn"
    PIC  = "user02@example.com"
  }
}

# Deliberately no aws_vpn_connection_route here: the app's "add a static
# route" operation is this type's adoption path (see EMPTY_TYPES in
# inventoryEnums.test.ts) — the sample stays at zero so that demo flow has
# something to demonstrate.
