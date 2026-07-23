# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: DynamoDB Streams, Kinesis, MSK/self-managed Kafka, and Amazon MQ sources are engineer follow-ups — this form covers the common SQS-queue case
# TODO: A destination for failed records (destination_config.on_failure), filter criteria, and a non-default starting position are engineer decisions

resource "aws_lambda_event_source_mapping" "ticket_webhook_sqs_trigger" {
  function_name = aws_lambda_function.alarm_handler.function_name
  event_source_arn = aws_sqs_queue.checkout_events.arn
  batch_size = 10
  enabled = true
  function_response_types = ["ReportBatchItemFailures"]
  tags = {
    Name = "ticket-webhook-sqs-trigger"
    Description = "Triggers the alarm handler from the checkout events queue"
    PIC = "Ops team"
  }
}
