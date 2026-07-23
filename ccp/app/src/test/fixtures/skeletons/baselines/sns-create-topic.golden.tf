# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Delivery policy or dead-letter queue if this topic feeds alarms

resource "aws_sns_topic" "oncall_alerts" {
  name = "oncall-alerts"
  display_name = "On-call"
  tags = {
    Name = "oncall-alerts"
    Description = "On-call notifications"
    PIC = "Ops team"
  }
}
