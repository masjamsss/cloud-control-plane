# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Listeners and endpoint groups are engineer follow-ups — this form provisions the accelerator shell with its two static anycast IPs, nothing routed to yet
# TODO: Flow-log destination (S3 bucket/prefix) and bring-your-own IP address ranges are engineer decisions

resource "aws_globalaccelerator_accelerator" "app_v2_accelerator" {
  name = "app-v2-accelerator"
  enabled = true
  ip_address_type = "IPV4"
  tags = {
    Name = "APP-V2-ACCELERATOR"
    Description = "Global Accelerator for the app-v2 rollout"
    PIC = "Ops team"
  }
}
