# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Add a mount target in each zone after this share exists — one zone per request
# TODO: Pick the security group that lets clients reach NFS port 2049

resource "aws_efs_file_system" "interface_share" {
  # TODO: automatic backups are on for this share — author the aws_efs_backup_policy separately after it exists
  creation_token = "interface-share"
  performance_mode = "generalPurpose"
  throughput_mode = "bursting"
  encrypted = true
  tags = {
    Name = "interface-share"
    Description = "Shared interface file share"
    PIC = "Ops team"
  }
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
}
