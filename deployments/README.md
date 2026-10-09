# deployments — per-server configurations + the provisioning pipeline

> This directory is designed to be the **root of its own GitLab repository**:
> `.gitlab-ci.yml` watches `servers/**` and calls `scripts/` by those paths,
> and each server's state lives in that project's GitLab-managed Terraform state.

Terraform configurations for creating virtual machines on **VMware vSphere**
(DC1 + DC2) and **Proxmox VE**. One folder under `servers/` = one deployment
unit = one GitLab-managed Terraform state.

## The three components

| Component | Role |
|---|---|
| [`modules/`](../modules) | The VM creation logic (`vsphere-clone-vm`, `proxmox-clone-vm`), published to a module registry. |
| `deployments/` (this) | Per-server roots + cloud-init, and the CI pipeline that applies and destroys them. |
| [`portal/`](../portal) | Self-service web portal. Generates a `servers/<name>/` folder and commits it here — the pipeline does the rest. |

## How a VM gets created

```
portal submit  (or manual commit of servers/<name>/)
      │  commit to main: 5 files in servers/<name>/
      ▼
GitLab CI (this repo)
      getfolder  – detects which servers/<folder> changed (exactly one per push)
      validate   – gitlab-tofu init + validate  (state name = folder name)
      plan       – gitlab-tofu plan
      apply      – MANUAL gate in the GitLab UI
      postconfig – Satellite host group / collection (non-blocking)
      ▼
module vsphere-clone-vm[-pve]
      • Infoblox: allocates IP + DNS record from the given CIDR
      • clones template / VM id, sets CPU/RAM/disks/NICs
      • generates root password, stores it in Vault (scripts/store_root_password.sh)
      • injects cloud-init user-data (users, packages, monitoring agent, role software)
```

## Anatomy of a server folder

```
servers/<vm-name>.<domain>/
├── main.tf                 module call — pins the module VERSION for this server
├── provider.tf             providers + http backend (GitLab holds the state)
├── variables.tf            variable declarations incl. CI_TF_* credential vars
├── parameters.auto.tfvars  the actual VM parameters (cpu, mem, disks, networks…)
└── user-data.tpl           cloud-init — runs on FIRST BOOT ONLY (see below)
```

Credentials are never in this repo: CI variables named `TF_VAR_CI_TF_*`
(vSphere, Infoblox, PVE, Vault, Satellite) are injected
by GitLab. Three CI variables deliberately carry **no** `TF_VAR_` prefix
because they are read by shell, not by tofu: `PVE_CI_TOKEN_<cluster>`,
`PVE_CI_SSH_KEY_<cluster>` (see *Proxmox* below) and `GITLAB_TOFU_CUSTOM_CA`
(see *Runner image*). Adding the prefix to those silently breaks them.

RHEL VMs can set `satellite_hostgroup` / `satellite_host_collection` in
`parameters.auto.tfvars` (portal: "OS & Network" card). Activation keys can't
carry a host group, so the `postconfig` CI stage waits for the VM to
self-register after apply and assigns both via the Satellite API (same
account as deletion; needs edit_hosts, view_hostgroups,
view_host_collections, edit_host_collections, view_organizations). Leave
both empty on Ubuntu. The stage is `allow_failure: true`: the VM is already
built and the assignment can be redone in the Satellite UI, so a registration
that is merely slow must not redden the pipeline.

## Example server folders

- [`servers/web01.example.internal/`](servers/web01.example.internal) — vSphere, Ubuntu 24.04
- [`servers/pve-app01.example.internal/`](servers/pve-app01.example.internal) — Proxmox, RHEL 10, Satellite placement

Both are exactly what the portal generates, except that `main.tf` points at
the in-repo module by relative path instead of the registry, so CI can
`tofu validate` them without registry access.

## CI/CD variables

