# App log group and a CPU alarm.

resource "aws_cloudwatch_log_group" "app" {
  name              = "/app/service-logs"
  retention_in_days = 365

  tags = {
    Name        = "app-service-logs"
    PIC         = "user01@example.com"
    Description = "App service logs"
  }
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "app-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "missing"

  dimensions = {
    InstanceId = aws_instance.app01.id
  }

  tags = {
    Name = "app-cpu-high"
    PIC  = "user01@example.com"
  }
}
