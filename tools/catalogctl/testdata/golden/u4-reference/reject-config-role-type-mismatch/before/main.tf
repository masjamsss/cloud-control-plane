resource "aws_kms_key" "trail" {
  description = "cloudtrail encryption"
}

resource "aws_config_configuration_recorder" "main" {
  name = "default"
}
