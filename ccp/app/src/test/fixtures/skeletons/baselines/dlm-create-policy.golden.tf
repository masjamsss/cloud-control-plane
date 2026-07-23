# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The attribute block(s) declaring the target-tag key/value pair are an engineer decision, matched to the estate's existing tagging convention
# TODO: Image-management and event-based policy types are an engineer decision — this form covers the common EBS-snapshot-management case
# TODO: Cross-region copy, exclusions, and a second schedule are engineer follow-ups after creation

resource "aws_dlm_lifecycle_policy" "app_tier_daily" {
  # TODO: target_tags — engineer decides
  description = "Daily EBS snapshots for the app tier volumes"
  execution_role_arn = aws_iam_role.application_migration.arn
  state = "ENABLED"
  tags = {
    Name = "app-tier-daily"
    Description = "Daily snapshot policy for the app tier"
    PIC = "Ops team"
  }
  policy_details {
    resource_types = ["VOLUME"]
    schedule {
      name = "Daily Snapshots"
      copy_tags = true
      create_rule {
        interval = 24
        interval_unit = "HOURS"
        times = ["03:00"]
      }
      retain_rule {
        count = 7
      }
    }
  }
}
