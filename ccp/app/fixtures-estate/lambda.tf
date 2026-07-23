# A small webhook handler function.

resource "aws_lambda_function" "webhook" {
  function_name = "ticket-webhook"
  # A literal ARN (not a same-root aws_iam_role reference): this role is
  # shared/managed outside this Terraform root, same convention the estate
  # capture this sample is modeled after uses.
  role          = "arn:aws:iam::123456789012:role/lambda-execution-role"
  handler       = "index.handler"
  runtime       = "python3.12"
  memory_size   = 256
  timeout       = 60
  filename      = "webhook.zip"

  tags = {
    Name        = "ticket-webhook"
    PIC         = "user02@example.com"
    Description = "Posts alarm tickets to the service desk"
  }
}
