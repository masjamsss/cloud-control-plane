# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Auto-associate and auto-propagate default to enabled — a simple hub-and-spoke where every attachment shares one route table. Turn both off first if this gateway needs isolated route tables per attachment (network segmentation)
# TODO: Multicast support, auto-accept for shared attachments, and additional transit gateway CIDR blocks are engineer decisions
# TODO: VPC attachments are created as a separate follow-up step (the existing create-a-VPC-attachment action) — this transit gateway starts with nothing attached

resource "aws_ec2_transit_gateway" "core_tgw" {
  description = "Core transit gateway for hub-and-spoke connectivity"
  amazon_side_asn = 64512
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"
  dns_support = "enable"
  tags = {
    Name = "CORE-TGW"
    Description = "Core transit gateway"
    PIC = "Ops team"
  }
}
