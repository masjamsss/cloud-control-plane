resource "aws_cloudtrail" "main" {
  name           = "org-trail"
  s3_bucket_name = "org-trail-logs"
}
