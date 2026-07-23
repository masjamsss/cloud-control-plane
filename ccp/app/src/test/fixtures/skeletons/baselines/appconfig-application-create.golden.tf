# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Configuration profiles, deployment strategies, environments, and hosted configuration versions are provisioned as engineer follow-ups after the application exists.

resource "aws_appconfig_application" "checkout_service" {
  name = "checkout-service"
  description = "Feature flags and runtime configuration for the checkout service"
  tags = {
    Name = "CHECKOUT-SERVICE"
    Description = "Feature flags for checkout"
    PIC = "Ops team"
  }
}
