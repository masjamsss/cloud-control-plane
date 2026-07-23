# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: DNS validation records must be published in the zone before the certificate reaches ISSUED — coordinate with whoever controls the zone, or prefer the existing guided DNS-validated request action, which automates the validation records
# TODO: Private-CA-issued certificates (certificate_authority_arn) and imported certificates (certificate_body/private_key) are engineer decisions outside this form

resource "aws_acm_certificate" "app_v2_cert" {
  domain_name = "app-v2.example.com"
  validation_method = "DNS"
  key_algorithm = "RSA_2048"
  tags = {
    Name = "APP-V2-CERT"
    Description = "Certificate for the app-v2 rollout"
    PIC = "Ops team"
  }
  options {
    certificate_transparency_logging_preference = "ENABLED"
  }
}
