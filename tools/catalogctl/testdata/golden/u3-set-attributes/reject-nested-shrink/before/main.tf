resource "aws_lb_target_group" "app" {
  name     = "app-tg"
  port     = 443
  protocol = "HTTPS"
  vpc_id   = "vpc-0abc123"

  health_check {
    enabled  = true
    path     = "/healthz"
    interval = 30
    timeout  = 5
  }

  tags = {
    Name = "app-tg"
  }
}
