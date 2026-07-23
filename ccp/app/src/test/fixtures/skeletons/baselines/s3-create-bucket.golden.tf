# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Public exposure is never self-service — any public need is a separate engineer review
# TODO: Confirm bucket region and replication needs

resource "aws_s3_bucket" "finance_interface" {
  bucket = "finance-interface"
  tags = {
    Name = "finance-interface"
    Description = "Finance interface drop bucket"
    PIC = "Ops team"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "finance_interface" {
  bucket = aws_s3_bucket.finance_interface.id
  block_public_acls = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "finance_interface" {
  bucket = aws_s3_bucket.finance_interface.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
      kms_master_key_id = aws_kms_key.shared_cmk.arn
    }
  }
}

resource "aws_s3_bucket_versioning" "finance_interface" {
  bucket = aws_s3_bucket.finance_interface.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "finance_interface" {
  bucket = aws_s3_bucket.finance_interface.id
  rule {
    id = "expire-objects"
    status = "Enabled"
    expiration {
      days = 365
    }
  }
}
