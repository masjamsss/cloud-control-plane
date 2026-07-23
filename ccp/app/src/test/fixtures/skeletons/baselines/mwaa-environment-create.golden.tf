# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: requirements.txt / plugins.zip S3 object versions, custom Airflow configuration options (airflow_configuration_options), and per-log-type logging levels are engineer follow-ups after creation.
# TODO: Endpoint management mode and worker replacement strategy beyond the AWS defaults are engineer follow-ups.

resource "aws_mwaa_environment" "data_platform_airflow" {
  name = "data-platform-airflow"
  source_bucket_arn = aws_s3_bucket.alarm_ticket_table.arn
  dag_s3_path = "dags/"
  execution_role_arn = aws_iam_role.application_migration.arn
  airflow_version = "2.10.3"
  environment_class = "mw1.small"
  min_workers = 1
  max_workers = 5
  schedulers = 2
  webserver_access_mode = "PRIVATE_ONLY"
  kms_key = aws_kms_key.shared_cmk.arn
  tags = {
    Name = "DATA-PLATFORM-AIRFLOW"
    Description = "Managed Airflow environment for the data platform"
    PIC = "Ops team"
  }
  network_configuration {
    security_group_ids = [aws_security_group.access_to_app01.id]
    subnet_ids = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
  }
}
