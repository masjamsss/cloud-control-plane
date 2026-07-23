# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A specific Lightsail key pair (its own namespace, separate from EC2 key pairs) is an engineer decision — leave blank for the account default
# TODO: A custom user-data bootstrap script is an engineer follow-up added after creation
# TODO: Static IP, disk attachments, and load-balancer attachment are engineer follow-ups after the instance exists

resource "aws_lightsail_instance" "marketing_site" {
  name = "marketing-site"
  availability_zone = "ap-southeast-5b"
  blueprint_id = "amazon_linux_2023"
  bundle_id = "small_3_0"
  ip_address_type = "ipv4"
  tags = {
    Name = "MARKETING-SITE"
    Description = "Marketing site Lightsail instance"
    PIC = "Ops team"
  }
}
