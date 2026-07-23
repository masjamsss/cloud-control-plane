# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: This form targets a Lambda function (the common case); SNS, SQS, Step Functions, ECS and other target types are an engineer follow-up (swap target_arn and add the matching *_parameters sub-block).
# TODO: A custom schedule group (default group is used here), dead-letter queue routing, and retry policy tuning are engineer follow-ups after creation.
# TODO: aws_scheduler_schedule carries no tags argument in the provider schema, so no Name/Description/PIC tags are captured here.

resource "aws_scheduler_schedule" "nightly_report" {
  name = "nightly-report"
  schedule_expression = "rate(1 day)"
  schedule_expression_timezone = "UTC"
  state = "ENABLED"
  action_after_completion = "NONE"
  flexible_time_window {
    mode = "FLEXIBLE"
    maximum_window_in_minutes = 15
  }
  target {
    arn = aws_lambda_function.alarm_handler.arn
    role_arn = aws_iam_role.application_migration.arn
  }
}
