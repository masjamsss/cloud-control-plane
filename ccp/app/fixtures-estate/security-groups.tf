# Two security groups: the app tier and the database tier.

resource "aws_security_group" "app" {
  name        = "app-tier"
  description = "Application tier — inbound HTTPS from the load balancer"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "app-tier"
    PIC  = "user01@example.com"
  }
}

resource "aws_security_group" "db" {
  name        = "db-tier"
  description = "Database tier — inbound Postgres from the app tier only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from the app tier"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "db-tier"
    PIC  = "user02@example.com"
  }
}
