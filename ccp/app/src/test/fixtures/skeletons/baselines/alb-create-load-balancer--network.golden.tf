# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: internal defaults to true (private, VPC-internal only); setting it false makes this load balancer internet-facing on the chosen subnets' public IPs — confirm that is intended and that those subnets are actually public before flipping it
# TODO: Listeners and target groups are separate follow-up steps (the existing create-a-listener and create-a-target-group actions) — a load balancer with neither serves no traffic
# TODO: Access/connection/health-check log destinations, WAF association, cross-zone load balancing and idle timeout keep their AWS defaults — tune them afterward with the existing set-* actions

resource "aws_lb" "app_v2_alb" {
  name = "app-v2-alb"
  load_balancer_type = "network"
  internal = true
  subnets = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
  enable_deletion_protection = true
  tags = {
    Name = "APP-V2-ALB"
    Description = "Internal load balancer for the app-v2 rollout"
    PIC = "Ops team"
  }
}
