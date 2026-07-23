# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The firewall policy (stateless default actions plus stateful rule groups) is an engineer decision — pick or author it before this firewall can meaningfully filter traffic; an empty/permissive policy passes everything
# TODO: This form seeds exactly one subnet mapping (one Availability Zone); additional zones are an engineer follow-up
# TODO: Routing traffic THROUGH this firewall (route table changes pointing at its VPC endpoints, in both directions) is a separate, required follow-up — creating the firewall alone redirects no traffic

resource "aws_networkfirewall_firewall" "app_tier_firewall" {
  # TODO: firewall_policy_arn — engineer decides
  name = "app-tier-firewall"
  vpc_id = aws_vpc.prod_sample.id
  delete_protection = true
  tags = {
    Name = "APP-TIER-FIREWALL"
    Description = "Inspects egress traffic for the app tier"
    PIC = "Ops team"
  }
  subnet_mapping {
    subnet_id = aws_subnet.backup.id
  }
}
