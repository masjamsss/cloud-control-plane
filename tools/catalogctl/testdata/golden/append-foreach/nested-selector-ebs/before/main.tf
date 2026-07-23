resource "aws_instance" "app" {
  ami           = "ami-0abc123"
  instance_type = "t3.micro"

  ebs_block_device {
    device_name = "/dev/sdf"
    volume_size = 100

    tags = {
      Name = "data-1"
    }
  }

  ebs_block_device {
    device_name = "/dev/sdg"
    volume_size = 200

    tags = {
      Name = "data-2"
    }
  }
}
