# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Confirm replication and object-lock interactions before enabling

resource "aws_s3_bucket_versioning" "new_resource" {
  bucket = aws_s3_bucket.alarm_ticket_table.id
  versioning_configuration {
    status = "Enabled"
  }
}
