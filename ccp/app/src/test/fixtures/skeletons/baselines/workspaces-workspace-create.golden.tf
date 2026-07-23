# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The volume_encryption_key (a non-default KMS key for the encrypted volumes) is an engineer decision
# TODO: IP access control groups and custom WorkSpaces Web settings are engineer follow-ups after creation
# TODO: Registering the directory itself (aws_workspaces_directory), including its VPC/subnet placement, happens before this form is used — this form only assigns a desktop inside an existing directory

resource "aws_workspaces_workspace" "jdoe_desktop" {
  # TODO: bundle_id — engineer decides
  directory_id = aws_workspaces_directory.corp_directory.id
  user_name = "jdoe"
  root_volume_encryption_enabled = true
  user_volume_encryption_enabled = true
  tags = {
    Name = "jdoe-desktop"
    Description = "Cloud desktop for the finance analyst"
    PIC = "Ops team"
  }
  workspace_properties {
    running_mode = "AUTO_STOP"
  }
}
