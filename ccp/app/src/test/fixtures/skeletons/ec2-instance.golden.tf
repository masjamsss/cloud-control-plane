# DRAFT — generated from request REQ-0100; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: AMI selection and validation
# TODO: Static IP or elastic IP strategy
# TODO: IAM instance profile
# TODO: Placement and tenancy review

resource "aws_instance" "app_03" {
  # TODO: ami — engineer decides
  instance_type = "m6i.xlarge"
  key_name = aws_key_pair.admin.key_name
  subnet_id = aws_subnet.app_a.id
  vpc_security_group_ids = [aws_security_group.app.id, aws_security_group.mgmt.id]
  associate_public_ip_address = false
  disable_api_termination = true
  tags = {
    Name = "APP-03"
    Description = "Application server for the reporting cluster"
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
