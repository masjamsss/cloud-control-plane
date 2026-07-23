# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A dedicated replication subnet group (aws_dms_replication_subnet_group) is a prerequisite the engineer confirms or creates first; Kerberos authentication settings are an engineer follow-up.
# TODO: Source/target endpoints (aws_dms_endpoint) and the replication task itself are provisioned as engineer follow-ups once this instance exists.

resource "aws_dms_replication_instance" "app_db_migration" {
  # TODO: engine_version — engineer decides
  replication_instance_id = "app-db-migration"
  replication_instance_class = "dms.c5.large"
  allocated_storage = 100
  multi_az = true
  publicly_accessible = false
  vpc_security_group_ids = [aws_security_group.access_to_app01.id]
  replication_subnet_group_id = "default-dms-subnet-group"
  kms_key_arn = aws_kms_key.shared_cmk.arn
  preferred_maintenance_window = "sun:06:00-sun:07:00"
  auto_minor_version_upgrade = true
  tags = {
    Name = "APP-DB-MIGRATION"
    Description = "DMS replication instance for the application-database migration"
    PIC = "Ops team"
  }
}
