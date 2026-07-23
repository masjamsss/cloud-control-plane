resource "aws_instance" "tabs" {
	instance_type	=	"r6i.xlarge"
	tags = {
		Name = "tab-indented"
	}
}
resource "aws_instance" "four_space" {
    instance_type = "m6i.large"
    root_block_device {
        volume_size = 100
        throughput  = 125
    }
}
  resource "aws_s3_bucket" "indented_top_level" {
    bucket = "legal-but-indented"
  }
resource "aws_instance" "oneliner" { instance_type = "c6i.large" }
resource "aws_instance" "no_gap_above" {
  instance_type   =     "r6i.2xlarge"
  ebs_block_device {
    device_name = "/dev/sdf"
    tags = {
      deep = {
      }
    }
  }
} # trailing comment on the closing line
resource "aws_ebs_volume" "trailing_ws" {
  size = 100
  type = "gp3"
}
