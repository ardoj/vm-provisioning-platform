locals {
  flattened_records = {
    for pair in flatten([
      for vm_key, vm in var.virtual_machines :
      [for index, record in vm.ddi_host_records :
        {
          key   = "${vm.vm_parameters.name}_${index}"
          value = record
        } if record.fqdn != null && record.fqdn != ""
      ]
    ]) :
    pair.key => pair.value
  }

  # Extract /prefix from each NIC's network CIDR for the initialization ip_config address field.
  nic_cidr_prefix = {
    for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => [
      for record in vm.ddi_host_records :
        record.ipv4_cidr != null ? try(tonumber(split("/", record.ipv4_cidr)[1]), 24) : 24
    ]
  }
}

resource "infoblox_ip_allocation" "allocation" {
  for_each = local.flattened_records

  fqdn         = each.value.fqdn
  ipv4_cidr    = each.value.ipv4_cidr
  dns_view     = each.value.dns_view
  network_view = each.value.network_view
}

data "infoblox_host_record" "dns_record_ip" {
  for_each = local.flattened_records

  filters = {
    name = each.value.fqdn
  }
  depends_on = [infoblox_ip_allocation.allocation]
}

resource "random_password" "root_password" {
  for_each         = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }
  length           = 14
  min_lower        = 9
  min_numeric      = 2
  min_upper        = 2
  min_special      = 1
  special          = true
  override_special = "!#.-_+:"
}

# Upload cloud-init user-data as a snippet to the PVE snippets datastore.
# The snippet is created once and cloud-init runs at first boot only.
resource "proxmox_virtual_environment_file" "cloud_init" {
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }

  content_type = "snippets"
  datastore_id = each.value.vm_parameters.snippets_datastore_id
  node_name    = each.value.vm_parameters.node_name

  source_raw {
    data = templatefile(
      "${path.root}/user-data.tpl",
      {
        root_password                  = random_password.root_password[each.key].result
        server_name                    = each.value.vm_parameters.name
        server_domain                  = each.value.vm_parameters.vm_domain
        admins                         = file("${path.root}/../../scripts/admins.tpl")
      }
    )
    file_name = "${each.value.vm_parameters.name}.${each.value.vm_parameters.vm_domain}-cloud-init.yaml"
  }
}

