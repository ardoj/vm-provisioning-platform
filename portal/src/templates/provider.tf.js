// src/templates/provider.tf.js
// Both vsphere.dc1 and vsphere.dc2 aliases must be defined here.

export const providerTf = `
terraform {
  required_version = ">= 1.0"
  required_providers {
    vsphere = {
      source  = "hashicorp/vsphere"
      version = "2.10.0"
    }
    infoblox = {
      source = "infobloxopen/infoblox"
      version = "2.7.0"
    }
  }

  backend "http" {
    # GitLab holds the state
  }
}

provider "infoblox" {
    username           = var.CI_TF_INFOBLOX_USERNAME
    password           = var.CI_TF_INFOBLOX_PASSWORD
    server             = "ipam.example.internal"
}

provider "vsphere" {
  alias                = "dc2"
  user                 = var.CI_TF_VSPHERE_USER
  password             = var.CI_TF_VSPHERE_PASSWORD
  vsphere_server       = "vcenter-dc2.example.internal"
  allow_unverified_ssl = true
}

provider "vsphere" {
  alias                = "dc1"
  user                 = var.CI_TF_VSPHERE_USER
  password             = var.CI_TF_VSPHERE_PASSWORD
  #user                 = var.CI_TF_VSPHERE_USER_DC2
  #password             = var.CI_TF_VSPHERE_PASSWORD_DC2
  vsphere_server       = "vcenter-dc1.example.internal"
  allow_unverified_ssl = true
}
`;
