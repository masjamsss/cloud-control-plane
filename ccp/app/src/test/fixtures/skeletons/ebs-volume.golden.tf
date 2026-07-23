# DRAFT — generated from request REQ-0200; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Confirm the device name is free on the host
# TODO: Confirm the KMS key choice if the workload is key-scoped

resource "aws_ebs_volume" "app02_sdd" {
  availability_zone = aws_instance.app02.availability_zone
  size = 500
  type = "gp3"
  iops = 3000
  throughput = 125
  encrypted = true
  tags = {
    Name = "APP02 sdd"
    Description = "Application data volume"
    PIC = "Ops team"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "app02_sdd" {
  device_name = "/dev/sdd"
  volume_id = aws_ebs_volume.app02_sdd.id
  instance_id = aws_instance.app02.id
}
