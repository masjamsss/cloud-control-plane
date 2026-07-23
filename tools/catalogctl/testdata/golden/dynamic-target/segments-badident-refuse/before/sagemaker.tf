resource "aws_sagemaker_domain" "bird" {
  domain_name = "bird-domain"
  auth_mode   = "IAM"
  vpc_id      = "vpc-0e9541d21c8e3b497"
  subnet_ids  = ["subnet-0246f0b264d038fb7"]

  default_user_settings {
    execution_role = "arn:aws:iam::123456789012:role/service-role/AmazonSageMaker-ExecutionRole-20221223T095946"

    jupyter_server_app_settings {
      default_resource_spec {
        instance_type       = "system"
        sagemaker_image_arn = "arn:aws:sagemaker:ap-southeast-5:276181064229:image/jupyter-server-3"
      }
    }
  }
}
