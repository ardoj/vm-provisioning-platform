
variable "vm_name" {
  description = "VM name (without domain suffix)"
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

variable "vm_domain" {
  description = "vm domain"
  type        = string
}

variable "datacenter" {
  description = "vm domain"
  type        = string
  default     = "DC1"
}

variable "cluster" {
  description = "vSphere compute cluster"
  type        = string
  default     = "dc1-clu01"
}

variable "folder" {
  description = "vSphere folder"
  type        = string
  default     = "Linux"
}

variable "datastore_cluster" {
  description = "vSphere datastore cluster"
  type        = string
  default     = "dc1-clu01-ssd"
}

variable "cpu" {
  description = "vm vCPU number"
  type        = number
  default     = 2
}

variable "mem" {
  description = "vm RAM memory (GB)"
  type        = number
  default     = 2
}

variable "vm_template" {
  description = "vSphere vm template image"
  type        = string
  default     = "dc1_ubuntu2404_template"
}

variable "vm_network1" {
  description = "vm interface 1 network (vSphere portgroup)"
  type        = string
  default     = "vlan-100-prod"
}

variable "vm_network2" {
  description = "vm interface 2 network (vSphere portgroup)"
  type        = string
  default     = ""
}

variable "vm_network3" {
  description = "vm interface 3 network (vSphere portgroup)"
  type        = string
  default     = ""
}

variable "gateway" {
  description = "Gateway address for vm_network1"
  type        = string
  default     = ""
}

variable "dns_server_list" {
  description = "List of DNS servers"
  type        = list(string)
  default     = ["198.51.100.53","192.0.2.53"]
}

variable "dns_suffix_list" {
  description = "List of DNS servers"
  type        = list(string)
  default     = ["example.internal"]
}

variable "disks" {
  description = "List of disks for vm"
  type        = list(number)
  default     = [20,5,5]
}

variable "tags" {
  description = "List of vSphere tags for vm"
  type        = list(string)
  default     = ["nobackup"]
}

variable "nic1_ipv4_cidr" {
  description = "IP address cidr for NIC 1"
  type        = string
}

variable "dns_name_nic2" {
  description = "DNS A record for 2nd NIC (for example example.internal)"
  type        = string
  default     = null
}

variable "nic2_ipv4_cidr" {
  description = "IP address cidr for NIC 2 - dns_name_nic2 will get IP from this cidr - also must correspond to vm_network2"
  type        = string
  default     = null
}

variable "dns_name_nic3" {
  description = "DNS A record for 3nd NIC (for example example.internal)"
  type        = string
  default     = null
}

variable "nic3_ipv4_cidr" {
  description = "IP address cidr for NIC 3 - dns_name_nic3 will get IP from this cidr - also must correspond to vm_network3"
  type        = string
  default     = null
}


# these declarations are needed in the root module even when unused

variable "CI_TF_VSPHERE_USER" {
  description = "vSphere username"
  type        = string
  default     = ""
}

variable "CI_TF_VSPHERE_PASSWORD" {
  description = "vSphere password"
  type        = string
  sensitive   = true
  default     = ""
}

variable "CI_TF_VSPHERE_USER_DC2" {
  description = "DC2 vSphere username"
  type        = string
  default     = ""
}

variable "CI_TF_VSPHERE_PASSWORD_DC2" {
  description = "DC2 vSphere password"
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
