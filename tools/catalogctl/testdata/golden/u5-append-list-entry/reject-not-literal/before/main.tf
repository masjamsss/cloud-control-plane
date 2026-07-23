resource "aws_wafv2_ip_set" "blocklist" {
  name               = "blocklist"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = local.blocked_cidrs
}
