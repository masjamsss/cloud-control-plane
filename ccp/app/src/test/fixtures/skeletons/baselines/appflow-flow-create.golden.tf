# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Source and destination connector properties (bucket names, object prefixes, SaaS-specific field settings) are engineer-authored after creation — AppFlow's per-connector schema is too heterogeneous to bound generically.
# TODO: This form authors one field mapping (task); additional mappings/transformations are an engineer follow-up.
# TODO: A Scheduled trigger's cron expression and Glue Data Catalog metadata export are engineer follow-ups.

resource "aws_appflow_flow" "salesforce_to_s3" {
  name = "salesforce-to-s3"
  description = "Sync Salesforce leads into the analytics bucket"
  tags = {
    Name = "SALESFORCE-TO-S3"
    Description = "Salesforce lead sync flow"
    PIC = "Ops team"
  }
  source_flow_config {
    connector_type = "Salesforce"
    connector_profile_name = "salesforce-prod"
  }
  destination_flow_config {
    connector_type = "S3"
  }
  trigger_config {
    trigger_type = "Scheduled"
  }
  task {
    task_type = "Map_all"
  }
}
