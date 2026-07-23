# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Enabling Security Hub is account-wide and turns on the default standards; disabling it or its controls removes compliance visibility, an engineer-reviewed change.
# TODO: Individual control tuning and standards subscriptions are reviewed follow-up; this provisions the account enabled with the default standards on.

resource "aws_securityhub_account" "account" {
  enable_default_standards = true
  auto_enable_controls = true
  control_finding_generator = "SECURITY_CONTROL"
}
