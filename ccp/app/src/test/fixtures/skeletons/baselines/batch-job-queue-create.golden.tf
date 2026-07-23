# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A multi-environment fallback order (e.g. Fargate then Fargate Spot) beyond the single environment authored here is an engineer follow-up
# TODO: A fair-share scheduling policy (scheduling_policy_arn) is an engineer decision — this form uses the default FIFO queue behavior

resource "aws_batch_job_queue" "batch_default_queue" {
  name = "batch-default-queue"
  priority = 1
  state = "ENABLED"
  tags = {
    Name = "BATCH-DEFAULT-QUEUE"
    Description = "Default job queue for nightly batch jobs"
    PIC = "Ops team"
  }
  compute_environment_order {
    compute_environment = aws_batch_compute_environment.batch_fargate_env.arn
    order = 1
  }
}
