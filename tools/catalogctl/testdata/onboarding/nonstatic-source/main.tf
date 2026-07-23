variable "mod_src" {
  type = string
}

module "m" {
  source = var.mod_src
}
