resource "aws_security_group" "web" {
  name = "web-sg"

  ingress {
    from_port = 443
    to_port   = 443
    protocol  = "tcp"
  }
}
