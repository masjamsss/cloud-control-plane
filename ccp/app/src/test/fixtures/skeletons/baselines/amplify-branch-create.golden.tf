# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Environment variables that differ from the app-level defaults are an engineer follow-up
# TODO: A custom domain / subdomain mapping (the companion aws_amplify_domain_association) is an engineer decision
# TODO: Framework auto-detection is left to Amplify; overriding it is an engineer follow-up if detection misfires

resource "aws_amplify_branch" "main" {
  app_id = aws_amplify_app.checkout_web.id
  branch_name = "main"
  stage = "PRODUCTION"
  enable_auto_build = true
  tags = {
    Name = "checkout-web-main"
    Description = "Production branch for the checkout web app"
    PIC = "Ops team"
  }
}
