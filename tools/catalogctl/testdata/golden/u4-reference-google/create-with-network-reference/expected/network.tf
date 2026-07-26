resource "google_compute_subnetwork" "appsubnet01" {
  name = "appsubnet01"
  region = "us-central1"
  network = google_compute_network.main.id
}
