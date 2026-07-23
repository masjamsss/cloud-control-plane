# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: source_location_arn and destination_location_arn must already exist — provisioning the matching aws_datasync_location_* resource (S3, NFS, SMB, EFS, FSx, HDFS, object storage) is a prerequisite engineer follow-up; this form does not create locations.
# TODO: Include/exclude filters and a task report destination beyond CloudWatch logging are engineer follow-ups.

resource "aws_datasync_task" "s3_to_onprem_nightly" {
  name = "s3-to-onprem-nightly"
  source_location_arn = "arn:aws:datasync:ap-southeast-5:111122223333:location/loc-0a1b2c3d4e5f6a7b8"
  destination_location_arn = "arn:aws:datasync:ap-southeast-5:111122223333:location/loc-1a2b3c4d5e6f7a8b9"
  task_mode = "BASIC"
  cloudwatch_log_group_arn = aws_cloudwatch_log_group.alarm_handler.arn
  tags = {
    Name = "S3-TO-ONPREM-NIGHTLY"
    Description = "Nightly sync from S3 to on-prem NFS"
    PIC = "Ops team"
  }
  schedule {
    schedule_expression = "cron(0 2 * * ? *)"
  }
  options {
    verify_mode = "POINT_IN_TIME_CONSISTENT"
    transfer_mode = "CHANGED"
    overwrite_mode = "ALWAYS"
    preserve_deleted_files = "PRESERVE"
    log_level = "OFF"
  }
}
