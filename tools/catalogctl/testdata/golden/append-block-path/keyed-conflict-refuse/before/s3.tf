resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "DeleteRule"
    status = "Enabled"

    filter {
      prefix = "tmp/"
    }

    expiration {
      days = 30
    }
  }

  rule {
    id     = "ArchiveOld"
    status = "Enabled"

    filter {
      prefix = "logs/"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }
  }
}
