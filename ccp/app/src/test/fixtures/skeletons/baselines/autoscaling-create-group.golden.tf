# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Launch template choice and validation (AMI, instance type, IAM profile)
# TODO: Attaching to a load balancer target group is a follow-up step
# TODO: Description and person-in-charge tags: add via the existing tag operation after creation — an Auto Scaling group's tags are a repeated block, not a map, so only the Name tag is seeded here
# TODO: Mixed instances policy, warm pool, and instance refresh settings are engineer decisions

resource "aws_autoscaling_group" "app_tier_asg" {
  # TODO: id — engineer decides
  name = "app-tier-asg"
  min_size = 2
  max_size = 6
  desired_capacity = 3
  vpc_zone_identifier = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
  health_check_type = "ELB"
  health_check_grace_period = 300
  launch_template {
    version = "$Latest"
  }
  tag {
    value = "APP-TIER-ASG"
    key = "Name"
    propagate_at_launch = true
  }
}
