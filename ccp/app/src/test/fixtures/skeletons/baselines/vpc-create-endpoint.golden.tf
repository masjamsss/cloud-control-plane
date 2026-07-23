# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: An Interface endpoint's security groups gate who can reach it; confirm the chosen groups match the intended reachability before this endpoint goes live — a permissive choice quietly opens a private-network shortcut to the service
# TODO: For the S3/DynamoDB-only self-service path, the existing add-a-gateway-endpoint action stays available; use this form for Interface endpoints or other gateway services
# TODO: A resource policy restricting who may use the endpoint, and IP address type, are engineer decisions

resource "aws_vpc_endpoint" "ssm_messages_endpoint" {
  vpc_id = aws_vpc.prod_sample.id
  vpc_endpoint_type = "Interface"
  service_name = "com.amazonaws.ap-southeast-5.ssmmessages"
  subnet_ids = [aws_subnet.backup.id]
  private_dns_enabled = true
  security_group_ids = [aws_security_group.access_to_app01.id]
  tags = {
    Name = "SSM-MESSAGES-ENDPOINT"
    Description = "Private access to Systems Manager messaging"
    PIC = "Ops team"
  }
}
