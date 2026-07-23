# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The container spec (image, vCPUs, memory, command) is an engineer decision, matched to the workload's built image
# TODO: Multi-node parallel jobs (node_properties) and EKS jobs (eks_properties) are engineer decisions — this form covers the common single-container case
# TODO: Exit-code-based retry rules (evaluate_on_exit) beyond a flat attempt count are an engineer follow-up

resource "aws_batch_job_definition" "nightly_report_job" {
  # TODO: container_properties — engineer decides
  name = "nightly-report-job"
  type = "container"
  platform_capabilities = ["FARGATE"]
  tags = {
    Name = "NIGHTLY-REPORT-JOB"
    Description = "Generates the nightly finance report"
    PIC = "Ops team"
  }
  retry_strategy {
    attempts = 1
  }
  timeout {
    attempt_duration_seconds = 3600
  }
}
