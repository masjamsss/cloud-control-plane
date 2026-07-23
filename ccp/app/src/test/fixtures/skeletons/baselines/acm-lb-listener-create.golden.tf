# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Non-forward default actions (redirect, fixed response, authenticate-cognito/oidc, weighted or multi-target-group forwarding) are engineer decisions — use the request-a-change catch-all or the dedicated set operations after creation
# TODO: NLB protocols and mutual-TLS (mTLS) trust-store configuration are engineer decisions

resource "aws_lb_listener" "app_https" {
  load_balancer_arn = aws_lb.app.arn
  port = 443
  protocol = "HTTPS"
  certificate_arn = aws_acm_certificate.wildcard.arn
  ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  tags = {
    Name = "app-https"
    Description = "HTTPS listener for the app tier"
    PIC = "Ops team"
  }
  default_action {
    type = "forward"
    target_group_arn = aws_lb_target_group.app_default.arn
  }
}
