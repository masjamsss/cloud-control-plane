# Two buckets: application data and access logs.

resource "aws_s3_bucket" "app_data" {
  bucket = "example-estate-app-data"

  tags = {
    Name        = "app-data"
    PIC         = "user01@example.com"
    Description = "Application data bucket"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "app_data" {
  bucket = aws_s3_bucket.app_data.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app_data" {
  bucket = aws_s3_bucket.app_data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.app_key.arn
    }
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "example-estate-access-logs"

  tags = {
    Name        = "logs"
    PIC         = "user02@example.com"
    Description = "Access log bucket"
  }

  lifecycle {
    prevent_destroy = true
  }
}
