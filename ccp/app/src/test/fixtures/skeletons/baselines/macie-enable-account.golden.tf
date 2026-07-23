# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Enabling Macie starts sensitive-data discovery account-wide; pausing or disabling it stops that visibility, so status changes are engineer-reviewed.
# TODO: Classification jobs and custom data identifiers are a reviewed follow-up; this provisions Macie enabled with none defined yet.

resource "aws_macie2_account" "account" {
  finding_publishing_frequency = "ONE_HOUR"
  status = "ENABLED"
}
