# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Config records with the selected role: confirm the role grants read access to every resource type in scope, since a narrower role silently skips resources from compliance evaluation.
# TODO: Disabling or narrowing the recorder blinds compliance detection across the account; scope changes are engineer-reviewed, never self-service.

resource "aws_config_configuration_recorder" "default_recorder" {
  name = "default-recorder"
  role_arn = aws_iam_role.application_migration.arn
  recording_group {
    all_supported = true
    include_global_resource_types = true
  }
}
