resource "aws_volume_attachment" "demo" {
  device_name = "/dev/sdz"
  volume_id   = aws_ebs_volume.demo.id
  instance_id = "i-0"
}
