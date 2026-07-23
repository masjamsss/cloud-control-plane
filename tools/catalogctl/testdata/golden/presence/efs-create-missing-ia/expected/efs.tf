resource "aws_efs_file_system" "sagemaker_d_eoyniqjaesh5" {
  creation_token   = "d-eoyniqjaesh5"
  encrypted        = true
  kms_key_id       = "arn:aws:kms:ap-southeast-5:123456789012:key/fa59d241-1759-4624-aa43-7fc06074d7d6" # alias/aws/elasticfilesystem (AWS-managed)
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  tags = {
    ManagedByAmazonSageMakerResource = "arn:aws:sagemaker:ap-southeast-5:123456789012:domain/d-eoyniqjaesh5"
  }
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
}
