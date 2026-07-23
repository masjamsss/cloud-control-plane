# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Step scaling and predictive scaling policy types are an engineer decision — this form covers the recommended target-tracking case only
# TODO: A customized (non-predefined) metric specification is an engineer decision

resource "aws_autoscaling_policy" "tt_cpu" {
  name = "tt-cpu"
  autoscaling_group_name = aws_autoscaling_group.app_tier_asg.name
  policy_type = "TargetTrackingScaling"
  target_tracking_configuration {
    target_value = 60
    disable_scale_in = false
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label = "app/my-app-alb/50dc6c495c0c9188/targetgroup/my-targets/73e2d6bc24d8a067"
    }
  }
}
