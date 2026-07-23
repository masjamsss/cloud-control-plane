# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Confirm the retention period meets the audit and compliance requirement: log events are deleted permanently once retention lapses.

resource "aws_cloudwatch_log_group" "app_service_logs" {
  name = "/app/service-logs"
  retention_in_days = 365
  log_group_class = "STANDARD"
  tags = {
    Description = "App service logs"
    PIC = "Ops team"
  }
}
