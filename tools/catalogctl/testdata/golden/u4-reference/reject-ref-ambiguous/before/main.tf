resource "aws_kms_key" "trail" {
  description             = "cloudtrail encryption"
  deletion_window_in_days = 7
}

resource "aws_cloudtrail" "main" {
  name           = "org-trail"
  s3_bucket_name = "org-trail-logs"
}
