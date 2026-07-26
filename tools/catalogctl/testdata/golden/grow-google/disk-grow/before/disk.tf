resource "google_compute_disk" "data01" {
  name = "data01"
  type = "pd-ssd"
  zone = "us-central1-a"
  size = 128

  labels = {
    owner = "platform"
  }
}
