# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Custom parameter group is an engineer decision
# TODO: Additional read replicas: submit this form again once per extra instance

resource "aws_docdb_cluster_instance" "catalog_docs_1" {
  cluster_identifier = aws_docdb_cluster.catalog_docs.cluster_identifier
  identifier = "catalog-docs-1"
  engine = "docdb"
  instance_class = "db.r5.large"
  promotion_tier = 1
  enable_performance_insights = true
  tags = {
    Name = "catalog-docs-1"
    Description = "Primary instance for the catalog document store"
    PIC = "Ops team"
  }
}
