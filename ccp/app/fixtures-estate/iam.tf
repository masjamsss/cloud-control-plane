# Two roles (app instance profile role, lambda execution role) and three
# users — the users carry an AKIAEXAMPLE-shaped tag key each, mirroring the
# real estate's "the access key id rides as a tag key" convention (S-2) so
# the access-key-inventory UI stays demonstrable without a real credential.

resource "aws_iam_role" "app_role" {
  name = "app-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Name = "app-instance-role"
    PIC  = "user01@example.com"
  }
}

resource "aws_iam_instance_profile" "app_role" {
  name = "app-instance-profile"
  role = aws_iam_role.app_role.name
}

resource "aws_iam_role" "lambda_role" {
  name = "lambda-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Name = "lambda-execution-role"
    PIC  = "user02@example.com"
  }
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_user" "user01" {
  name = "user01"

  tags = {
    "AKIAEXAMPLE000000001" = "CI upload key for the data pipeline"
    PIC                     = "user01@example.com"
  }
}

resource "aws_iam_user" "user02" {
  name = "user02"

  tags = {
    "AKIAEXAMPLE000000002" = "Read-only monitoring integration"
    PIC                     = "user02@example.com"
  }
}

resource "aws_iam_user" "user03" {
  name = "user03"

  tags = {
    "AKIAEXAMPLE000000003" = "Backup automation service account"
    PIC                     = "user03@example.com"
  }
}
