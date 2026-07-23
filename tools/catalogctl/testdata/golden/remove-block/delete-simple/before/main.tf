resource "aws_ebs_volume" "keep" {
  size = 10
  type = "gp3"
}

resource "aws_ebs_volume" "drop" {
  size = 20
  type = "gp3"
}
