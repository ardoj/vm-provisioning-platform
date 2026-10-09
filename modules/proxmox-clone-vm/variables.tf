variable "virtual_machines" {
  type = map(object({
    vm_parameters = object({
      name                           = string
      vm_domain                      = string
      node_name                      = string
      clone_vm_id                    = number
      cpu                            = number
      cores_per_socket               = optional(number, 1)
      mem                            = number
      vm_network1                    = string
      vm_network1_vlan               = optional(number, null)
      vm_network2                    = optional(string, "")
      vm_network2_vlan               = optional(number, null)
      vm_network3                    = optional(string, "")
      vm_network3_vlan               = optional(number, null)
      gateway                        = string
      dns_server_list                = list(string)
      dns_suffix_list                = list(string)
      disks = list(object({
        size         = number
        datastore_id = string
      }))
      tags                           = list(string)
      snippets_datastore_id          = optional(string, "local")
      # x86-64-v3 baseline: RHEL 10 userspace requires v3 (glibc fatals on
      # v2 — "CPU does not support x86-64-v3"), RHEL 9 requires ≥v2, Ubuntu
      # is happy with either. Needs AVX2-capable hosts (Haswell 2013+ /
      # AMD Excavator+) — verify new nodes with: grep -m1 avx2 /proc/cpuinfo
      cpu_type                       = optional(string, "x86-64-v3")
      # "ovmf" (UEFI, default — parity with the vSphere efi+secure-boot setup)
      # or "seabios". ovmf gets a persistent EFI vars disk with Secure Boot
      # keys pre-enrolled; without it, boot entries are lost on every stop.
      bios                           = optional(string, "ovmf")
      efi_pre_enrolled_keys          = optional(bool, true)
      # null = put the EFI vars disk on the same datastore as the first disk
      efi_disk_datastore_id          = optional(string, null)
      # Bus for the PVE cloud-init drive. Default scsi30: on our PVE 9 /
      # QEMU 11 nodes the guest never enumerates an ide2 cdrom (no /dev/sr0 →
      # no datasource → cloud-init disabled-by-generator), while virtio-scsi
      # provably works. scsi30 sits far above the data-disk range (scsi0..N).
      cloudinit_interface            = optional(string, "scsi30")
    })
    ddi_host_records = list(object({
      fqdn         = string
      ipv4_cidr    = string
      dns_view     = optional(string, "internalZones")
      network_view = optional(string, "default")
    }))
  }))
}
