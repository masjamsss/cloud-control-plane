# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Rule targets (Lambda, SNS, SQS, Step Functions, etc.) are wired as an engineer follow-up once this rule exists — see eventbridge-add-schedule-rule for the combined schedule+target pattern.
# TODO: An event_pattern JSON is engineer-authored; this form's bounded path is a schedule-driven rule.

resource "aws_cloudwatch_event_rule" "nightly_cleanup" {
  name = "nightly-cleanup"
  schedule_expression = "rate(1 day)"
  state = "ENABLED"
  tags = {
    Name = "NIGHTLY-CLEANUP"
    Description = "Nightly cleanup automation trigger"
    PIC = "Ops team"
  }
}
