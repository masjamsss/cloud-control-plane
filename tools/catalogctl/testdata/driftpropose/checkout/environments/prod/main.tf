resource "aws_instance" "sample01" {
  ami           = "ami-0123456789abcdef0"
  instance_type = "m5.xlarge"

  tags = {
    Owner = "platform"
    Env   = "prod"
  }
}

resource "aws_security_group" "sg1" {
  name = "sg1"

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
}

resource "aws_db_instance" "db1" {
  identifier     = "db1"
  engine         = "postgres"
  instance_class = "db.m5.large"
}
