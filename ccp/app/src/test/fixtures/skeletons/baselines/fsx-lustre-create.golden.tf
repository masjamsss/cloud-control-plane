# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: per_unit_storage_throughput (required for PERSISTENT_1/PERSISTENT_2, invalid for SCRATCH types) is an engineer decision made at review time based on the chosen deployment type.
# TODO: An S3 data repository association (import_path/export_path) and Multi-AZ subnet placement beyond the single subnet authored here are engineer follow-ups.

resource "aws_fsx_lustre_file_system" "ml_training_scratch" {
  subnet_ids = [aws_subnet.development.id]
  security_group_ids = [aws_security_group.apm_agents.id]
  deployment_type = "SCRATCH_2"
  storage_capacity = 2400
  storage_type = "SSD"
  data_compression_type = "LZ4"
  weekly_maintenance_start_time = "7:00:00"
  tags = {
    Name = "ML-TRAINING-SCRATCH"
    Description = "Scratch storage for ML training jobs"
    PIC = "Ops team"
  }
}
