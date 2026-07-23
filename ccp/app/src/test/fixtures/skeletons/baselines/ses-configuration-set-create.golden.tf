# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Event destinations (publishing sends/bounces/complaints to SNS, CloudWatch, or Kinesis Firehose) are engineer follow-ups — this form provisions the configuration set with none wired yet
# TODO: Suppression list behavior (suppressed_reasons), a custom click-tracking redirect domain, and VDM (engagement/guardian) dashboard options keep SES account defaults unless an engineer sets them explicitly
# TODO: A dedicated IP pool (sending_pool_name) is an engineer decision — omitted here uses the shared SES IP pool

resource "aws_sesv2_configuration_set" "checkout_notifications" {
  configuration_set_name = "checkout-notifications"
  tags = {
    Name = "checkout-notifications"
    Description = "Sending options for checkout order emails"
    PIC = "Ops team"
  }
  sending_options {
    sending_enabled = true
  }
  reputation_options {
    reputation_metrics_enabled = true
  }
  delivery_options {
    tls_policy = "REQUIRE"
  }
}
