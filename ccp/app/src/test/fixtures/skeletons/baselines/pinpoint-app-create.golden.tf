# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Messaging channels (email, SMS, push notification credentials) are separate resources added as engineer follow-ups once this project exists
# TODO: Sending limits, quiet hours, and the campaign hook (a Lambda pre-send filter) keep Pinpoint defaults until an engineer sets them

resource "aws_pinpoint_app" "checkout_messaging" {
  name = "checkout-messaging"
  tags = {
    Name = "checkout-messaging"
    Description = "Messaging project for checkout order notifications"
    PIC = "Ops team"
  }
}
