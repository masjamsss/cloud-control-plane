# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A resource share crosses the account trust boundary: sharing with principals outside the organization is disabled by default here, and enabling external principals or adding shared resources and principals is an engineer-reviewed follow-up.
# TODO: Confirm which resources and principals the share grants before it is populated; a share with external principals exposes resources outside the account.

resource "aws_ram_resource_share" "cross_account_subnets" {
  name = "cross-account-subnets"
  allow_external_principals = false
  tags = {
    Description = "Shared subnets"
    PIC = "Ops team"
  }
}
