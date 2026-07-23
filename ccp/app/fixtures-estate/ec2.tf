# Two application instances behind the load balancer; one admin key pair.

resource "aws_key_pair" "admin" {
  key_name   = "admin-key"
  public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYMATERIALNOTREALZZZZZZZZZZZZZZ admin@example.com"

  tags = {
    Name = "admin-key"
    PIC  = "user01@example.com"
  }
}

resource "aws_instance" "app01" {
  ami                    = "ami-0abcd1234efgh5678"
  instance_type          = "t3.large"
  subnet_id              = aws_subnet.private_a.id
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = "app-instance-profile"
  ebs_optimized          = true

  root_block_device {
    volume_size = 50
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name        = "APP01_NewInstall"
    Environment = "prod"
    Owner       = "alice"
    PIC         = "user01@example.com"
    Description = "Application server for the checkout service"
  }
}

resource "aws_instance" "app02" {
  ami                    = "ami-0abcd1234efgh5678"
  instance_type          = "t3.large"
  subnet_id              = aws_subnet.private_a.id
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = "app-instance-profile"
  ebs_optimized          = true

  root_block_device {
    volume_size = 50
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name        = "APP02_NewInstall"
    Environment = "prod"
    Owner       = "bob"
    PIC         = "user02@example.com"
    Description = "Application server for the checkout service"
  }
}

resource "aws_instance" "bastion" {
  ami                    = "ami-0abcd1234efgh5678"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.public_a.id
  private_ip             = "10.0.0.10"
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.app.id]
  ebs_optimized          = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name        = "bastion"
    Environment = "prod"
    Owner       = "alice"
    PIC         = "user01@example.com"
    Description = "Jump host for administrative access"
  }
}
