# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Additional crawl targets (more S3 prefixes, JDBC, DynamoDB, Delta, Iceberg, Hudi, MongoDB) are an engineer follow-up — this form provisions the single most common S3 target
# TODO: Classifiers and a security configuration are engineer decisions
# TODO: Lake Formation credential mode and lineage settings are engineer decisions

resource "aws_glue_crawler" "sales_raw_crawler" {
  name = "sales-raw-crawler"
  database_name = aws_glue_catalog_database.sales_raw.name
  role = aws_iam_role.application_migration.arn
  tags = {
    Name = "sales-raw-crawler"
    Description = "Crawls the raw sales landing zone into the catalog"
    PIC = "Ops team"
  }
  s3_target {
    path = "s3://sales-data-lake/raw/"
  }
  schema_change_policy {
    update_behavior = "UPDATE_IN_DATABASE"
    delete_behavior = "DEPRECATE_IN_DATABASE"
  }
}
