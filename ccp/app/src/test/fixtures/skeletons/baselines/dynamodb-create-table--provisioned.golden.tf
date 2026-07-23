# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The attribute type-declaration block(s) for the partition key, sort key, and any indexes are an engineer decision
# TODO: Global and local secondary indexes are an engineer decision — this form provisions the base table only
# TODO: Streams, TTL, and S3 import/restore are engineer follow-ups after creation

resource "aws_dynamodb_table" "orders_lookup" {
  # TODO: attribute — engineer decides
  name = "orders-lookup"
  billing_mode = "PROVISIONED"
  read_capacity = 10
  write_capacity = 10
  hash_key = "order_id"
  deletion_protection_enabled = true
  tags = {
    Name = "orders-lookup"
    Description = "Order lookup table for the checkout service"
    PIC = "Ops team"
  }
  point_in_time_recovery {
    enabled = true
  }
}
