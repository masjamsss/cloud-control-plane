# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Routes, integrations and a deployed stage are engineer follow-ups — this form provisions the empty API container
# TODO: WEBSOCKET APIs additionally need route_selection_expression — an engineer decision (AWS defaults to $request.body.action when left unset)
# TODO: Full CORS tuning beyond allowed origins (headers, methods, credentials, max age) is an engineer decision after creation

resource "aws_apigatewayv2_api" "orders_http_api" {
  name = "orders-http-api"
  protocol_type = "HTTP"
  description = "HTTP API fronting the orders service"
  tags = {
    Name = "ORDERS-HTTP-API"
    Description = "HTTP API for the orders service"
    PIC = "Ops team"
  }
  cors_configuration {
    allow_origins = ["https://app.example.com"]
  }
}
