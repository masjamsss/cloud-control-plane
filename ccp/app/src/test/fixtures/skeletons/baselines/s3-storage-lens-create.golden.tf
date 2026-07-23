# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Storage Lens metrics selection (account_level: activity/cost-optimization/data-protection/performance metrics and the required bucket-level scope) is authored and reviewed by an engineer — the branching AWS Organizations-wide scoping is too heterogeneous to bound generically.
# TODO: Data export destinations (S3, CloudWatch metrics), include/exclude bucket and region filters, and an AWS Organizations-wide scope (aws_org) are engineer follow-ups after creation.

resource "aws_s3control_storage_lens_configuration" "org_default_dashboard" {
  # TODO: bucket_level — engineer decides
  config_id = "org-default-dashboard"
  tags = {
    Name = "ORG-DEFAULT-DASHBOARD"
    Description = "Organization-wide S3 usage dashboard"
    PIC = "Ops team"
  }
  storage_lens_configuration {
    enabled = true
    prefix_delimiter = "/"
  }
}
