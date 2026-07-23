resource "aws_wafv2_web_acl" "cloudfront_0example1" {
  provider = aws.us_east_1

  name  = "CreatedByCloudFront-0example1"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "AWS-AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      count {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWS-AWSManagedRulesCommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "MalformedDualAction"
    priority = 6

    action {
      count {}
      block {}
    }

    statement {
      ip_set_reference_statement {
        arn = "arn:aws:wafv2:us-east-1:123456789012:global/ipset/blocklist/1a2b3c4d-5e6f-7890-abcd-ef1234567890"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "MalformedDualAction"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "CreatedByCloudFront-0example1"
    sampled_requests_enabled   = true
  }
}
