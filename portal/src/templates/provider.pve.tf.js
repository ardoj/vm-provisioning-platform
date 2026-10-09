// src/templates/provider.pve.tf.js
// provider.tf for Proxmox VE server folders (mirrors servers/example.internal).
// Credentials come from TF_VAR_CI_TF_PVE_* GitLab CI variables.

export const providerTfPve = `terraform {
  required_version = ">= 1.0"
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.101"
    }
    infoblox = {
      source  = "infobloxopen/infoblox"
      version = "2.7.0"
    }
  }

  backend "http" {
    # GitLab holds the state
  }
}

provider "proxmox" {
  endpoint  = var.CI_TF_PVE_ENDPOINT
  api_token = var.CI_TF_PVE_API_TOKEN
  insecure  = true

  ssh {
    agent       = false
    username    = "root"
    private_key = var.CI_TF_PVE_SSH_PRIVATE_KEY
  }
}

provider "infoblox" {
  username = var.CI_TF_INFOBLOX_USERNAME
  password = var.CI_TF_INFOBLOX_PASSWORD
  server   = "ipam.example.internal"
}
`;
