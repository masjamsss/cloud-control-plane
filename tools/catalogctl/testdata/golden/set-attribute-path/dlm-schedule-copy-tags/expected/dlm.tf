resource "aws_dlm_lifecycle_policy" "ebs_snapshots" {
  description        = "ERP EBS snapshots"
  execution_role_arn = "arn:aws:iam::123456789012:role/AWSDataLifecycleManagerDefaultRole"
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    schedule {
      schedule_name = "Daily"
      copy_tags     = true

      tags_to_add = {
        Environment = "prod"
      }
    }

    schedule {
      schedule_name = "Weekly"
      copy_tags     = false

      tags_to_add = {
        Environment = "prod"
      }
    }
  }
}
