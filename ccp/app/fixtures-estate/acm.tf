# Wildcard certificate for the estate's public domain.

resource "aws_acm_certificate" "wildcard" {
  domain_name       = "*.example.com"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "example-com-wildcard"
    PIC  = "user01@example.com"
  }
}
