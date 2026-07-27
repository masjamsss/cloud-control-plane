resource "google_compute_instance" "app01" {
  name         = "app01"
  machine_type = "e2-standard-4"
  zone         = "us-central1-a"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
    }
  }

  network_interface {
    network = "default"
  }

  labels = {
    owner = "platform"
  }
}
