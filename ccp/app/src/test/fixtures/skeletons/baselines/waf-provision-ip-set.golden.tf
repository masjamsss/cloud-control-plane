# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Confirm each CIDR is correct and intended: an IP set feeds allow or deny rules, so a wrong or overly-broad range silently widens or blocks access.

resource "aws_wafv2_ip_set" "office_ips" {
  name = "office-ips"
  scope = "REGIONAL"
  ip_address_version = "IPV4"
  addresses = ["203.0.113.0/24"]
  tags = {
    Description = "Office IP allowlist"
    PIC = "Ops team"
  }
}
