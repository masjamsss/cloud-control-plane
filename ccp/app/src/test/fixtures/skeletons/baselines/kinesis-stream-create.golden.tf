# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Enhanced fan-out consumers are an engineer follow-up after creation
# TODO: Shard-level metrics beyond the defaults are an engineer decision
# TODO: Warm throughput (provisioned capacity floor) is an engineer decision

resource "aws_kinesis_stream" "clickstream_events" {
  name = "clickstream-events"
  retention_period = 24
  encryption_type = "KMS"
  tags = {
    Name = "clickstream-events"
    Description = "Clickstream event stream for the web tier"
    PIC = "Ops team"
  }
  stream_mode_details {
    stream_mode = "ON_DEMAND"
  }
}
