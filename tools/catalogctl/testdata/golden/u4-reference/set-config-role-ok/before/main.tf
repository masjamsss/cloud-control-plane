resource "aws_iam_role" "application_migration" {
  name = "application-migration"
}

resource "aws_config_configuration_recorder" "main" {
  name = "default"
}
