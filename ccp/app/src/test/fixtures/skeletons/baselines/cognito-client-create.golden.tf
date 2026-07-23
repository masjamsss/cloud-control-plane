# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Hosted UI / OAuth configuration (callback_urls, logout_urls, allowed_oauth_flows/scopes, supported_identity_providers) is an engineer follow-up if this client uses the Hosted UI rather than direct SRP/password auth
# TODO: Token validity periods keep Cognito's defaults (60 minutes access/ID, 30 days refresh); tune them afterward if needed
# TODO: Read/write attribute allowlists (read_attributes/write_attributes) default to every standard attribute; narrow them as an engineer follow-up if this client should see less of the user profile

resource "aws_cognito_user_pool_client" "checkout_web_client" {
  name = "checkout-web-client"
  user_pool_id = aws_cognito_user_pool.checkout_users.id
  generate_secret = false
  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
}
