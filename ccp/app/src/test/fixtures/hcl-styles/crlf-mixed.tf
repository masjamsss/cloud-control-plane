resource "aws_instance" "windows_style" {
  instance_type = "t3.large"
  tags = {
    OS = "windows"
  }
}
resource "aws_ebs_volume" "unix_after_crlf" {
  size = 50
}
