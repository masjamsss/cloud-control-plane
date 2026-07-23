resource "aws_backup_plan" "no_lifecycle" {
  name = "no-lifecycle"

  rule {
    rule_name         = "primary"
    target_vault_name = "v1"
    schedule          = "cron(0 5 ? * * *)"
  }
}
