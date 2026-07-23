# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: AWS Managed Microsoft AD (active_directory_id) is the common case; a self-managed Active Directory join (self_managed_active_directory, including its service-account password) is an engineer follow-up.
# TODO: DNS aliases, audit-log configuration, and disk IOPS provisioning are engineer follow-ups after creation.

resource "aws_fsx_windows_file_system" "app_fileshare" {
  subnet_ids = [aws_subnet.backup.id]
  security_group_ids = [aws_security_group.access_to_app01.id]
  deployment_type = "SINGLE_AZ_2"
  storage_capacity = 300
  storage_type = "SSD"
  throughput_capacity = 64
  kms_key_id = aws_kms_key.shared_cmk.arn
  automatic_backup_retention_days = 14
  weekly_maintenance_start_time = "3:02:00"
  tags = {
    Name = "APP-FILESHARE"
    Description = "Windows file share for the app tier"
    PIC = "Ops team"
  }
}
