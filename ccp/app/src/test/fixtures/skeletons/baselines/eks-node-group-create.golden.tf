# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A custom launch template (for extra EBS volumes, user data, or a golden AMI) is an engineer decision
# TODO: Kubernetes labels and taints (beyond the AWS-managed defaults) are configured as an engineer follow-up
# TODO: Remote SSH access (remote_access) is off by default — an engineer decision if node-level shell access is required

resource "aws_eks_node_group" "platform_ng" {
  node_group_name = "platform-ng"
  cluster_name = aws_eks_cluster.platform_eks.name
  node_role_arn = aws_iam_role.application_migration.arn
  subnet_ids = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
  capacity_type = "ON_DEMAND"
  ami_type = "AL2023_x86_64_STANDARD"
  instance_types = ["t3.large"]
  disk_size = 50
  tags = {
    Name = "PLATFORM-NG"
    Description = "Worker nodes for the platform EKS cluster"
    PIC = "Ops team"
  }
  scaling_config {
    desired_size = 2
    min_size = 1
    max_size = 4
  }
}
