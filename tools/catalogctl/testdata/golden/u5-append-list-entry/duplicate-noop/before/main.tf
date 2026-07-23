resource "aws_wafv2_ip_set" "blocklist" {
  name               = "blocklist"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = ["10.0.0.0/24", "10.1.0.0/24"]
}
