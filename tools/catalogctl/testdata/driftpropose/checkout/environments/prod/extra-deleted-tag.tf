resource "aws_instance" "tagdel01" {
  ami           = "ami-0123456789abcdef0"
  instance_type = "m5.large"

  tags = {
    Owner      = "platform"
    CostCenter = "cc-42"
  }
}
