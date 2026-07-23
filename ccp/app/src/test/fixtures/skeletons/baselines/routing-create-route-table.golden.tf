# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: An empty route table has no effect until subnets are associated with it and routes are added — reachability is decided entirely by what is added afterward (the existing add-a-route and associate-a-subnet actions), not by creating the table itself
# TODO: Route propagation from a VPN gateway (propagating_vgws) is an engineer decision

resource "aws_route_table" "app_tier_private_rt" {
  vpc_id = aws_vpc.prod_sample.id
  tags = {
    Name = "APP-TIER-PRIVATE-RT"
    Description = "Route table for the app-tier private subnets"
    PIC = "Ops team"
  }
}
