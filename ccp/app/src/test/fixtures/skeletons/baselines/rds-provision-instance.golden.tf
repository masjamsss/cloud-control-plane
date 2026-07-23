# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Master credentials go through the secrets manager — never entered in this portal
# TODO: Parameter group choice and tuning
# TODO: License model for Oracle or SQL Server engines
# TODO: Final storage and IOPS sizing review

resource "aws_db_instance" "app_reporting" {
  identifier = "app-reporting"
  engine = "postgres"
  instance_class = "db.t3.xlarge"
  allocated_storage = 52
  storage_type = "gp3"
  multi_az = true
  backup_retention_period = 7
  db_subnet_group_name = aws_db_subnet_group.app_db.name
  vpc_security_group_ids = [aws_security_group.access_to_app01.id]
  deletion_protection = true
  tags = {
    Name = "app-reporting"
    Description = "Reporting database for the app workload"
    PIC = "Ops team"
  }
  lifecycle {
    prevent_destroy = true
  }
}
