# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Wiring this identity pool to a login provider (a Cognito user pool client, SAML, OIDC, or social login) is an engineer follow-up — this form provisions the identity pool shell with no providers attached yet
# TODO: IAM roles for authenticated/unauthenticated identities (the companion aws_cognito_identity_pool_roles_attachment) are an engineer decision — without it this pool cannot vend credentials

resource "aws_cognito_identity_pool" "checkout_identity_pool" {
  identity_pool_name = "checkout-identity-pool"
  allow_unauthenticated_identities = false
  allow_classic_flow = false
  tags = {
    Name = "checkout-identity-pool"
    Description = "Vends temporary AWS credentials to signed-in checkout app users"
    PIC = "Ops team"
  }
}
