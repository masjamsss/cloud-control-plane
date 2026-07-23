resource "aws_kms_key" "trail" {
  description             = "duplicate trail key in a second file"
  deletion_window_in_days = 30
}
