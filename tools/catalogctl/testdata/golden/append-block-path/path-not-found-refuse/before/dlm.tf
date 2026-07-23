resource "aws_dlm_lifecycle_policy" "empty" {
  description        = "no policy_details yet"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"
}
