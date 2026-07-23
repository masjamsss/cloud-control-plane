# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: An organization-scoped analyzer reads across every account in the org; confirm the scope (account vs organization) matches the reviewing team's authority.

resource "aws_accessanalyzer_analyzer" "account_analyzer" {
  analyzer_name = "account-analyzer"
  type = "ACCOUNT"
  tags = {
    Description = "Account access analyzer"
    PIC = "Ops team"
  }
}
