# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Machine image choice and validation
# TODO: Static IP or elastic IP strategy
# TODO: Permissions profile when none is chosen
# TODO: Placement and tenancy review

resource "aws_instance" "app_02" {
  # TODO: ami — engineer decides
  instance_type = "m5.xlarge"
  key_name = aws_key_pair.admin_ops.key_name
  subnet_id = aws_subnet.backup.id
  vpc_security_group_ids = [aws_security_group.access_to_app01.id, aws_security_group.allinternal_to_backupproxy.id]
  associate_public_ip_address = false
  iam_instance_profile = "ssm-instance-profile"
  disable_api_termination = true
  tags = {
    Name = "APP-02"
    Description = "Application server for the cluster"
    PIC = "Ops team"
  }
  root_block_device {
    volume_size = 200
    volume_type = "gp3"
    encrypted = true
  }
  metadata_options {
    http_tokens = "required"
  }
  lifecycle {
    prevent_destroy = true
  }
}
