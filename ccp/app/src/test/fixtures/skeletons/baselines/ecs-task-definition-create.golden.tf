# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The container spec (image, port mappings, environment, log driver) is an engineer decision, matched to the workload's built image
# TODO: CPU architecture / operating system family (runtime_platform), volumes, and placement constraints are engineer follow-ups
# TODO: A CPU/memory combination outside Fargate's accepted pairs is caught at apply time — the engineer reviewing confirms the pair is valid

resource "aws_ecs_task_definition" "checkout_api" {
  # TODO: container_definitions — engineer decides
  family = "checkout-api"
  requires_compatibilities = ["FARGATE"]
  network_mode = "awsvpc"
  cpu = "512"
  memory = "1024"
  execution_role_arn = aws_iam_role.application_migration.arn
  tags = {
    Name = "CHECKOUT-API"
    Description = "Checkout API task definition"
    PIC = "Ops team"
  }
}
