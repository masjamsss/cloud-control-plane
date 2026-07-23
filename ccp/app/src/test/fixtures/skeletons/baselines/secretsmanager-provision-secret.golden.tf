# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The secret VALUE is never captured here: this form provisions the secret container only. An engineer sets the value out of band after the secret exists, so no secret material ever passes through the portal.
# TODO: Confirm the recovery window: a shorter window speeds permanent deletion, a longer window protects against accidental loss.

resource "aws_secretsmanager_secret" "app_db_credentials" {
  name = "app/db-credentials"
  description = "Database credentials for the app"
  recovery_window_in_days = 30
  kms_key_id = aws_kms_key.shared_cmk.arn
  tags = {
    Description = "App DB credentials"
    PIC = "Ops team"
  }
}
