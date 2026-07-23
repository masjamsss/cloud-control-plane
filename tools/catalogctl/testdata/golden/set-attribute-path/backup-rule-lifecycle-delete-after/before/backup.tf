resource "aws_backup_plan" "erp_daily" {
  name = "erp-daily"

  rule {
    rule_name         = "primary"
    target_vault_name = "erp-vault"
    schedule          = "cron(0 5 ? * * *)"

    lifecycle {
      delete_after = 30
    }
  }

  rule {
    rule_name         = "secondary"
    target_vault_name = "erp-vault-dr"
    schedule          = "cron(0 7 ? * * *)"

    lifecycle {
      delete_after = 90
    }
  }
}
