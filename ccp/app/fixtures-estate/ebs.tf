# One extra data volume, attached to app01.

resource "aws_ebs_volume" "app01_data" {
  availability_zone = "us-east-1a"
  size              = 200
  type              = "gp3"
  iops              = 3000
  throughput        = 125
  encrypted         = true

  tags = {
    Name        = "APP01 data"
    PIC         = "user01@example.com"
    Description = "Data volume for the application server"
  }
}

resource "aws_volume_attachment" "app01_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.app01_data.id
  instance_id = aws_instance.app01.id
}

# A legacy gp2 volume pending the gp2→gp3 migration — demonstrates the
# one-direction "ebs-gp2-to-gp3" catalog operation.
resource "aws_ebs_volume" "app02_legacy" {
  availability_zone = "us-east-1a"
  size              = 100
  type              = "gp2"
  encrypted         = true

  tags = {
    Name        = "APP02 legacy data"
    PIC         = "user02@example.com"
    Description = "Legacy volume pending gp2-to-gp3 migration"
  }
}

resource "aws_volume_attachment" "app02_legacy" {
  device_name = "/dev/sdg"
  volume_id   = aws_ebs_volume.app02_legacy.id
  instance_id = aws_instance.app02.id
}
