# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The gateway host (EC2 instance, on-premises VM, or hardware appliance) must be deployed and running before its activation_key is available; this form provisions the aws_storagegateway_gateway resource that registers it.
# TODO: SMB Active Directory join, bandwidth rate limits, and a private VPC endpoint are engineer follow-ups after creation.

resource "aws_storagegateway_gateway" "onprem_file_gateway" {
  gateway_name = "onprem-file-gateway"
  gateway_timezone = "GMT+9"
  gateway_type = "FILE_S3"
  activation_key = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE"
  cloudwatch_log_group_arn = aws_cloudwatch_log_group.alarm_handler.arn
  tags = {
    Name = "ONPREM-FILE-GATEWAY"
    Description = "On-prem to S3 file gateway"
    PIC = "Ops team"
  }
}
