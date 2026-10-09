# modules — OpenTofu/Terraform modules that create the VMs

Two modules:

| Directory | Platform | Registry name |
|---|---|---|
| [`vsphere-clone-vm/`](vsphere-clone-vm) | VMware vSphere | `gitlab.example.internal/infra/vsphere-clone-vm/<channel>` |
| [`proxmox-clone-vm/`](proxmox-clone-vm) | Proxmox VE (bpg/proxmox) | `gitlab.example.internal/infra/proxmox-clone-vm/<channel>` |

Consumed by the server folders in [`deployments/`](../deployments) (each folder
pins an exact version in its `main.tf`). The example folders there call these
modules by relative path, which is also how CI validates them.

## What a module does per VM

1. **Infoblox**: `infoblox_ip_allocation` per non-empty `ddi_host_records`
   entry — allocates an IP from `ipv4_cidr` and creates the DNS record; the
   allocated IP is read back and configured on the NIC. The netmask is derived
   from the `/prefix` of `ipv4_cidr` (defaults to /24 when unparsable).
2. **Clone**: vSphere template clone (name-based) or PVE full clone
   (`clone_vm_id`), then CPU / RAM / disks / up to 3 NICs.
   `cpu` = total vCPUs, `cores_per_socket` = cores per socket on **both**
   platforms (sockets = cpu / cores_per_socket).
3. **Root password**: `random_password` per VM, delivered to the guest via
   cloud-init and stored in Vault (KV v2) by `scripts/store_root_password.sh`
   (password via `NEW_ROOT_PASSWORD` env var, never argv). The script runs as
   `local-exec` with `on_failure = continue` so a failed push doesn't taint
   (= destroy/recreate) the VM — failures print a loud `ERROR` banner in the
   apply log; check it. NB: password is stored in the Terraform state — treat
   state access as password access.
4. **cloud-init**: `user-data.tpl` from the server folder is rendered with
   `root_password`, `server_name`, `server_domain`, `admins` and injected via
   `guestinfo.userdata` (vSphere) or a snippets file (PVE). First boot only;
   later changes are ignored on purpose.

Monitoring needs no module step: cloud-init installs Grafana Alloy, which
pushes host metrics to a remote-write endpoint, so there is nothing to
register on create or deregister on destroy.

## Inputs

`virtual_machines` — map of `{ vm_parameters = {...}, ddi_host_records = [...] }`;
see `variables.tf` of each module for the exact schema. Platform-specific bits:

- vSphere: `datacenter`, `cluster`, `datastore_cluster`, `folder`,
  `vm_template`, `disks = [GB, ...]`, networks are portgroup names.
- PVE: `node_name`, `clone_vm_id`, `snippets_datastore_id`,
  `disks = [{size, datastore_id}, ...]`, networks are bridges/SDN vnets +
  `*_vlan` tags (leave the vlan null when using an SDN vnet — the vnet already
  carries the tag). Firmware: `bios` defaults to `"ovmf"` with a persistent
  4m EFI vars disk (Secure Boot keys pre-enrolled; disable per VM with
  `efi_pre_enrolled_keys = false`, or set `bios = "seabios"` for legacy
  templates). `cpu_type` defaults to `x86-64-v3`: RHEL 10 userspace requires
  v3 (on v2 the guest dies at boot with *"Fatal glibc error: CPU does not
  support x86-64-v3"*), RHEL 9 needs at least v2, and the provider default
  qemu64 boots neither. Needs AVX2-capable hosts — check a new node with
  `grep -m1 avx2 /proc/cpuinfo`. `cloudinit_interface` defaults to `scsi30`;
  on PVE 9 / QEMU 11 the guest never enumerates an `ide2` cdrom, so
  cloud-init finds no datasource and disables itself.

## PVE clone hygiene

Two things the PVE module does on every clone, both learned the hard way:

- **SMBIOS is overwritten**, not inherited. Templates produced by our tooling
  carry plain-text `smbios1` values; the provider base64-decodes those six
  fields unconditionally when reading the VM back, fails, and aborts creation
  *after* the VM exists — so the `local-exec` provisioner (Vault password
  push) never runs. Writing our own values makes clones immune to whatever a
  template carries, and the serial doubles as the FQDN (`dmidecode -s
  system-serial-number`).
- **`stop_on_destroy = true`.** A decommissioned VM has nothing to protect —
  its disk is deleted seconds later — and in-guest services can hang a
  graceful shutdown well past the provider's timeout. This matches what
  vSphere effectively did all along by force-powering-off after a short wait.

Template checklist: `cloud-init clean` **last**, clear the machine-id and SSH
host keys, and never boot the template afterwards.

## Outputs

`vm_fqdn_ip_map` — `{ "<fqdn>" = [nic1_ip, nic2_ip, nic3_ip] }`.

## Versioning & publishing

[`gitlab-ci.publish.yml`](gitlab-ci.publish.yml) + [`Terraform-Module-Upload.yml`](Terraform-Module-Upload.yml)
package and upload a module version on every push that touches a module directory:

- branch `main` → version `1.0.<epoch/2>` on channel `main`  (production)
- other branches → version `0.0.<epoch/2>` on channel `<branch>` (testing,
  e.g. `.../proxmox-clone-vm/test`)

Consumers pin exact versions, so publishing is always safe; nothing upgrades
until a server folder (or the portal's `MODULE_VERSION` env) is bumped
explicitly. Check what is pinned where with
`deployments/scripts/module_versions.sh`.
