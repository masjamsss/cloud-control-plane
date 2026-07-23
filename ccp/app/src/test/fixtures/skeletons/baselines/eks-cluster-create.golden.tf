# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Add-ons (VPC CNI, CoreDNS, kube-proxy, EBS/EFS CSI drivers) are installed as an engineer follow-up after creation
# TODO: Encryption of Kubernetes secrets with a customer-managed KMS key (encryption_config) is an engineer decision
# TODO: Fine-grained access entries beyond the bootstrap admin grant are configured after the cluster exists

resource "aws_eks_cluster" "platform_eks" {
  name = "platform-eks"
  version = "1.32"
  role_arn = aws_iam_role.application_migration.arn
  enabled_cluster_log_types = ["api", "audit"]
  tags = {
    Name = "PLATFORM-EKS"
    Description = "Shared EKS cluster for platform workloads"
    PIC = "Ops team"
  }
  vpc_config {
    subnet_ids = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
    endpoint_private_access = true
    endpoint_public_access = false
  }
  access_config {
    authentication_mode = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }
}
