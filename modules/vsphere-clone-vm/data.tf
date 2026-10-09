data "vsphere_datacenter" "dc" {
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }
  #for_each = { for vm in var.virtual_machines : vm.name => vm }
  name     = each.value.vm_parameters.datacenter
}

#data "vsphere_datastore" "datastore" {
#  #for_each     = { for vm in var.virtual_machines : vm.name => vm }
#  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }
#  name         = each.value.vm_parameters.datastore
#  datacenter_id = data.vsphere_datacenter.dc[each.key].id
#}

data "vsphere_datastore_cluster" "datastore_cluster" {
  #for_each     = { for vm in var.virtual_machines : vm.name => vm }
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }
  name         = each.value.vm_parameters.datastore_cluster
  datacenter_id = data.vsphere_datacenter.dc[each.key].id
}

data "vsphere_compute_cluster" "compute_cluster" {
  #for_each     = { for vm in var.virtual_machines : vm.name => vm }
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }
  name         = each.value.vm_parameters.cluster
  datacenter_id = data.vsphere_datacenter.dc[each.key].id
}

data "vsphere_network" "network1" {
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm if vm.vm_parameters.vm_network1 != "" }
  #for_each     = { for vm in var.virtual_machines : vm.name => vm if vm.vm_network1 != "" }
  name         = "/${each.value.vm_parameters.datacenter}/network/${each.value.vm_parameters.vm_network1}"
  #name         = "/${each.value.datacenter}/network/${each.value.vm_network1}"
  datacenter_id = data.vsphere_datacenter.dc[each.key].id
}

data "vsphere_network" "network2" {
  #for_each     = { for vm in var.virtual_machines : vm.name => vm if vm.vm_network2 != "" }
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm if vm.vm_parameters.vm_network2 != "" }
  name         = "/${each.value.vm_parameters.datacenter}/network/${each.value.vm_parameters.vm_network2}"
  #name         = "/${each.value.datacenter}/network/${each.value.vm_network2}"
  datacenter_id = data.vsphere_datacenter.dc[each.key].id
}

data "vsphere_network" "network3" {
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm if vm.vm_parameters.vm_network3 != "" }
  #for_each     = { for vm in var.virtual_machines : vm.name => vm if vm.vm_network3 != "" }
  name         = "/${each.value.vm_parameters.datacenter}/network/${each.value.vm_parameters.vm_network3}"
  #name         = "/${each.value.datacenter}/network/${each.value.vm_network3}"
  datacenter_id = data.vsphere_datacenter.dc[each.key].id
}

data "vsphere_virtual_machine" "template" {
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }
  #for_each     = { for vm in var.virtual_machines : vm.name => vm }
  name         = each.value.vm_parameters.vm_template
  datacenter_id = data.vsphere_datacenter.dc[each.key].id
}

