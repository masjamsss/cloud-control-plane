resource "aws_efs_file_system" "sagemaker_d_eieixoxqc8h9" {
  creation_token   = "d-eieixoxqc8h9"
  encrypted        = true
  kms_key_id       = "arn:aws:kms:ap-southeast-5:123456789012:key/fa59d241-1759-4624-aa43-7fc06074d7d6" # alias/aws/elasticfilesystem (AWS-managed)
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  lifecycle_policy {
    transition_to_archive = "AFTER_180_DAYS"
  }

  tags = {
    ManagedByAmazonSageMakerResource = "arn:aws:sagemaker:ap-southeast-5:123456789012:domain/d-eieixoxqc8h9"
  }
}
