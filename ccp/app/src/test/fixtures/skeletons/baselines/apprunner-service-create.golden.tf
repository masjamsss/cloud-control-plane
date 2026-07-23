# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Deploying from a source-code repository (code_repository + an aws_apprunner_connection) instead of a container image is a separate, engineer-authored path — this form covers the common container-image deploy
# TODO: Private ECR repository access (authentication_configuration.access_role_arn) is an engineer follow-up when image_repository_type is ECR and the repository isn't public
# TODO: VPC egress (reaching private resources through an aws_apprunner_vpc_connector), a custom health check, and encryption_configuration (a customer-managed KMS key) are engineer decisions after creation
# TODO: Auto Scaling configuration and observability configuration keep App Runner's account defaults; attach custom ones as an engineer follow-up

resource "aws_apprunner_service" "checkout_api_svc" {
  service_name = "checkout-api-svc"
  tags = {
    Name = "checkout-api-svc"
    Description = "Container service for the checkout API"
    PIC = "Ops team"
  }
  source_configuration {
    auto_deployments_enabled = true
    image_repository {
      image_identifier = "123456789012.dkr.ecr.ap-southeast-5.amazonaws.com/checkout-api:latest"
      image_repository_type = "ECR"
      image_configuration {
        port = 8080
      }
    }
  }
  instance_configuration {
    cpu = "1 vCPU"
    memory = "2 GB"
  }
  network_configuration {
    ingress_configuration {
      is_publicly_accessible = true
    }
  }
}
