resource "aws_ebs_volume" "demo" {
  size = 20
  type = "gp3"
}
