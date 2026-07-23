# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Step scaling and predictive scaling policy types are engineer decisions — this form covers the common target-tracking case
# TODO: A customized CloudWatch metric (customized_metric_specification) instead of a predefined ECS metric is an engineer decision
# TODO: This resource carries no tags attribute in the provider schema — it is not taggable

resource "aws_appautoscaling_policy" "tt_cpu_60" {
  name = "tt-cpu-60"
  policy_type = "TargetTrackingScaling"
  resource_id = "service/checkout-cluster/checkout-api-svc"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace = "ecs"
  target_tracking_scaling_policy_configuration {
    target_value = 60
    scale_out_cooldown = 60
    scale_in_cooldown = 300
    disable_scale_in = false
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
