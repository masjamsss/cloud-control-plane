# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Vault lock and compliance retention are a separate engineer decision

resource "aws_backup_vault" "daily" {
  name = "daily"
  tags = {
    Name = "daily"
    Description = "Daily recovery points"
    PIC = "Ops team"
  }
}
