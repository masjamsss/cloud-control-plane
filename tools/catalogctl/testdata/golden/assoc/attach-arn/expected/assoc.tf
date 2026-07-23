resource "aws_lb_listener" "web" {
  port            = 443
  certificate_arn = "arn:aws:acm:ap-southeast-5:123456789012:certificate/new"
}
