resource "google_compute_network" "core" {
  name                    = "core-net"
  auto_create_subnetworks = false
}
