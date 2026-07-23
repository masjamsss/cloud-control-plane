# One internet-facing ALB, one target group, one HTTPS listener.

resource "aws_lb" "app" {
  name               = "app-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.app.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]

  tags = {
    Name = "app-alb"
    PIC  = "user01@example.com"
  }
}

resource "aws_lb_target_group" "app" {
  name        = "app-tg"
  port        = 443
  protocol    = "HTTPS"
  target_type = "instance"
  vpc_id      = aws_vpc.main.id

  health_check {
    path     = "/health"
    protocol = "HTTPS"
  }

  tags = {
    Name = "app-tg"
    PIC  = "user01@example.com"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.wildcard.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# A legacy listener still on the 2016 TLS policy — demonstrates the
# one-direction "acm-lb-listener-set-tls-policy" modernization operation.
resource "aws_lb_listener" "https_legacy" {
  load_balancer_arn = aws_lb.app.arn
  port              = 8443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-2016-08"
  certificate_arn   = aws_acm_certificate.wildcard.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_target_group_attachment" "app01" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app01.id
  port             = 443
}

resource "aws_lb_target_group_attachment" "app02" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app02.id
  port             = 443
}
