module "dc1-server" {
  source = "../../../modules/vsphere-clone-vm"   # portal-generated folders use the registry + a pinned version
  providers = {
    vsphere = vsphere.dc1
  }
  virtual_machines = {
    vm01 = {
      vm_parameters = {
        name              = var.vm_name
        vm_domain         = var.vm_domain
        datacenter        = var.datacenter
        cluster           = var.cluster
        folder            = var.folder
        datastore_cluster = var.datastore_cluster
        cpu               = var.cpu
        mem               = var.mem
        vm_template       = var.vm_template
        vm_network1       = var.vm_network1
        vm_network2       = var.vm_network2
        vm_network3       = var.vm_network3
        gateway           = var.gateway
        dns_server_list   = var.dns_server_list
        dns_suffix_list   = ["${var.vm_domain}"]
        disks             = var.disks
        tags              = var.tags
      }
      ddi_host_records = [
        {
          fqdn      = "${var.vm_name}.${var.vm_domain}"
          ipv4_cidr = var.nic1_ipv4_cidr
        },
        {
          fqdn      = "${var.dns_name_nic2}"
          ipv4_cidr = var.nic2_ipv4_cidr
        },
        {
          fqdn      = "${var.dns_name_nic3}"
          ipv4_cidr = var.nic3_ipv4_cidr
        }
      ]
    }
  }
}
