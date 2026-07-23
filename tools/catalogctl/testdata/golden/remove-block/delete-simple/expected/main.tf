resource "aws_ebs_volume" "keep" {
  size = 10
  type = "gp3"
}
