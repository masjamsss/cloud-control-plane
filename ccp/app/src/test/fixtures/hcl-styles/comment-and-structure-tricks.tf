# A commented-out block must not count:
# resource "fake" "commented" {
#   nope = true
# }

/*
A block comment containing a full fake block at column 0:
resource "fake" "in_comment" {
  also = "nope"
}
And an unbalanced brace: {
*/

variable "env" {
  type    = string
  default = "prod"
}

resource "aws_instance" "real_one" { // trailing line comment style
  instance_type = "r6i.xlarge"       # hash comment with { brace
}

data "aws_ami" "lookalike" {
  most_recent = true
}

locals {
  brace_string = "{"
}

resource "aws_s3_bucket" "kebab-and_mix3d" {
  bucket = "labels-with-dashes-underscores-digits"
}

module "not_a_resource" {
  source = "./modules/thing"
}

terraform {
  required_version = ">= 1.10"
}

resource "aws_instance" "final" {
  instance_type = "t3.medium"
}
