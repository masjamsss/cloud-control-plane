resource "aws_security_group" "web" {
  name = "web-sg"

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.200.0.0/16"]
  }

  ingress {
    protocol   = "tcp"
    from_port  = 8080
    to_port    = 8080
    cidr_block = "10.20.0.0/16"
  }
}
