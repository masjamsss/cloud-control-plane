# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The directory administrator password is never captured here; an engineer sets it out of band, so no credential ever passes through the portal. This form provisions the directory shell and its network placement only.
# TODO: Confirm the two subnets are in different availability zones in the selected VPC; a directory needs multi-AZ placement to be highly available.

resource "aws_directory_service_directory" "corp_example_com" {
  # TODO: password — engineer decides
  name = "corp.example.com"
  type = "MicrosoftAD"
  edition = "Standard"
  size = "Small"
  tags = {
    Description = "Corp directory"
    PIC = "Ops team"
  }
  vpc_settings {
    vpc_id = aws_vpc.prod_sample.id
    subnet_ids = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
  }
}
