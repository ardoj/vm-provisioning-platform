module "pve-server" {
  source = "../../../modules/proxmox-clone-vm"   # portal-generated folders use the registry + a pinned version

  virtual_machines = {

    vm01 = {
      vm_parameters = {
        name                           = var.vm_name
        vm_domain                      = var.vm_domain
        node_name                      = var.node_name
        clone_vm_id                    = var.clone_vm_id
        cpu                            = var.cpu
        mem                            = var.mem
        vm_network1                    = var.vm_network1
        vm_network1_vlan               = var.vm_network1_vlan
        vm_network2                    = var.vm_network2
        vm_network2_vlan               = var.vm_network2_vlan
        vm_network3                    = var.vm_network3
        vm_network3_vlan               = var.vm_network3_vlan
        gateway                        = var.gateway
        dns_server_list                = var.dns_server_list
        dns_suffix_list                = ["${var.vm_domain}"]
        disks                          = var.disks
        tags                           = var.tags
        snippets_datastore_id          = var.snippets_datastore_id
      }
      ddi_host_records = [
        # Interface 1
        {
          fqdn      = "${var.vm_name}.${var.vm_domain}"
          ipv4_cidr = var.nic1_ipv4_cidr
        },
        # Interface 2
        {
          fqdn      = var.dns_name_nic2
          ipv4_cidr = var.nic2_ipv4_cidr
        },
        # Interface 3
        {
          fqdn      = var.dns_name_nic3
          ipv4_cidr = var.nic3_ipv4_cidr
        }
      ]
    }

  }
}
