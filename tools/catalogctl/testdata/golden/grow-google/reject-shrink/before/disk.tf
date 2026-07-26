resource "google_compute_disk" "data02" {
  name = "data02"
  type = "pd-ssd"
  zone = "us-central1-a"
  size = 512

  labels = {
    owner = "platform"
  }
}
