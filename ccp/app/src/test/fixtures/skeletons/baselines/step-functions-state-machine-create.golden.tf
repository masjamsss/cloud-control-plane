# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The Amazon States Language definition is authored and reviewed by an engineer, never captured or validated from this form.
# TODO: kms_data_key_reuse_period_seconds and any Express workflow log destinations beyond a single CloudWatch log group are engineer follow-ups.

resource "aws_sfn_state_machine" "order_fulfillment" {
  # TODO: definition — engineer decides
  name = "order-fulfillment"
  role_arn = aws_iam_role.application_migration.arn
  type = "STANDARD"
  publish = false
  tags = {
    Name = "ORDER-FULFILLMENT"
    Description = "Order fulfillment workflow"
    PIC = "Ops team"
  }
  tracing_configuration {
    enabled = false
  }
  logging_configuration {
    level = "ERROR"
    include_execution_data = true
    log_destination = aws_cloudwatch_log_group.alarm_handler.arn
  }
  encryption_configuration {
    kms_key_id = aws_kms_key.shared_cmk.arn
    type = "CUSTOMER_MANAGED_KMS_KEY"
  }
}
