resource "aws_dlm_lifecycle_policy" "erp_ebs" {
  description        = "ERP EBS snapshot policy"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      Backup = "erp"
    }

    schedule {
      name      = "daily"
      copy_tags = true

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }

      retain_rule {
        count = 7
      }
    }

    schedule {
      name      = "weekly"
      copy_tags = true

      create_rule {
        interval      = 168
        interval_unit = "HOURS"
        times         = ["23:00"]
      }

      retain_rule {
        count = 4
      }
    }
  }
}
