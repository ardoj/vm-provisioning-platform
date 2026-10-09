variable "virtual_machines" {
  type = map(object({
    vm_parameters = object({
      name                    = string
      vm_domain               = string
      datacenter              = string
      cluster                 = string
      folder                  = string
      datastore_cluster       = string
      cpu                     = number
      cores_per_socket        = optional(number, 1)
      mem                     = number
      firmware                = optional(string, "efi")
      efi_secure_boot_enabled = optional(string, "true")
      cpu_hot_add_enabled     = optional(string, "true")
      cpu_hot_remove_enabled  = optional(string, "false") # vmware error, so disabled for now
      memory_hot_add_enabled  = optional(string, "true")
      vm_template             = string
      vm_network1             = string
      vm_network2             = string
      vm_network3             = string
      gateway                 = string
      dns_server_list         = list(string)
      dns_suffix_list         = list(string)
      disks                   = list(number)  # Replaces disk1, disk2, disk3 with a list
      tags                    = list(string)
    })
    ddi_host_records = list(object({
      fqdn                    = string
      ipv4_cidr               = string
      dns_view                = optional(string, "internalZones")
      network_view            = optional(string, "default")
    }))
  }))
}
