# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Environments (the running application stack) are provisioned as an engineer follow-up after the application exists
# TODO: Version retention by COUNT instead of age (max_count) is an engineer decision — this form offers the age-based rule

resource "aws_elastic_beanstalk_application" "checkout_web" {
  name = "checkout-web"
  description = "Customer-facing checkout web application"
  tags = {
    Name = "CHECKOUT-WEB"
    Description = "Elastic Beanstalk application for checkout web"
    PIC = "Ops team"
  }
  appversion_lifecycle {
    service_role = aws_iam_role.application_migration.arn
    max_age_in_days = 90
    delete_source_from_s3 = false
  }
}
