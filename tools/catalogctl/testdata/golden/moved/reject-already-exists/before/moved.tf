resource "aws_instance" "old_web" {
  ami           = "ami-123"
  instance_type = "t3.micro"
}

resource "aws_instance" "new_web" {
  ami           = "ami-456"
  instance_type = "t3.small"
}
