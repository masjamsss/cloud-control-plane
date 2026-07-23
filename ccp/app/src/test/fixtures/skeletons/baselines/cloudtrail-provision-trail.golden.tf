# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Disabling logging, narrowing region coverage, or redirecting the S3 destination blinds the audit trail. The delivery bucket must be an access-controlled destination the engineer confirms, with a bucket policy that lets CloudTrail write and denies public access.
# TODO: Log-file validation and multi-region coverage are on by default; confirm nothing downstream depends on the old trail configuration before this one replaces it.

resource "aws_cloudtrail" "org_audit_trail" {
  name = "org-audit-trail"
  s3_bucket_name = aws_s3_bucket.alb_logdata.id
  cloud_watch_logs_group_arn = aws_cloudwatch_log_group.alarm_handler.arn
  kms_key_id = aws_kms_key.shared_cmk.arn
  is_multi_region_trail = true
  include_global_service_events = true
  enable_log_file_validation = true
  tags = {
    Description = "Org audit trail"
    PIC = "Ops team"
  }
}