| Variable | Used by | Notes |
|---|---|---|
| `TF_VAR_CI_TF_VSPHERE_USER` / `_PASSWORD` | vSphere provider | |
| `TF_VAR_CI_TF_INFOBLOX_USERNAME` / `_PASSWORD` | Infoblox provider | IPAM + DNS |
| `TF_VAR_CI_TF_VAULT_TOKEN` | `store_root_password.sh` | masked; needs only `create` + `update` on `<mount>/data/<prefix>/*` |
| `TF_VAR_CI_TF_SATELLITE_USER` / `_PASSWORD` | `satellite_host_*.sh` | postconfig + cleanup |
| `TF_VAR_CI_TF_PVE_API_TOKEN` / `_SSH_PRIVATE_KEY` | Proxmox provider | declared names; overwritten per folder from the two below |
| `PVE_CI_TOKEN_<cluster>` / `PVE_CI_SSH_KEY_<cluster>` | pipeline selector | **no** `TF_VAR_` prefix — read by shell |
| `GITLAB_TOFU_CUSTOM_CA` | `gitlab-tofu` | org CA PEM, unmasked (multi-line) |
| `SATELLITE_URL`, `SATELLITE_ORG` | `satellite_host_*.sh` | |
| `VAULT_ADDR`, `VAULT_KV_MOUNT`, `VAULT_KV_PATH_PREFIX`, `VAULT_NAMESPACE` | `store_root_password.sh` | defaults `https://vault.example.internal:8200`, `secret`, `vms`; namespace optional |

## Rules that keep the pipeline happy

- **One server folder per push.** `getfolder` refuses pushes that touch several
  `servers/*` folders — the state name is derived from the single changed folder.
- **`user-data.tpl` is first-boot only.** Editing it after the VM exists does
  nothing: cloud-init has already run, and the module has `ignore_changes` on
  the user-data so the VM is not recreated. Configure existing VMs by
  hand/ansible instead.
- **To delete a VM, move its folder — never plain-delete it:**

  ```
  git mv servers/<vm-name> deleted/<vm-name>    # or the portal's "Decommission" button
  ```

  The move triggers the destroy pipeline: `getdeleted` → `destroy-plan` →
  `destroy` (**manual gate** in the GitLab UI) → `cleanup`. Cleanup removes
  the Satellite host (no-op for Ubuntu) and the GitLab state; the Vault
  secret is kept as history. Monitoring needs no cleanup — the Alloy agent
  pushed its metrics, so the series simply go stale when the VM is gone.
  Terraform releases the Infoblox IP + DNS record and removes the VM. Extra
  CI variables needed: `TF_VAR_CI_TF_SATELLITE_USER` /
  `TF_VAR_CI_TF_SATELLITE_PASSWORD` (masked).

  `deleted/<vm-name>/` stays in the repo forever — it is the archive and the
  list of decommissioned VMs. Keep it exactly one level deep. If the same name
  is deleted twice, suffix the second archive (`deleted/<name>_2026-08-03`).
  A plain `git rm` of a server folder fails the pipeline on purpose.
- **Module versions are pinned per folder** in `main.tf`. Existing servers stay
  on the version they were built with; new servers should use the newest.
  Overview of what is pinned where:

  ```
  ./scripts/module_versions.sh            # counts + per-folder listing
  ./scripts/module_versions.sh 1.0.879748515   # folders on that version
  ```

  Never bump a folder's module version without re-checking that its
  `user-data.tpl` and `parameters.auto.tfvars` still match what the new module
  version expects.

## State

Each folder's state lives in this project's GitLab Terraform state storage,
named after the folder (`GITLAB_TOFU_STATE_NAME = <folder>`). GitLab →
Operate → Terraform states. State contains secrets (e.g. generated root
passwords) — repo access is state access.

> **The variable name matters.** `gitlab-tofu` does not read the older
> `TF_STATE_NAME` at all — it silently falls back to a state named `default`.
> Every folder would then share one state, and applying VM B would plan to
> **destroy** VM A. If you ever see a plan proposing to destroy an unrelated
> server, check this first.

