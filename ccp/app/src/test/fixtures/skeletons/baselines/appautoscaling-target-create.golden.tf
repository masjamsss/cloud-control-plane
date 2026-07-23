# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Registering a target for a non-ECS namespace (DynamoDB, RDS, Spot Fleet, SageMaker, custom resources) is an engineer decision — use the request-a-change catch-all
# TODO: Suspended-state overrides (pausing scale-in/scale-out/scheduled scaling) are an engineer follow-up after creation

resource "aws_appautoscaling_target" "checkout_svc_scaling" {
  service_namespace = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id = "service/checkout-cluster/checkout-api-svc"
  min_capacity = 1
  max_capacity = 4
  tags = {
    Name = "CHECKOUT-SVC-SCALING"
    Description = "Scaling target for the checkout API service"
    PIC = "Ops team"
  }
}
