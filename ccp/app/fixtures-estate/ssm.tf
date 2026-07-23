# A shared app config parameter.

resource "aws_ssm_parameter" "app_config" {
  name        = "/app/checkout/feature-flags"
  type        = "String"
  value       = "{}"
  description = "Checkout service feature flag parameter"

  tags = {
    Name = "app-config"
    PIC  = "user01@example.com"
  }
}
