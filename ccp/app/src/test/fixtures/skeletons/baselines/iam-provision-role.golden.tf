# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Over-broad trust or permissions are engineer-authored: the trust policy (assume_role_policy) and any managed-policy attachment beyond the read-only allowlist are written and reviewed by an engineer, never captured on this form.
# TODO: This role is provisioned with NO permissions and NO inline policy. Attach a least-privilege AWS-managed policy as a separate reviewed step; an inline policy is out of self-service reach.
# TODO: Confirm a permissions boundary is set when the role can be assumed broadly; the engineer adds it during review to cap the maximum privilege.

resource "aws_iam_role" "app_read_role" {
  # TODO: assume_role_policy — engineer decides
  name = "app-read-role"
  max_session_duration = 3600
  description = "Read-only role assumed by the reporting job"
  tags = {
    Description = "Reporting read-only role"
    PIC = "Ops team"
  }
}
