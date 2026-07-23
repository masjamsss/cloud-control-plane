# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: DKIM signing (dkim_signing_attributes — BYODKIM or Easy DKIM) is an engineer follow-up; without it this identity still verifies, but sends without a custom DKIM key
# TODO: A domain identity also needs its DNS verification/DKIM CNAME records published in the zone before mail sends successfully — the engineer confirms who controls that zone

resource "aws_sesv2_email_identity" "no_reply_example_com" {
  email_identity = "no-reply@example.com"
  configuration_set_name = aws_sesv2_configuration_set.checkout_notifications.configuration_set_name
  tags = {
    Name = "no-reply-example-com"
    Description = "Sends checkout order confirmation emails"
    PIC = "Ops team"
  }
}
