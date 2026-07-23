# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Confirm the outbound rules — the estate default allows all outbound traffic
# TODO: Attaching the group to servers or services happens per resource afterwards

resource "aws_security_group" "cache_tier" {
  name = "cache-tier"
  description = "Allows the app tier to reach the new cache tier"
  vpc_id = aws_vpc.prod_sample.id
  tags = {
    Name = "cache-tier"
    Description = "Cache tier traffic policy"
    PIC = "Ops team"
  }
  ingress {
    protocol = "tcp"
    from_port = 8443
    to_port = 8443
    cidr_blocks = ["10.0.0.0/16"]
  }
}
