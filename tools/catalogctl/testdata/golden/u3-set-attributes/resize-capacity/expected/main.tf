resource "aws_dynamodb_table" "orders" {
  name           = "orders"
  billing_mode   = "PROVISIONED"
  hash_key       = "id"
  read_capacity  = 20
  write_capacity = 10
}
