# One Postgres instance on a two-AZ subnet group.

resource "aws_db_subnet_group" "main" {
  name       = "app-db-subnet-group"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.public_b.id]

  tags = {
    Name = "app-db-subnet-group"
    PIC  = "user02@example.com"
  }
}

resource "aws_db_instance" "app_db" {
  identifier             = "app-db"
  engine                 = "postgres"
  engine_version         = "16.4"
  instance_class         = "db.t3.large"
  allocated_storage      = 100
  storage_type           = "gp3"
  multi_az               = true
  backup_retention_period = 7
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  username                    = "app_admin"
  manage_master_user_password = true # AWS-managed via Secrets Manager — no literal password
  skip_final_snapshot         = false
  final_snapshot_identifier = "app-db-final"

  tags = {
    Name        = "app-db"
    PIC         = "user02@example.com"
    Description = "Primary application database"
  }
}
