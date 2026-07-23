# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Master credentials go through the secrets manager — never entered in this portal
# TODO: Parameter group and maintenance track are engineer decisions
# TODO: IAM role attachments for Redshift Spectrum or COPY/UNLOAD to S3 are engineer follow-ups after creation
# TODO: Elastic IP and enhanced VPC routing beyond the defaults are engineer decisions

resource "aws_redshift_cluster" "reporting_warehouse" {
  cluster_identifier = "reporting-warehouse"
  node_type = "ra3.xlplus"
  cluster_type = "multi-node"
  number_of_nodes = 2
  database_name = "reporting"
  encrypted = true
  automated_snapshot_retention_period = 7
  cluster_subnet_group_name = aws_redshift_subnet_group.warehouse_tier.name
  vpc_security_group_ids = [aws_security_group.access_to_app01.id]
  publicly_accessible = false
  tags = {
    Name = "reporting-warehouse"
    Description = "Data warehouse for the reporting workload"
    PIC = "Ops team"
  }
}
