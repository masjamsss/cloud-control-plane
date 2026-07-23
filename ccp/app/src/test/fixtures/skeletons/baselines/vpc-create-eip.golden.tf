# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Associating this address with an instance, network interface, or NAT gateway is a separate follow-up step (the existing associate actions)
# TODO: A specific public IPv4 pool, customer-owned IP pool, or fixed network border group are engineer decisions

resource "aws_eip" "app_tier_nat_eip" {
  domain = "vpc"
  tags = {
    Name = "APP-TIER-NAT-EIP"
    Description = "Reserved for the app-tier NAT gateway"
    PIC = "Ops team"
  }
}
