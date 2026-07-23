# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The REST API body (OpenAPI/Swagger definition), resources, methods and integrations are engineer decisions after creation — this form provisions the empty API container
# TODO: PRIVATE endpoint type additionally requires associating a VPC endpoint (vpc_endpoint_ids) and a resource policy — an engineer follow-up
# TODO: Deploying a stage (the API Gateway stage resource) is a required follow-up before this API serves any traffic — no stage is created here

resource "aws_api_gateway_rest_api" "orders_api" {
  name = "orders-api"
  description = "REST API fronting the orders service"
  disable_execute_api_endpoint = false
  tags = {
    Name = "ORDERS-API"
    Description = "REST API for the orders service"
    PIC = "Ops team"
  }
  endpoint_configuration {
    types = ["REGIONAL"]
  }
}
