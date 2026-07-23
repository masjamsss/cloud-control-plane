# CDN in front of the static assets bucket.

resource "aws_cloudfront_distribution" "cdn" {
  enabled         = true
  price_class     = "PriceClass_100"
  comment         = "Static assets for the checkout app"
  is_ipv6_enabled = true

  origin {
    domain_name = aws_s3_bucket.app_data.bucket_regional_domain_name
    origin_id   = "app-data-origin"

    s3_origin_config {
      origin_access_identity = ""
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods          = ["GET", "HEAD"]
    target_origin_id        = "app-data-origin"
    viewer_protocol_policy  = "redirect-to-https"
    compress                = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name = "app-cdn"
    PIC  = "user01@example.com"
  }
}
