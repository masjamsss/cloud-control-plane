# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The pod label selector narrowing this profile beyond the whole namespace is an engineer decision
# TODO: Additional selectors (multiple namespace/label pairs) beyond the one authored here are an engineer follow-up

resource "aws_eks_fargate_profile" "batch_jobs_fp" {
  # TODO: labels — engineer decides
  fargate_profile_name = "batch-jobs-fp"
  cluster_name = aws_eks_cluster.platform_eks.name
  pod_execution_role_arn = aws_iam_role.application_migration.arn
  subnet_ids = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
  tags = {
    Name = "BATCH-JOBS-FP"
    Description = "Fargate profile for the batch-jobs namespace"
    PIC = "Ops team"
  }
  selector {
    namespace = "batch-jobs"
  }
}
