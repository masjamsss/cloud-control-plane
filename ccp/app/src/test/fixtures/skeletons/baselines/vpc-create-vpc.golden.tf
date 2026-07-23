# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Instance tenancy defaults to shared; dedicated tenancy is an engineer decision
# TODO: IPv6 CIDR association, IPAM pool sourcing, and network-address-usage metrics are engineer decisions
# TODO: Subnets, an internet gateway, NAT gateways and route tables are created as separate follow-up steps — an empty VPC has no reachability of its own either way

resource "aws_vpc" "app_tier_vpc" {
  cidr_block = "10.3.0.0/16"
  enable_dns_support = true
  enable_dns_hostnames = true
  tags = {
    Name = "APP-TIER-VPC"
    Description = "Isolated network for the app tier"
    PIC = "Ops team"
  }
}
