resource "aws_instance" "old_web" {
  ami           = "ami-123"
  instance_type = "t3.micro"
}

resource "aws_eip" "web_ip" {
  instance = aws_instance.old_web.id
}
