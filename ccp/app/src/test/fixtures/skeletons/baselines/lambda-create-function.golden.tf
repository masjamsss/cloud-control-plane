# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Code package (S3 or zip) — delivered by the engineer, never uploaded here
# TODO: The execution role and its permissions
# TODO: Trigger wiring — schedule, notification topic, or load balancer
# TODO: Environment variables are deliberately excluded here — they can carry secrets

resource "aws_lambda_function" "ticket_webhook" {
  function_name = "ticket-webhook"
  runtime = "python3.12"
  memory_size = 512
  timeout = 60
  tags = {
    Name = "ticket-webhook"
    Description = "Posts alarm tickets to the service desk"
    PIC = "Ops team"
  }
  vpc_config {
    subnet_ids = [aws_subnet.backup.id]
    security_group_ids = [aws_security_group.access_to_app01.id]
  }
}
