# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Deployment circuit breaker, deployment strategy (rolling/blue-green), and capacity provider strategy are engineer decisions
# TODO: Service Connect / service discovery registration is an engineer follow-up after creation
# TODO: Multiple load balancer target groups or an ALB advanced (weighted / blue-green) configuration are engineer decisions — this form wires one target group

resource "aws_ecs_service" "checkout_api_svc" {
  name = "checkout-api-svc"
  cluster = aws_ecs_cluster.checkout_cluster.arn
  task_definition = aws_ecs_task_definition.checkout_api.arn
  launch_type = "FARGATE"
  desired_count = 2
  enable_execute_command = false
  tags = {
    Name = "CHECKOUT-API-SVC"
    Description = "Checkout API service"
    PIC = "Ops team"
  }
  network_configuration {
    subnets = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
    security_groups = [aws_security_group.access_to_app01.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app_default.arn
    container_name = "checkout-api"
    container_port = 8080
  }
}
