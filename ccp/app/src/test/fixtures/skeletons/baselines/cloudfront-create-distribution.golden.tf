# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Cache policy choice (AWS-managed or custom) depends on the origin's content type
# TODO: Additional ordered cache behaviors for extra path patterns are an engineer decision after creation
# TODO: Multiple origins, origin groups (failover), and origin access control for private S3 origins are engineer decisions
# TODO: Custom error responses, access/connection logging, and geo-restriction beyond none are engineer follow-ups
# TODO: Field-level encryption, real-time logs, and function associations (Lambda@Edge, CloudFront Functions) are engineer decisions

resource "aws_cloudfront_distribution" "checkout_static" {
  # TODO: cache_policy_id — engineer decides
  comment = "Static assets for the checkout app"
  enabled = true
  tags = {
    Name = "checkout-static"
    Description = "CDN for the checkout app static assets"
    PIC = "Ops team"
  }
  origin {
    domain_name = "assets.checkout.example.com"
    origin_id = "primary-origin"
    custom_origin_config {
      origin_protocol_policy = "https-only"
      http_port = 80
      https_port = 443
      origin_ssl_protocols = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    target_origin_id = "primary-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods = ["GET", "HEAD"]
    cached_methods = ["GET", "HEAD"]
    compress = true
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
