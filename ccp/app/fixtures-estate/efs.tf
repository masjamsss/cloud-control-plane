# A shared file system for the app tier.

resource "aws_efs_file_system" "shared" {
  creation_token   = "app-shared-fs"
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
  encrypted        = true
  kms_key_id       = aws_kms_key.app_key.arn

  tags = {
    Name        = "app-shared-fs"
    PIC         = "user01@example.com"
    Description = "Shared file system for the app tier"
  }
}

# Deliberately no aws_efs_mount_target here: the app's "add a mount target"
# operation is this type's adoption path (see EMPTY_TYPES in
# inventoryEnums.test.ts) — the sample stays at zero so that demo flow has
# something to demonstrate.
