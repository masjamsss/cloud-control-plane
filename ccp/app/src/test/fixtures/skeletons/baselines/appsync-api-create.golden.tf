# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The GraphQL schema (SDL), data sources, resolvers, and functions are engineer follow-ups — this form provisions the empty API container
# TODO: Choosing AMAZON_COGNITO_USER_POOLS, OPENID_CONNECT, or AWS_LAMBDA authentication requires additional required configuration (user_pool_config / openid_connect_config / lambda_authorizer_config) that an engineer completes during review
# TODO: Additional authentication providers (additional_authentication_provider) beyond the primary mode are an engineer decision

resource "aws_appsync_graphql_api" "checkout_graphql" {
  name = "checkout-graphql"
  authentication_type = "API_KEY"
  visibility = "GLOBAL"
  xray_enabled = false
  tags = {
    Name = "checkout-graphql"
    Description = "GraphQL API for the checkout app"
    PIC = "Ops team"
  }
}
