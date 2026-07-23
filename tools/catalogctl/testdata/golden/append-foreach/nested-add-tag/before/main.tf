resource "aws_instance" "app" {
  ami           = "ami-0abc123"
  instance_type = "t3.micro"

  root_block_device {
    volume_size = 20
    volume_type = "gp3"

    tags = {
      Name = "app-root"
      Role = "data"
    }
  }

  tags = {
    Name = "app"
  }
}
