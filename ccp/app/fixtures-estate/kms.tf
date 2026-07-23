# One customer-managed key shared by S3/EFS/RDS for at-rest encryption.

resource "aws_kms_key" "app_key" {
  description             = "App data encryption key"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "app-key"
    PIC  = "user01@example.com"
  }
}

resource "aws_kms_alias" "app_key" {
  name          = "alias/app-key"
  target_key_id = aws_kms_key.app_key.key_id
}
