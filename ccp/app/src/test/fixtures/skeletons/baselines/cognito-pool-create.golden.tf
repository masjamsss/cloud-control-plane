# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Lambda triggers (custom auth challenge, pre-token generation, and the rest of lambda_config) are engineer decisions — none are wired here
# TODO: Custom schema attributes and the email/SMS sending configuration (a verified SES identity or SNS role) are engineer follow-ups
# TODO: This form seeds one recovery mechanism at priority 1; add a second (e.g. verified_phone_number as a priority-2 fallback) as an engineer follow-up — Cognito allows up to two
# TODO: Password policy keeps Cognito's built-in defaults (8-character minimum, upper/lower/number/symbol required); tighten or relax it as an engineer follow-up

resource "aws_cognito_user_pool" "checkout_users" {
  name = "checkout-users"
  mfa_configuration = "OPTIONAL"
  deletion_protection = "ACTIVE"
  auto_verified_attributes = ["email"]
  tags = {
    Name = "checkout-users"
    Description = "User pool for the checkout app sign-up and sign-in"
    PIC = "Ops team"
  }
  account_recovery_setting {
    recovery_mechanism {
      name = "verified_email"
      priority = 1
    }
  }
}
