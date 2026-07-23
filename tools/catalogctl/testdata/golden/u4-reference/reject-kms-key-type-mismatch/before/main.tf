resource "aws_iam_role" "application_migration" {
  name = "application-migration"
}

resource "aws_cloudtrail" "main" {
  name           = "org-trail"
  s3_bucket_name = "org-trail-logs"
}
