resource "aws_instance" "volbox01" {
  ami           = "ami-0123456789abcdef0"
  instance_type = "m5.large"

  root_block_device {
    volume_size = 80
    volume_type = "gp3"
  }
}
