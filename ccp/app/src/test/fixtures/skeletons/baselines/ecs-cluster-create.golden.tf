# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Capacity providers (Fargate, Fargate Spot, or an Auto Scaling group-backed EC2 provider) are attached as an engineer follow-up
# TODO: Service Connect namespace defaults and KMS-backed execute-command encryption are engineer decisions

resource "aws_ecs_cluster" "checkout_cluster" {
  name = "checkout-cluster"
  tags = {
    Name = "CHECKOUT-CLUSTER"
    Description = "Shared ECS cluster for the checkout workload"
    PIC = "Ops team"
  }
  setting {
    value = "enabled"
    name = "containerInsights"
  }
  configuration {
    execute_command_configuration {
      logging = "DEFAULT"
    }
  }
}
