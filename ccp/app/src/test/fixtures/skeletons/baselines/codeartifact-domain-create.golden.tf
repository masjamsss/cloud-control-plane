# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Repositories inside the domain, upstream relationships, and external connections (npm/PyPI/Maven Central) are engineer follow-ups after creation
# TODO: A domain permissions policy for cross-account sharing is an engineer decision

resource "aws_codeartifact_domain" "platform_packages" {
  domain = "platform-packages"
  tags = {
    Name = "PLATFORM-PACKAGES"
    Description = "Shared package domain for platform teams"
    PIC = "Ops team"
  }
}
