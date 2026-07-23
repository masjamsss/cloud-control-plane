resource "aws_wafv2_web_acl" "edge" {
  name  = "edge-acl"
  scope = "REGIONAL"

  rule {
    name     = "r2"
    priority = 2
  }
}
