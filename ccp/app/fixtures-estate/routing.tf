# Route tables for the public and private subnet tiers.

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "public-rt"
    PIC  = "user01@example.com"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = {
    Name = "private-rt"
    PIC  = "user02@example.com"
  }
}

# Deliberately no aws_route_table_association resources here: this estate's
# convention (see EMPTY_TYPES in inventoryEnums.test.ts) is that associations
# exist in AWS but are not adopted into Terraform as their own resource type.
