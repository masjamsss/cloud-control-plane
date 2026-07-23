# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A customer-authored or write-capable policy is an engineer decision: this form offers only AWS-managed read-only, least-privilege policies. Anything broader is authored and reviewed by an engineer, never attached from self-service.
# TODO: Each attachment is additive to whatever the role already holds; confirm the combined permissions are still least-privilege for what the role does.

resource "aws_iam_role_policy_attachment" "app_read_attach" {
  role = aws_iam_role.application_migration.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
