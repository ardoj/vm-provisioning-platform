// src/templates/variables.pve.tf.js
// variables.tf for Proxmox VE server folders (mirrors servers/example.internal,
// plus the satellite postconfig variables).

export const variablesTfPve = `
variable "vm_name" {
  description = "VM name (without domain suffix)"
  type        = string
}

variable "vm_domain" {
  description = "VM domain"
  type        = string
}

# Read by the CI postconfig stage (not by terraform) — assigned via the
# Satellite API after the VM self-registers. Leave empty on Ubuntu VMs.
variable "satellite_hostgroup" {
  description = "Satellite host group to assign (nested groups by title, e.g. Linux/Prod)"
  type        = string
  default     = ""
}

variable "satellite_host_collection" {
  description = "Satellite host collection to add the host to"
  type        = string
  default     = ""
}

variable "node_name" {
  description = "Proxmox node name to create the VM on"
  type        = string
}

variable "clone_vm_id" {
  description = "VMID of the Proxmox template to clone from"
  type        = number
}

variable "cpu" {
  description = "Number of vCPUs"
  type        = number
  default     = 2
}

variable "mem" {
  description = "RAM in GB"
  type        = number
  default     = 2
}

variable "vm_network1" {
  description = "Bridge or SDN vnet for NIC 1 (e.g. vmbr0 or vnet100)"
  type        = string
}

variable "vm_network1_vlan" {
  description = "VLAN ID for NIC 1 (null = untagged / SDN vnet carries the tag)"
  type        = number
  default     = null
}

variable "vm_network2" {
  description = "Bridge/vnet for NIC 2 (empty = no second NIC)"
  type        = string
  default     = ""
}

variable "vm_network2_vlan" {
  description = "VLAN ID for NIC 2"
  type        = number
  default     = null
}

variable "vm_network3" {
  description = "Bridge/vnet for NIC 3 (empty = no third NIC)"
  type        = string
  default     = ""
}

variable "vm_network3_vlan" {
  description = "VLAN ID for NIC 3"
  type        = number
  default     = null
}

variable "gateway" {
  description = "Default gateway for NIC 1"
  type        = string
  default     = ""
}

variable "dns_server_list" {
  description = "List of DNS servers"
  type        = list(string)
  default     = ["192.0.2.53"]
}

variable "disks" {
  description = "List of disks; first disk (scsi0) resizes the cloned template disk"
  type = list(object({
    size         = number
    datastore_id = string
  }))
  default = [{ size = 20, datastore_id = "local-lvm" }]
}

variable "tags" {
  description = "List of PVE tags (will be lowercased automatically)"
  type        = list(string)
  default     = ["nobackup"]
}

variable "snippets_datastore_id" {
  description = "PVE datastore with snippets content type enabled (for cloud-init user-data)"
  type        = string
  default     = "local"
}

variable "nic1_ipv4_cidr" {
  description = "Network CIDR for NIC 1 IP allocation from Infoblox (e.g. 10.0.0.0/24)"
  type        = string
}

variable "dns_name_nic2" {
  description = "DNS A record for NIC 2 (e.g. server-nic2.domain.tld)"
  type        = string
  default     = ""
}

variable "nic2_ipv4_cidr" {
  description = "Network CIDR for NIC 2 IP allocation"
  type        = string
  default     = ""
}

variable "dns_name_nic3" {
  description = "DNS A record for NIC 3"
  type        = string
  default     = ""
}

variable "nic3_ipv4_cidr" {
  description = "Network CIDR for NIC 3 IP allocation"
  type        = string
  default     = ""
}


# CI/CD injected secrets — declare even if not used by this server

variable "pve_cluster" {
  description = "PVE cluster key — matches PVE_ENDPOINTS in the portal and the PVE_CI_TOKEN_<key> / PVE_CI_SSH_KEY_<key> CI variables the pipeline selects credentials from. Must be [A-Za-z0-9_]."
  type        = string
  default     = "test"
}

variable "CI_TF_PVE_ENDPOINT" {
  description = "Proxmox API endpoint (e.g. https://pve.example.internal:8006/)"
  type        = string
  default     = "https://pve-test01.example.internal:8006/"
}

variable "CI_TF_PVE_API_TOKEN" {
  description = "Proxmox API token (user@realm!tokenid=secret)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "CI_TF_PVE_SSH_PRIVATE_KEY" {
  description = "SSH private key for uploading snippets to PVE node (PEM format)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "CI_TF_INFOBLOX_USERNAME" {
  description = "Infoblox username"
  type        = string
  default     = ""
}

variable "CI_TF_INFOBLOX_PASSWORD" {
  description = "Infoblox password"
  type        = string
  sensitive   = true
  default     = ""
}

variable "CI_TF_VAULT_TOKEN" {
  description = "Vault token for storing the generated root password"
  type        = string
  sensitive   = true
  default     = ""
}
`;
