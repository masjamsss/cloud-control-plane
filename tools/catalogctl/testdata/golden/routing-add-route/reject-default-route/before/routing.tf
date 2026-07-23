resource "aws_route_table" "private" {
  vpc_id = "vpc-0abc12345678"

  route {
    cidr_block = "10.2.0.0/16"
    gateway_id = "igw-0abc12345678"
  }
}
