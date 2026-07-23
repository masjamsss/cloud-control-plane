# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Registering servers into this group happens in the console today — the estate does not manage registrations in Terraform
# TODO: Wire it into a listener with the add-a-listener-rule action after creation

resource "aws_lb_target_group" "api_v2_blue" {
  name = "api-v2-blue"
  protocol = "HTTPS"
  port = 443
  vpc_id = aws_vpc.prod_sample.id
  target_type = "instance"
  deregistration_delay = 300
  tags = {
    Name = "api-v2-blue"
    Description = "Blue target group for the api-v2 cutover"
    PIC = "Ops team"
  }
  health_check {
    path = "/health"
    healthy_threshold = 3
    unhealthy_threshold = 3
    interval = 30
    matcher = "200-399"
  }
}