resource "proxmox_virtual_environment_vm" "virtual_machine_clone" {
  for_each = { for vm_key, vm in var.virtual_machines : vm.vm_parameters.name => vm }

  name      = "${each.value.vm_parameters.name}.${each.value.vm_parameters.vm_domain}"
  node_name = each.value.vm_parameters.node_name

  clone {
    vm_id = each.value.vm_parameters.clone_vm_id
    full  = true
  }

  # Overwrite the template-inherited SMBIOS on every clone. Our template
  # tooling stamps PLAIN-TEXT smbios1 values, which the bpg provider fails to
  # base64-decode when reading the VM back ("illegal base64 data ..."), and
  # the failed read aborts creation AFTER the VM exists — so the Vault password
  # push provisioner never runs. The provider base64-encodes values it writes
  # itself, so setting them here makes clones immune to whatever the template
  # carries. Serial = FQDN as a bonus: the VM identifies itself via dmidecode.
  smbios {
    manufacturer = "Proxmox"
    product      = "PVE"
    serial       = "${each.value.vm_parameters.name}.${each.value.vm_parameters.vm_domain}"
  }

  # Hard-stop on destroy instead of graceful shutdown. A decommissioned VM has
  # nothing to protect (the disk is deleted seconds later), and in-guest
  # services can hang a graceful shutdown for minutes, longer than the
  # provider's shutdown timeout, failing the destroy. This also matches
  # vSphere's effective behavior (force power-off after a short wait).
  stop_on_destroy = true

  bios = each.value.vm_parameters.bios

  # UEFI needs a persistent EFI vars disk — without one PVE uses a temporary
  # efivars disk and boot entries are lost on every full stop.
  dynamic "efi_disk" {
    for_each = each.value.vm_parameters.bios == "ovmf" ? [1] : []
    content {
      datastore_id = coalesce(
        each.value.vm_parameters.efi_disk_datastore_id,
        each.value.vm_parameters.disks[0].datastore_id,
      )
      type              = "4m"
      pre_enrolled_keys = each.value.vm_parameters.efi_pre_enrolled_keys
    }
  }

  cpu {
    # Same semantics as the VMware module: cpu = total vCPUs,
    # cores_per_socket = cores per socket → sockets = cpu / cores_per_socket.
    # (Previously these were swapped here, so identical inputs produced a
    # different topology on PVE than on vSphere.)
    cores   = each.value.vm_parameters.cores_per_socket
    sockets = floor(each.value.vm_parameters.cpu / each.value.vm_parameters.cores_per_socket)
    type    = each.value.vm_parameters.cpu_type
  }

  memory {
    dedicated = each.value.vm_parameters.mem * 1024
  }

  # NIC 1
  dynamic "network_device" {
    for_each = each.value.vm_parameters.vm_network1 != null && each.value.vm_parameters.vm_network1 != "" ? [1] : []
    content {
      bridge  = each.value.vm_parameters.vm_network1
      vlan_id = each.value.vm_parameters.vm_network1_vlan
      model   = "virtio"
    }
  }
  # NIC 2
  dynamic "network_device" {
    for_each = each.value.vm_parameters.vm_network2 != null && each.value.vm_parameters.vm_network2 != "" ? [1] : []
    content {
      bridge  = each.value.vm_parameters.vm_network2
      vlan_id = each.value.vm_parameters.vm_network2_vlan
      model   = "virtio"
    }
  }
  # NIC 3
  dynamic "network_device" {
    for_each = each.value.vm_parameters.vm_network3 != null && each.value.vm_parameters.vm_network3 != "" ? [1] : []
    content {
      bridge  = each.value.vm_parameters.vm_network3
      vlan_id = each.value.vm_parameters.vm_network3_vlan
      model   = "virtio"
    }
  }

  # Disks — list of { size, datastore_id } objects; scsi0 resizes the cloned template disk
  dynamic "disk" {
    for_each = each.value.vm_parameters.disks
    content {
      datastore_id = disk.value.datastore_id
      size         = disk.value.size
      interface    = "scsi${disk.key}"
    }
  }

  initialization {
    interface = each.value.vm_parameters.cloudinit_interface
    # ip_config blocks are ordered and map 1:1 to network_device blocks.
    # Blocks are only rendered for NICs that are actually defined.
    dynamic "ip_config" {
      for_each = each.value.vm_parameters.vm_network1 != null && each.value.vm_parameters.vm_network1 != "" ? [1] : []
      content {
        ipv4 {
          address = "${try(data.infoblox_host_record.dns_record_ip["${each.key}_0"].results[0].ipv4_addr, "")}/${try(local.nic_cidr_prefix[each.key][0], 24)}"
          gateway = each.value.vm_parameters.gateway
        }
      }
    }
    dynamic "ip_config" {
      for_each = each.value.vm_parameters.vm_network2 != null && each.value.vm_parameters.vm_network2 != "" ? [1] : []
      content {
        ipv4 {
          address = "${try(data.infoblox_host_record.dns_record_ip["${each.key}_1"].results[0].ipv4_addr, "")}/${try(local.nic_cidr_prefix[each.key][1], 24)}"
        }
      }
    }
    dynamic "ip_config" {
      for_each = each.value.vm_parameters.vm_network3 != null && each.value.vm_parameters.vm_network3 != "" ? [1] : []
      content {
        ipv4 {
          address = "${try(data.infoblox_host_record.dns_record_ip["${each.key}_2"].results[0].ipv4_addr, "")}/${try(local.nic_cidr_prefix[each.key][2], 24)}"
        }
      }
    }

    dns {
      servers = each.value.vm_parameters.dns_server_list
      domain  = try(each.value.vm_parameters.dns_suffix_list[0], "")
    }

    user_data_file_id = proxmox_virtual_environment_file.cloud_init[each.key].id
  }

  # PVE tags must be lowercase
  tags = [for t in each.value.vm_parameters.tags : lower(t)]

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

  depends_on = [data.infoblox_host_record.dns_record_ip]

  lifecycle {
    ignore_changes = [
      clone[0].vm_id,
      initialization,
    ]
  }
}
#
