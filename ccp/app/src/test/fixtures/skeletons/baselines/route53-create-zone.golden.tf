# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Leaving the VPC picker blank creates a PUBLIC hosted zone, resolvable from the internet once delegated; picking a VPC creates a PRIVATE zone resolvable only inside it — confirm which is intended before submitting
# TODO: Associating additional VPCs afterward, and a custom/reusable delegation set, are engineer follow-ups (the existing associate-a-VPC action)
# TODO: Records are added as a separate follow-up step (the existing add-a-record action) — a new zone starts with only its default NS/SOA records

resource "aws_route53_zone" "internal_example_com" {
  name = "internal.example.com"
  comment = "Private zone for internal service discovery"
  force_destroy = false
  tags = {
    Name = "INTERNAL-ZONE"
    Description = "Private DNS zone for internal services"
    PIC = "Ops team"
  }
  vpc {
    vpc_id = aws_vpc.prod_sample.id
  }
}
