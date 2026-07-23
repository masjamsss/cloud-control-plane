# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A lifecycle policy (expiring untagged or old images) is an engineer follow-up after creation
# TODO: Cross-account or public replication and a repository policy are engineer decisions

resource "aws_ecr_repository" "platform_checkout_api" {
  name = "platform/checkout-api"
  image_tag_mutability = "IMMUTABLE"
  force_delete = false
  tags = {
    Name = "CHECKOUT-API-REPO"
    Description = "Container images for the checkout API"
    PIC = "Ops team"
  }
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}
