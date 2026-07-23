# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Python-shell and streaming job types (command.name) are engineer decisions — this form provisions the standard Spark ETL type
# TODO: Job arguments (default_arguments), connections, and a security configuration are engineer decisions
# TODO: Triggers and workflow membership are engineer follow-ups after creation

resource "aws_glue_job" "sales_daily_etl" {
  name = "sales-daily-etl"
  description = "Daily transform of raw sales events into the curated table"
  role_arn = aws_iam_role.application_migration.arn
  glue_version = "4.0"
  worker_type = "G.1X"
  number_of_workers = 2
  timeout = 2880
  max_retries = 0
  tags = {
    Name = "sales-daily-etl"
    Description = "Daily ETL job for the sales pipeline"
    PIC = "Ops team"
  }
  command {
    script_location = "s3://sales-data-lake/scripts/daily_etl.py"
    name = "glueetl"
  }
}
