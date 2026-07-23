# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: EC2/SPOT instance sizing (instance_type, instance_role, launch template, allocation strategy) is an engineer decision — this form covers the common Fargate case
# TODO: Placement group and Spot bid percentage are engineer follow-ups when the EC2/SPOT compute type is chosen

resource "aws_batch_compute_environment" "batch_fargate_env" {
  name = "batch-fargate-env"
  type = "MANAGED"
  state = "ENABLED"
  tags = {
    Name = "BATCH-FARGATE-ENV"
    Description = "Fargate compute environment for nightly batch jobs"
    PIC = "Ops team"
  }
  compute_resources {
    type = "FARGATE"
    max_vcpus = 16
    subnets = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
  }
}
