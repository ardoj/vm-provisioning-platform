terraform {
  required_version = ">= 1.0.0, < 2.0.0"
  required_providers {
    proxmox = {
      source = "bpg/proxmox"
    }
    infoblox = {
      source = "infobloxopen/infoblox"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}
