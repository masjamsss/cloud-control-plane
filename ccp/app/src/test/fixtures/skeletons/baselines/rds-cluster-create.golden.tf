# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Master credentials go through the secrets manager — never entered in this portal
# TODO: Cluster and instance parameter group choice and tuning
# TODO: Storage type, allocated storage, and IOPS for a Multi-AZ DB cluster or Aurora Serverless v2 capacity range are engineer decisions
# TODO: At least one aws_rds_cluster_instance is required before the cluster serves traffic — use the companion cluster-instance form after this is approved
# TODO: Global cluster membership and cross-region replication are engineer decisions

resource "aws_rds_cluster" "analytics_cluster" {
  cluster_identifier = "analytics-cluster"
  engine = "aurora-postgresql"
  database_name = "analytics"
  backup_retention_period = 7
  storage_encrypted = true
  db_subnet_group_name = aws_db_subnet_group.app_db.name
  vpc_security_group_ids = [aws_security_group.access_to_app01.id]
  deletion_protection = true
  tags = {
    Name = "analytics-cluster"
    Description = "Aurora cluster for the analytics workload"
    PIC = "Ops team"
  }
}
