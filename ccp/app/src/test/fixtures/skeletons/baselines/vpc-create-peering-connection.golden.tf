# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Peering two VPCs whose CIDR blocks are not disjoint fails at apply — confirm the ranges do not overlap before submitting
# TODO: Route table entries on BOTH sides pointing at the peering connection are a required follow-up (the routing service's add-a-route action) — an unrouted peering connection reaches nothing
# TODO: DNS resolution across the peering (allow_remote_vpc_dns_resolution on the accepter/requester blocks) is an engineer decision

resource "aws_vpc_peering_connection" "app_tier_to_sg" {
  vpc_id = aws_vpc.prod_sample.id
  peer_vpc_id = "vpc-0abc12345def67890"
  peer_region = "ap-southeast-1"
  auto_accept = false
  tags = {
    Name = "APP-TIER-TO-SG"
    Description = "Peering to the Singapore VPC"
    PIC = "Ops team"
  }
}
