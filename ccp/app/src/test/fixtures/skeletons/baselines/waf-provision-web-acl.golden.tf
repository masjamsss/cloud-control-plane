# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The default action (allow or block) sets what happens to every request no rule matches; confirm it, and expand it into its default_action block form during review.
# TODO: This provisions the Web ACL shell with its metrics on. The protection rules are added ONE at a time as reviewed follow-up, never bulk self-service.

resource "aws_wafv2_web_acl" "app_waf" {
  name = "app-waf"
  scope = "REGIONAL"
  default_action = "allow"
  tags = {
    Description = "App WAF"
    PIC = "Ops team"
  }
  visibility_config {
    metric_name = "app-waf"
    cloudwatch_metrics_enabled = true
    sampled_requests_enabled = true
  }
}
