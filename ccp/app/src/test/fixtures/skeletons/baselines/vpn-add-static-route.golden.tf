# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The estate's VPN file currently declares route resources out of scope — adopting the first one is part of this change

resource "aws_vpn_connection_route" "new_resource" {
  vpn_connection_id = aws_vpn_connection.prod_onprem_dc1.id
  destination_cidr_block = "10.2.0.0/16"
}
