# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: authorization_type NONE makes this URL callable by anyone on the internet with no authentication — confirm that is genuinely intended before approving; AWS_IAM (the default here) is the safe starting point
# TODO: CORS configuration (the cors block: allowed origins/methods/headers) is an engineer follow-up if browser clients call this URL directly
# TODO: Pinning to a specific published version or alias (qualifier) instead of $LATEST is an engineer decision

resource "aws_lambda_function_url" "ticket_webhook_url" {
  function_name = aws_lambda_function.alarm_handler.function_name
  authorization_type = "AWS_IAM"
  invoke_mode = "BUFFERED"
}
