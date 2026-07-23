terraform {
  required_version = ">= 1.15.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "example-onboarding-logs"
}

resource "aws_kms_key" "primary" {
  description = "primary CMK"
}
