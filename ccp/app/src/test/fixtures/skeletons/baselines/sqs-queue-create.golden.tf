# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Dead-letter queue wiring (redrive_policy) and a custom queue access policy are engineer follow-ups after creation.

resource "aws_sqs_queue" "order_events" {
  name = "order-events"
  fifo_queue = false
  visibility_timeout_seconds = 60
  message_retention_seconds = 86400
  max_message_size = 262144
  delay_seconds = 0
  receive_wait_time_seconds = 0
  sqs_managed_sse_enabled = true
  tags = {
    Name = "ORDER-EVENTS"
    Description = "Order events queue for the checkout service"
    PIC = "Ops team"
  }
}
