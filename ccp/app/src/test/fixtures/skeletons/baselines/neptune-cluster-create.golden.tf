# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Cluster and instance parameter group choice and tuning
# TODO: IAM database authentication and the neptune IAM roles list are engineer decisions
# TODO: At least one aws_neptune_cluster_instance is required before the cluster serves traffic — use the companion cluster-instance form after this is approved
# TODO: Global cluster membership is an engineer decision

resource "aws_neptune_cluster" "graph_links" {
  cluster_identifier = "graph-links"
  engine = "neptune"
  backup_retention_period = 7
  storage_encrypted = true
  neptune_subnet_group_name = aws_neptune_subnet_group.graph_tier.name
  vpc_security_group_ids = [aws_security_group.access_to_app01.id]
  deletion_protection = true
  tags = {
    Name = "graph-links"
    Description = "Graph database for the relationship-links workload"
    PIC = "Ops team"
  }
}
