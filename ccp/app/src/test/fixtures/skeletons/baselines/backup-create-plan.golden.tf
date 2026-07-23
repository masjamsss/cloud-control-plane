# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Add a second monthly or long-retention rule after creation with the add-a-backup-rule action
# TODO: Cross-region copy is an engineer decision

resource "aws_backup_plan" "standard" {
  name = "standard"
  tags = {
    Name = "standard"
    Description = "Standard daily backup plan"
    PIC = "Ops team"
  }
  rule {
    rule_name = "daily"
    target_vault_name = aws_backup_vault.erp_daily.name
    schedule = "cron(0 17 ? * * *)"
    start_window = 60
    completion_window = 180
    enable_continuous_backup = false
    lifecycle {
      delete_after = 35
    }
  }
}
