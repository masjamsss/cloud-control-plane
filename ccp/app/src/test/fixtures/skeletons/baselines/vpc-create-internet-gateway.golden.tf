# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Attaching an internet gateway to a VPC is what makes a public route to 0.0.0.0/0 possible for any subnet whose route table points at it — confirm that reachability change is intended before it is wired into a route table
# TODO: Pointing a route table at this gateway is a separate follow-up step (the routing service's add-a-route action) — attaching alone does not make any subnet reachable

resource "aws_internet_gateway" "app_tier_igw" {
  vpc_id = aws_vpc.prod_sample.id
  tags = {
    Name = "APP-TIER-IGW"
    Description = "Internet gateway for the app-tier VPC"
    PIC = "Ops team"
  }
}
