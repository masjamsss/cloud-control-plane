resource "aws_instance" "braces_in_strings" {
  user_data = "echo '{\"json\": {\"nested\": true}}' > /tmp/x"
  tags = {
    Name    = "prefix-${lookup(var.names, "key")}-suffix"
    Ternary = "${var.env == "" ? "empty" : "set"}"
    Escaped = "not $${interpolated} and not %%{directive}"
    Quote   = "she said \"hello {world}\" loudly"
    Decoy   = "resource \"fake\" \"decoy\" {"
  }
}
resource "aws_iam_policy" "json_braces" {
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "arn:aws:s3:::bucket/${var.prefix}/*"
    }]
  })
}
resource "aws_instance" "directives" {
  user_data = "%{ if var.gpu }gpu-init%{ else }cpu-init%{ endif } --flag=${join(",", var.flags)}"
}
resource "aws_instance" "after_hell" {
  instance_type = "t3.micro"
}
