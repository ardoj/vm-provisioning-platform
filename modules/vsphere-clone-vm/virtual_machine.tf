
resource "infoblox_ip_allocation" "allocation" {
  for_each = local.flattened_records

  fqdn         = each.value.fqdn
  ipv4_cidr    = each.value.ipv4_cidr
  dns_view     = try(each.value.dns_view, "internalZones")
  network_view = try(each.value.network_view, "default")
}


data "infoblox_host_record" "dns_record_ip" {
  for_each = local.flattened_records

  filters = {
    name = each.value.fqdn
  }
  depends_on = [infoblox_ip_allocation.allocation] 
}

# generate new root pass for every vm
resource "random_password" "root_password" {
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }
  length      = 14
  min_lower   = 9
  min_numeric = 2
  min_upper   = 2
  min_special = 1
  special = true
  override_special = "!#.-_+:"
}

resource "vsphere_virtual_machine" "virtual_machine_clone" {
  for_each                = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }

  name                    = "${each.value.vm_parameters.name}.${each.value.vm_parameters.vm_domain}"
  resource_pool_id        = data.vsphere_compute_cluster.compute_cluster[each.key].resource_pool_id
  datastore_cluster_id    = data.vsphere_datastore_cluster.datastore_cluster[each.key].id
  num_cores_per_socket    = each.value.vm_parameters.cores_per_socket
  num_cpus                = each.value.vm_parameters.cpu
  memory                  = each.value.vm_parameters.mem * 1024
  firmware                = each.value.vm_parameters.firmware
  efi_secure_boot_enabled = each.value.vm_parameters.efi_secure_boot_enabled
  cpu_hot_add_enabled     = each.value.vm_parameters.cpu_hot_add_enabled
  cpu_hot_remove_enabled  = each.value.vm_parameters.cpu_hot_remove_enabled
  memory_hot_add_enabled  = each.value.vm_parameters.memory_hot_add_enabled
  guest_id                = data.vsphere_virtual_machine.template[each.key].guest_id
  scsi_type               = data.vsphere_virtual_machine.template[each.key].scsi_type
  folder                  = each.value.vm_parameters.folder
  tags                    = each.value.vm_parameters.tags

  # NIC 1
  dynamic "network_interface" {
    for_each = each.value.vm_parameters.vm_network1 != null && each.value.vm_parameters.vm_network1 != "" ? [1] : []
    content {
      network_id   = data.vsphere_network.network1[each.key].id
      adapter_type = data.vsphere_virtual_machine.template[each.key].network_interface_types[0]
    }
  }
  # NIC 2
  dynamic "network_interface" {
    for_each = each.value.vm_parameters.vm_network2 != null && each.value.vm_parameters.vm_network2 != "" ? [1] : []
    content {
      network_id   = data.vsphere_network.network2[each.key].id
      adapter_type = data.vsphere_virtual_machine.template[each.key].network_interface_types[0]
    }
  }
  # NIC 3
  dynamic "network_interface" {
    for_each = each.value.vm_parameters.vm_network3 != null && each.value.vm_parameters.vm_network3 != "" ? [1] : []
    content {
      network_id   = data.vsphere_network.network3[each.key].id
      adapter_type = data.vsphere_virtual_machine.template[each.key].network_interface_types[0]
    }
  }

  # Disks - Define as a list in vm_parameters
  dynamic "disk" {
    for_each = each.value.vm_parameters.disks != null ? each.value.vm_parameters.disks : []
    content {
      label       = "disk${disk.key}"
      size        = disk.value
      unit_number = disk.key
      thin_provisioned = false  # Ensures all disks are thick provisioned
    }
  }


  clone {
    template_uuid = data.vsphere_virtual_machine.template[each.key].id

    customize {
      linux_options {
        host_name = each.value.vm_parameters.name
        domain    = each.value.vm_parameters.vm_domain
      }

      dynamic "network_interface" {
        for_each = each.value.vm_parameters.vm_network1 != null && each.value.vm_parameters.vm_network1 != "" ? [1] : []
        content {
          ipv4_address = try(data.infoblox_host_record.dns_record_ip["${each.key}_0"].results[0].ipv4_addr, null)
          ipv4_netmask = try(local.nic_cidr_prefix[each.key][0], 24)
        }
      }

      dynamic "network_interface" {
        for_each = each.value.vm_parameters.vm_network2 != null && each.value.vm_parameters.vm_network2 != "" ? [1] : []
        content {
          ipv4_address = try(data.infoblox_host_record.dns_record_ip["${each.key}_1"].results[0].ipv4_addr, null)
          ipv4_netmask = try(local.nic_cidr_prefix[each.key][1], 24)
        }
      }

      dynamic "network_interface" {
        for_each = each.value.vm_parameters.vm_network3 != null && each.value.vm_parameters.vm_network3 != "" ? [1] : []
        content {
          ipv4_address = try(data.infoblox_host_record.dns_record_ip["${each.key}_2"].results[0].ipv4_addr, null)
          ipv4_netmask = try(local.nic_cidr_prefix[each.key][2], 24)
        }
      }
      
      ipv4_gateway    = each.value.vm_parameters.gateway
      dns_server_list = each.value.vm_parameters.dns_server_list
      dns_suffix_list = each.value.vm_parameters.dns_suffix_list


    }

  }

  # exec bash script that stores the generated root password in Vault
  # Password goes via environment, not argv — argv is visible in the runner's
  # process table (ps) and can end up in logs.
  # on_failure = continue is deliberate: a failed push must NOT taint the VM
  # (Terraform would destroy/recreate it on the next apply). The script
  # prints a loud ERROR banner to the job log instead — watch for it.
  provisioner "local-exec" {
    command = "${path.root}/../../scripts/store_root_password.sh ${each.value.vm_parameters.name} ${each.value.vm_parameters.vm_domain}"
    environment = {
      NEW_ROOT_PASSWORD = random_password.root_password[each.key].result
    }
    on_failure = continue
  }


  extra_config = {
    "guestinfo.userdata" = base64encode(
      templatefile(
          "${path.root}/user-data.tpl",  # user-data.tpl in the server folder
        {
          root_password     = random_password.root_password[each.key].result,
          server_name       = each.value.vm_parameters.name,
          server_domain     = each.value.vm_parameters.vm_domain,
          admins            = file("${path.root}/../../scripts/admins.tpl"),

        }
      )
    )
    "guestinfo.userdata.encoding" = "base64"
  }

  depends_on = [data.infoblox_host_record.dns_record_ip]

  lifecycle {
    ignore_changes = [
      annotation,
      tags,
      extra_config["guestinfo.userdata"],
      clone[0].customize[0].network_interface[0].ipv4_address,
      clone[0].customize[0].network_interface[1].ipv4_address,
      clone[0].customize[0].network_interface[2].ipv4_address,
      #clone[0].template_uuid, # the template must not change and cannot be ignored
      disk.0.thin_provisioned,
      disk.0.datastore_id,
      datastore_cluster_id, # in case the datastore cluster is renamed
      custom_attributes,
    ]
  }
}

# turn the ddi_host_records lists into key/value pairs
locals {
  flattened_records = {
    for pair in flatten([
      for vm_key, vm in var.virtual_machines :
      [for index, record in vm.ddi_host_records :
        {
          key   = "${vm.vm_parameters.name}_${index}"
          value = record
        } if record.fqdn != null && record.fqdn != "" # Filter out null or empty fqdn
      ]
    ]) :
    pair.key => pair.value
  }

  # /prefix from each NIC's ipv4_cidr, so the customize netmask matches the
  # allocated network instead of assuming /24 (same logic as the PVE module).
  nic_cidr_prefix = {
    for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => [
      for record in vm.ddi_host_records :
        record.ipv4_cidr != null ? try(tonumber(split("/", record.ipv4_cidr)[1]), 24) : 24
    ]
  }
}
