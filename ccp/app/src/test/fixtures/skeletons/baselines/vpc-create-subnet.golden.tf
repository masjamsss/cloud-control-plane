# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Auto-assign public IPv4 defaults to off; turning it on means this subnet is meant to be internet-facing — confirm it will have a route to an internet gateway before flipping it, and that this is the intended reachability change
# TODO: Route table association is a separate follow-up step (the routing service's associate-a-subnet action) — an unassociated subnet uses the VPC's main route table
# TODO: IPv6 CIDR association, customer-owned IP pools, and outpost placement are engineer decisions

resource "aws_subnet" "app_tier_private_c" {
  vpc_id = aws_vpc.prod_sample.id
  cidr_block = "10.1.12.0/24"
  availability_zone = "ap-southeast-5c"
  map_public_ip_on_launch = false
  tags = {
    Name = "APP-TIER-PRIVATE-C"
    Description = "Private subnet for the app tier, AZ c"
    PIC = "Ops team"
  }
}
