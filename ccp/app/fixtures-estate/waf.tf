# A regional WAF ACL fronting the ALB.

resource "aws_wafv2_web_acl" "app" {
  name        = "app-waf"
  description = "WAF for the application load balancer"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "app-waf"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "app-waf"
    PIC  = "user01@example.com"
  }
}
