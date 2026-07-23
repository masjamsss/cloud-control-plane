# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Cross-account or federated database sharing (target_database / federated_database) is an engineer decision
# TODO: Default table-creation permissions (create_table_default_permission) are an engineer decision

resource "aws_glue_catalog_database" "sales_raw" {
  name = "sales_raw"
  description = "Raw landing zone tables for the sales pipeline"
  location_uri = "s3://sales-data-lake/raw/"
  tags = {
    Name = "sales_raw"
    Description = "Raw landing zone for the sales data pipeline"
    PIC = "Ops team"
  }
}
