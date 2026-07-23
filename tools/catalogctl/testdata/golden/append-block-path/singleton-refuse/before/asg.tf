resource "aws_autoscaling_group" "erp" {
  name             = "erp-asg"
  max_size         = 3
  min_size         = 1
  desired_capacity = 2

  instance_refresh {
    strategy = "Rolling"

    preferences {
      min_healthy_percentage = 90
      instance_warmup        = 300
    }
  }
}
