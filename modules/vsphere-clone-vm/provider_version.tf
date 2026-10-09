# sub-module needs provider declaration, because we use vsphere aliases
# infoblox and vsphere providers both required
terraform {
  required_version = ">= 1.0.0, < 2.0.0"
  required_providers {
    vsphere = {
      source  = "hashicorp/vsphere"
         }
    infoblox = {
      source = "infobloxopen/infoblox"
    }
  }
}
