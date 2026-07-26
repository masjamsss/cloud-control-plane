resource "google_compute_network" "main" {
  name                    = "core-net"
  auto_create_subnetworks = false
}
