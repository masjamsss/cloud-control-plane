# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Disabling the detector or suspending its data sources blinds threat detection for the whole account; enablement and scope changes are engineer-reviewed, never self-service.
# TODO: Data sources (S3 protection, malware scanning, Kubernetes audit logs) are enabled as a reviewed follow-up; this provisions the detector enabled with none added yet.

resource "aws_guardduty_detector" "account_detector" {
  enable = true
  finding_publishing_frequency = "SIX_HOURS"
  tags = {
    Description = "Account GuardDuty detector"
    PIC = "Ops team"
  }
}
