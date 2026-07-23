resource "aws_instance" "dottedbox01" {
  ami           = "ami-0123456789abcdef0"
  instance_type = "m5.large"

  tags = {
    "kubernetes.io/role/elb" = "shared"
    Owner                    = "platform"
  }
}
