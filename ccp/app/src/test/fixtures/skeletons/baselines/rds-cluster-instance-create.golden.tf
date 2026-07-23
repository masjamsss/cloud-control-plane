# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The engine must match the cluster's engine family — verified by the engineer before apply
# TODO: Custom parameter group and enhanced monitoring role are engineer decisions
# TODO: Additional read replicas: submit this form again once per extra instance

resource "aws_rds_cluster_instance" "analytics_cluster_1" {
  cluster_identifier = aws_rds_cluster.analytics_cluster.cluster_identifier
  identifier = "analytics-cluster-1"
  engine = "aurora-postgresql"
  instance_class = "db.r5.xlarge"
  publicly_accessible = false
  promotion_tier = 1
  performance_insights_enabled = true
  tags = {
    Name = "analytics-cluster-1"
    Description = "Primary instance for the analytics cluster"
    PIC = "Ops team"
  }
}
