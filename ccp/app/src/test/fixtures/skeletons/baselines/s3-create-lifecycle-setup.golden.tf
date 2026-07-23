# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A bucket holds at most one lifecycle configuration — confirm this bucket has none before merging

resource "aws_s3_bucket_lifecycle_configuration" "expire_old_logs" {
  bucket = aws_s3_bucket.alarm_ticket_table.id
  rule {
    id = "expire-old-logs"
    status = "Enabled"
    filter {
      prefix = "logs/"
    }
    transition {
      days = 90
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = 365
    }
  }
}
