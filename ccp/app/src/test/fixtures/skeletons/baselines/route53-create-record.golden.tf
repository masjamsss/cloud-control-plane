# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A record change becomes live once it propagates (TTL-bound) and can silently redirect traffic to the wrong place — verify the value carefully before submitting
# TODO: For a routine A/AAAA/CNAME/TXT addition to an established zone, the existing self-service add-a-record action stays the faster path; use this form when a full engineer-reviewed draft is wanted instead
# TODO: Alias records and non-simple routing policies (weighted, latency, failover, geolocation, geoproximity) are engineer decisions — use the existing add-alias-record action or the dedicated set-* actions after creation

resource "aws_route53_record" "api_internal" {
  zone_id = aws_route53_zone.internal.zone_id
  name = "api.internal.example.com"
  type = "A"
  records = ["10.1.12.10"]
  ttl = 300
}
