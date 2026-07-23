# DRAFT — generated from request REQ-RPT; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Capacity mode, autoscaling, and streams are an engineer decision

resource "aws_dynamodb_table" "orders_lookup" {
  name = "orders-lookup"
  billing_mode = "PAY_PER_REQUEST"
  hash_key = "order_id"
  tags = {
    Name = "orders-lookup"
    Description = "Order lookup table for the checkout service"
  }
  attribute {
    name = "order_id"
    type = "S"
  }
  attribute {
    name = "created_at"
    type = "N"
  }
  global_secondary_index {
    # TODO: projection_type — engineer decides
    name = "by_created"
    hash_key = "created_at"
  }
}
