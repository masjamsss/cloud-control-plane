# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Confirm the alarm notifies the right on-call target: an alarm with no action, or the wrong SNS topic, fires silently and no one is paged.
# TODO: The metric name, namespace, and dimensions must match the resource being watched; the engineer confirms them against the live resource, since a mismatched alarm watches nothing.

resource "aws_cloudwatch_metric_alarm" "app_cpu_high" {
  alarm_name = "app-cpu-high"
  metric_name = "CPUUtilization"
  namespace = "AWS/EC2"
  comparison_operator = "GreaterThanThreshold"
  statistic = "Average"
  period = 300
  evaluation_periods = 3
  threshold = 80
  alarm_actions = [aws_sns_topic.notify_cloud_team.arn]
  treat_missing_data = "missing"
  tags = {
    Description = "App CPU alarm"
    PIC = "Ops team"
  }
}
