resource "aws_lb_target_group" "app" {
  name     = "app-tg"
  port     = 443
  protocol = "HTTPS"
  vpc_id   = "vpc-0abc123"

  health_check {
    enabled             = true
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 3
    unhealthy_threshold = 3
  }

  tags = {
    Name = "app-tg"
    Team = "platform"
  }
}