## Runner image

Jobs run on `gitlab-opentofu` (OpenTofu 1.12.5 + the `gitlab-tofu` wrapper,
Debian variant — the Alpine one has no bash and every script in `scripts/`
needs it). The plain `opentofu/opentofu` image does **not** work: its
ENTRYPOINT is `tofu` itself, so GitLab's `sh -c ...` becomes `tofu sh -c ...`.

The wrapper reaches `gitlab.example.internal` over TLS, so the org CA must be trusted:
the `GITLAB_TOFU_CUSTOM_CA` CI variable (PEM, unmasked — masking rejects
multi-line values) is imported into the system trust store before every
command.

## Local development

`.gitignore` blocks `.terraform/`, state files and plan files, but the safe
workflow is: don't run `terraform apply` locally at all — commit, and let the
pipeline run with its credentials.

## Proxmox

PVE folders have the same five-file layout, but `main.tf` calls
`proxmox-clone-vm` and `provider.tf` uses `bpg/proxmox`. What differs from
a vSphere folder:

- `node_name` + `clone_vm_id` (clone source is a **VM id**, not a name)
- `disks = [{ size, datastore_id }, ...]` — per-disk datastore
- networks are bridges / SDN vnets. **Leave the vlan null on an SDN vnet** —
  the vnet already carries the tag and PVE rejects a second one.
- `snippets_datastore_id` — cloud-init user-data is uploaded as a snippet,
  which the provider does over **SSH to the node**, not the API. The runner
  needs port 22 to every PVE node it deploys to; a `plan` succeeds without it
  and only `apply` hangs, so test SSH separately when adding a cluster.

### Multiple clusters

`PVE_ENDPOINTS` in the portal lists the clusters (`test=host:8006,live=...`).
Each folder pins **both** the endpoint and the cluster key:

```
pve_cluster           = "live"
CI_TF_PVE_ENDPOINT    = "https://pve-prod01.example.internal:8006/"
```

`pve_cluster` is how the pipeline picks that cluster's credentials from the
CI variables `PVE_CI_TOKEN_<key>` and `PVE_CI_SSH_KEY_<key>`, exporting them
as the `TF_VAR_CI_TF_PVE_*` the provider reads. One global token cannot serve
two clusters — their credentials differ.

There is **no fallback**, deliberately: a PVE folder with no `pve_cluster`
line, an unknown key, or a missing variable fails the job with a message
naming what to add, rather than quietly authenticating against the wrong
cluster. Adding a third cluster needs no code change — one `PVE_ENDPOINTS`
entry plus two CI variables, and the portal writes `pve_cluster` itself.

The token the **portal** uses (`PVE_API_TOKEN_<key>` in its `portal.env`) is
read-only inventory and is a different, weaker credential than the CI one.

### Module behaviour worth knowing

- `cpu_type` defaults to `x86-64-v3`. RHEL 10 userspace requires v3 — on v2
  the guest dies at boot with *"Fatal glibc error: CPU does not support
  x86-64-v3"*. Verify new nodes with `grep -m1 avx2 /proc/cpuinfo`.
- SMBIOS is **overwritten on every clone**. Templates built by our tooling
  carry plain-text `smbios1` values, which the provider fails to base64-decode
  when reading the VM back; creation then aborts *after* the VM exists, so the
  Vault password push never runs. Setting it in the
  module makes clones immune to whatever the template carries.
- `stop_on_destroy = true` — destroy hard-stops instead of asking politely.
  In-guest services can hang a graceful shutdown for minutes, longer than
  the provider's timeout. (vSphere always did this; it just
  never showed.)
- `cloudinit_interface` defaults to `scsi30`. On PVE 9 / QEMU 11 the guest
  never enumerates an `ide2` cdrom, so cloud-init finds no datasource and
  disables itself — the VM boots with the template's identity.
- Templates must be cleaned before use: `cloud-init clean` **last**, remove
  the machine-id and host keys, and never boot the template afterwards.
