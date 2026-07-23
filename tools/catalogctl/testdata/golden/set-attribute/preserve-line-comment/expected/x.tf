resource "aws_ebs_volume" "demo" {
  availability_zone = "ap-southeast-5a"
  size              = 40 # grown 2026-01 for ERP archive
  type              = "gp3"
}
