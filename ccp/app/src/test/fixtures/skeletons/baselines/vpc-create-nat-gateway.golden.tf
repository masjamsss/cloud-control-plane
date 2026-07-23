# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Secondary allocation IDs and secondary private IP address ranges are engineer decisions
# TODO: Pointing a private subnet's route table at this gateway is a separate follow-up step (the routing service's add-a-route action)

resource "aws_nat_gateway" "app_tier_nat" {
  subnet_id = aws_subnet.backup.id
  connectivity_type = "public"
  allocation_id = aws_eip.nat.id
  tags = {
    Name = "APP-TIER-NAT"
    Description = "Outbound internet for the private app-tier subnets"
    PIC = "Ops team"
  }
}
