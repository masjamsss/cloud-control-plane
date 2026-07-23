# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The repository access token (access_token for GitHub, or oauth_token for other providers) is never captured here — the engineer connects the repository out of band, exactly like any other CI integration credential
# TODO: A custom build_spec (amplify.yml), environment variables, and a service role for server-side rendering are engineer follow-ups after creation
# TODO: Custom domains (the companion aws_amplify_domain_association) and auto-branch-creation patterns are engineer decisions

resource "aws_amplify_app" "checkout_web" {
  name = "checkout-web"
  repository = "https://github.com/example-org/checkout-web"
  platform = "WEB_COMPUTE"
  enable_branch_auto_build = true
  enable_branch_auto_deletion = false
  tags = {
    Name = "checkout-web"
    Description = "Frontend for the checkout web app"
    PIC = "Ops team"
  }
}
