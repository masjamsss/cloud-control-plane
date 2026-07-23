# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Hours of operation, queues, routing profiles, phone numbers, users, and contact flows are all engineer follow-ups added after the instance exists — this form provisions the instance shell
# TODO: SAML federation metadata is an engineer decision when identity management is SAML
# TODO: Storage configuration for call recordings, transcripts, and chat transcripts (the companion aws_connect_instance_storage_config, pointing at S3/Kinesis) is an engineer follow-up

resource "aws_connect_instance" "checkout_support" {
  instance_alias = "checkout-support"
  identity_management_type = "CONNECT_MANAGED"
  inbound_calls_enabled = true
  outbound_calls_enabled = true
  contact_flow_logs_enabled = true
  contact_lens_enabled = true
  tags = {
    Name = "checkout-support"
    Description = "Contact center instance for checkout customer support"
    PIC = "Ops team"
  }
}
