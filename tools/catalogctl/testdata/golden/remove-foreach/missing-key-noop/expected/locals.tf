locals {
  legacy_host_alarms = {
    web01   = "cpu-high"
    db01    = "mem-high"
    cache01 = "disk-high"
  }
}
