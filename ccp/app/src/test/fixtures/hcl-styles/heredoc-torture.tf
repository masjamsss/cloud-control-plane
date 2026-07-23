resource "aws_ssm_document" "brace_at_col0" {
  content = <<EOF
{
  "schemaVersion": "2.2"
}
EOF
}
resource "aws_ssm_document" "fake_resource_inside" {
  content = <<-EOT
resource "fake" "inside_heredoc" {
  this = "is data, not code"
}
  EOT
}
resource "aws_lambda_function" "two_heredocs" {
  description = "double trouble"
  environment_note = <<ONE
first heredoc {with braces}
ONE
  policy_note = <<TWO
{"second": {"heredoc": true}}
TWO
}
resource "aws_ssm_document" "terminator_substring" {
  content = <<EOF
EOFX is not the end
also not: EOF_MORE
EOF
}
resource "aws_instance" "recovered" {
  instance_type = "t3.small"
}
