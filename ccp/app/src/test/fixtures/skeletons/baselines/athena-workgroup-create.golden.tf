# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Query-results encryption configuration (SSE-KMS) is an engineer decision
# TODO: Engine version pinning and Spark/notebook workgroup configuration are engineer decisions
# TODO: Identity Center and S3 access-grants integration are engineer follow-ups after creation

resource "aws_athena_workgroup" "analytics_team" {
  name = "analytics-team"
  description = "Ad-hoc queries for the analytics team"
  state = "ENABLED"
  force_destroy = false
  tags = {
    Name = "analytics-team"
    Description = "Ad-hoc query workgroup for the analytics team"
    PIC = "Ops team"
  }
  configuration {
    enforce_workgroup_configuration = true
    publish_cloudwatch_metrics_enabled = true
    requester_pays_enabled = false
    result_configuration {
      output_location = "s3://query-results-store/athena/"
    }
  }
}
