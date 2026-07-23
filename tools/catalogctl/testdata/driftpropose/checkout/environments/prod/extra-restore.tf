resource "aws_flow_log" "vpc1" {
  vpc_id               = "vpc-0123456789abcdef0"
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = "arn:aws:logs:us-east-1:123456789012:log-group:vpc-flow-logs-vpc1"
  iam_role_arn         = "arn:aws:iam::123456789012:role/vpc-flow-logs"
}
