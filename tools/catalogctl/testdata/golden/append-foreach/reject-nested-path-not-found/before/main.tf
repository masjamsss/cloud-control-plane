resource "aws_instance" "app" {
  ami           = "ami-0abc123"
  instance_type = "t3.micro"

  tags = {
    Name = "app"
  }
}
