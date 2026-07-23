# On-call notification topic.

resource "aws_sns_topic" "alerts" {
  name         = "oncall-alerts"
  display_name = "On-call"
  kms_master_key_id = aws_kms_key.app_key.key_id

  tags = {
    Name        = "oncall-alerts"
    PIC         = "user02@example.com"
    Description = "On-call notifications"
  }
}
