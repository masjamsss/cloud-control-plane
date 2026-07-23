# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: This namespace is resolvable only from inside the chosen VPC (and any VPC peered or DNS-associated with it) — confirm that matches the intended reachability before registering services under it
# TODO: Services and instances registered under this namespace are engineer follow-ups — this form provisions the empty namespace

resource "aws_service_discovery_private_dns_namespace" "internal_svc" {
  name = "internal.svc"
  vpc = aws_vpc.prod_sample.id
  description = "Service discovery namespace for internal microservices"
  tags = {
    Name = "INTERNAL-SVC-NAMESPACE"
    Description = "Private DNS namespace for internal service discovery"
    PIC = "Ops team"
  }
}
