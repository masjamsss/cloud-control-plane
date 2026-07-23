# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The instance profile is only as privileged as the role it carries; confirm the selected role is least-privilege for the instances that will assume it.

resource "aws_iam_instance_profile" "app_instance_profile" {
  name = "app-instance-profile"
  role = aws_iam_role.application_migration.name
  tags = {
    Description = "App instance profile"
    PIC = "Ops team"
  }
}
