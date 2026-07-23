# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Attaching a VPC to a transit gateway can expose it to every other VPC or on-prem network already attached, depending on the transit gateway's route table associations — confirm the target route table policy before attaching, especially on a shared hub
# TODO: Appliance mode (for symmetric routing through a firewall/appliance VPC) and IPv6 support are engineer decisions
# TODO: Transit gateway route table associations/propagations beyond the gateway's own default are engineer decisions (the transit gateway's own route table actions)

resource "aws_ec2_transit_gateway_vpc_attachment" "app_tier_tgw_attachment" {
  transit_gateway_id = aws_ec2_transit_gateway.core.id
  vpc_id = aws_vpc.prod_sample.id
  subnet_ids = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
  dns_support = "enable"
  tags = {
    Name = "APP-TIER-TGW-ATTACHMENT"
    Description = "Attaches the app-tier VPC to the core transit gateway"
    PIC = "Ops team"
  }
}
