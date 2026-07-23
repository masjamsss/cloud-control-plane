resource "aws_instance" "old_web" {
  ami           = "ami-123"
  instance_type = "t3.micro"
}
