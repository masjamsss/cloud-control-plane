# DRAFT — generated from a portal request; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

resource "aws_sns_topic" "on_call_alerts" {
  name = "On-Call Alerts"
  alarm_actions = [aws_sns_topic.oncall.arn]
  display_name = "quote \" backslash \\ and $${interpolation}"
  delivery_token = "«redacted:f59317b2»"
}
