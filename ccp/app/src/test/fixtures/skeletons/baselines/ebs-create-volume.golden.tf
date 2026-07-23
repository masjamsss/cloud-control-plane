# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Confirm the device name is free on the host
# TODO: Confirm the encryption key choice if the workload is key-scoped

resource "aws_ebs_volume" "app01_sdd" {
  availability_zone = aws_instance.bastion.availability_zone
  size = 500
  type = "gp3"
  iops = 3000
  throughput = 125
  encrypted = true
  tags = {
    Name = "APP01 sdd"
    Description = "Data volume"
    PIC = "Ops team"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "app01_sdd" {
  device_name = "/dev/sdd"
  volume_id = aws_ebs_volume.app01_sdd.id
  instance_id = aws_instance.bastion.id
}
