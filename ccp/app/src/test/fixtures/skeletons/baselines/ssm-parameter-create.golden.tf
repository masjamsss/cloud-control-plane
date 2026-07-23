# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Parameter policies (expiration, expiration notification, NoChangeNotification) and a custom allowed_pattern validation regex are engineer follow-ups after creation.

resource "aws_ssm_parameter" "app_checkout_feature_flags" {
  name = "/app/checkout/feature-flags"
  type = "String"
  value = "«redacted:82fcdf1c»"
  tier = "Standard"
  tags = {
    Description = "Checkout service feature flag parameter"
    PIC = "Ops team"
  }
}
