# Networking core — one VPC, three subnets across two AZs, NAT egress.

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support    = true

  tags = {
    Name        = "APP01_NewInstall-vpc"
    Environment = "prod"
    Owner       = "alice"
    PIC         = "user01@example.com"
  }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block               = "10.0.0.0/24"
  availability_zone        = "us-east-1a"
  map_public_ip_on_launch  = true

  tags = {
    Name        = "public-a"
    Environment = "prod"
    Tier        = "public"
    PIC         = "user01@example.com"
  }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block               = "10.0.1.0/24"
  availability_zone        = "us-east-1b"
  map_public_ip_on_launch  = true

  tags = {
    Name        = "public-b"
    Environment = "prod"
    Tier        = "public"
    PIC         = "user01@example.com"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block               = "10.0.10.0/24"
  availability_zone        = "us-east-1a"
  map_public_ip_on_launch  = false

  tags = {
    Name        = "private-a"
    Environment = "prod"
    Tier        = "private"
    PIC         = "user02@example.com"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "APP01_NewInstall-igw"
    PIC  = "user01@example.com"
  }
}

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "APP01_NewInstall-nat-eip"
    PIC  = "user01@example.com"
  }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_a.id

  tags = {
    Name = "APP01_NewInstall-nat"
    PIC  = "user01@example.com"
  }

  depends_on = [aws_internet_gateway.main]
}
