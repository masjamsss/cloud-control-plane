# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Master credentials go through the secrets manager — never entered in this portal
# TODO: Cluster parameter group choice and tuning
# TODO: At least one aws_docdb_cluster_instance is required before the cluster serves traffic — use the companion cluster-instance form after this is approved
# TODO: Global cluster membership is an engineer decision

resource "aws_docdb_cluster" "catalog_docs" {
  cluster_identifier = "catalog-docs"
  engine = "docdb"
  backup_retention_period = 7
  storage_encrypted = true
  db_subnet_group_name = aws_docdb_subnet_group.doc_tier.name
  vpc_security_group_ids = [aws_security_group.access_to_app01.id]
  deletion_protection = true
  tags = {
    Name = "catalog-docs"
    Description = "Document store for the catalog service"
    PIC = "Ops team"
  }
}
