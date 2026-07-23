resource "aws_backup_plan" "dup" {
  name = "dup"

  rule {
    rule_name         = "dup"
    target_vault_name = "v1"
    schedule          = "cron(0 5 ? * * *)"

    lifecycle {
      delete_after = 30
    }
  }

  rule {
    rule_name         = "dup"
    target_vault_name = "v2"
    schedule          = "cron(0 7 ? * * *)"

    lifecycle {
      delete_after = 90
    }
  }
}
