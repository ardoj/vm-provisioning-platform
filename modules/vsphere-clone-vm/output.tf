output "vm_fqdn_ip_map" {
  value = {
    for vm_key, vm in var.virtual_machines :
    "${vm.vm_parameters.name}.${vm.vm_parameters.vm_domain}" => [
      try(data.infoblox_host_record.dns_record_ip["${vm_key}_0"].results[0].ipv4_addr, null),
      try(data.infoblox_host_record.dns_record_ip["${vm_key}_1"].results[0].ipv4_addr, null),
      try(data.infoblox_host_record.dns_record_ip["${vm_key}_2"].results[0].ipv4_addr, null)
    ]
  }
}
