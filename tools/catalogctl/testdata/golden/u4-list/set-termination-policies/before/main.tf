resource "aws_autoscaling_group" "web" {
  name             = "web-asg"
  max_size         = 4
  min_size         = 1
  desired_capacity = 2
}
