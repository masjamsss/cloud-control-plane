# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The vault access policy (IAM JSON) is authored and reviewed by an engineer, never captured from this form.
# TODO: Vault Lock (aws_glacier_vault_lock, a one-way compliance policy) is a separate, deliberate engineer follow-up — never enabled by default.

resource "aws_glacier_vault" "compliance_archive" {
  # TODO: access_policy — engineer decides
  name = "compliance-archive"
  tags = {
    Name = "COMPLIANCE-ARCHIVE"
    Description = "Long-term compliance archive vault"
    PIC = "Ops team"
  }
  notification {
    events = ["ArchiveRetrievalCompleted"]
    sns_topic = aws_sns_topic.notify_cloud_team.arn
  }
}
