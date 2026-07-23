resource "aws_instance" "new_web" {
  ami           = "ami-123"
  instance_type = "t3.micro"
}

moved {
  from = aws_instance.old_web
  to   = aws_instance.new_web
}
