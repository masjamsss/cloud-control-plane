# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Custom parameter group is an engineer decision
# TODO: Additional read replicas: submit this form again once per extra instance

resource "aws_neptune_cluster_instance" "graph_links_1" {
  cluster_identifier = aws_neptune_cluster.graph_links.cluster_identifier
  identifier = "graph-links-1"
  engine = "neptune"
  instance_class = "db.r5.large"
  promotion_tier = 1
  publicly_accessible = false
  tags = {
    Name = "graph-links-1"
    Description = "Primary instance for the graph-links cluster"
    PIC = "Ops team"
  }
}
