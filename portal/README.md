# portal — self-service VM portal

A React (Vite) single-page app served by nginx. It fills in the Terraform
files for one server, commits them to the deployments repository through the
GitLab API, and lets the CI pipeline do the rest. The same page lists existing
servers so they can be resized or decommissioned.

There is no backend of its own: the browser talks to GitLab, vCenter and
Proxmox through nginx reverse-proxy locations generated at container start by
[`docker-entrypoint.sh`](docker-entrypoint.sh).

## Setup

```bash
cp portal.env.example portal.env     # fill in — the file is git-ignored
./deploy.sh                          # build image, replace the running container
```

or by hand:

```bash
podman build -t vm-portal .
podman run -d -p 3000:3000 --env-file portal.env --name vm-portal vm-portal
```

Then adapt the environment defaults in `src/`:

- `src/App.jsx` — `DATACENTER_DEFAULTS` (vSphere sites, clusters, datastores,
  OS templates), `VLAN_MAP` (portgroup → gateway/CIDR), `TEAMS`, and the
  Proxmox fallbacks `PVE_DEFAULTS` / `PVE_NET_MAP` (only used when a cluster
  has no read-only token)
- `src/templates/userdata.common.js` — NTP, timezone, DNS, agent endpoints
- `src/templates/userdata.defaults.js` — admin users added to every VM
- `src/templates/certs.js` — your internal CA certificates
- `src/templates/provider*.tf.js`, `variables*.tf.js` — must match the
  provider/variable files your deployments repo expects

## What it does

**Create** — datacenter (two vSphere sites or a Proxmox cluster), name, team,
environment, OS template, server role, CPU / RAM / disks, networks. It commits
five files to `servers/<vm-name>/`:

```
main.tf                 module call, version pinned
provider.tf             providers + http backend (GitLab holds the state)
variables.tf            variable declarations
parameters.auto.tfvars  the VM's parameters
user-data.tpl           cloud-init, rendered from the role + disk layout
```

**Server roles** ([`src/templates/profiles.js`](src/templates/profiles.js))
add packages, files and commands to cloud-init: `generic`, `postgresql`
(RHEL, selectable major version) and `docker` (Ubuntu 24.04 / RHEL 10).

**Resize / decommission** — the Servers view lists every folder in the repo.
Resizing rewrites CPU, RAM or disks in the existing tfvars; decommissioning
does the `servers/<vm> → deleted/<vm>` move that starts the destroy pipeline.
Commit messages carry structured metadata (`feat: provision <vm> on <DC>
[team:…] [cpu:…]`) that the pipelines list parses back.

**OS detection** — the OS template's name decides the cloud-init flavour
(`rhel9` / `rhel10` / `ubuntu`, matched loosely: `rhel-10`, `redhat10`,
`rhel_10` all work). A name with no OS token falls back to Ubuntu; the form
shows the detected flavour next to the picker.

**Proxmox** — `PVE_ENDPOINTS` lists clusters; inventory (nodes, templates with
their vmid, SDN vnets, datastores) is read live through `/pveproxy/<key>/`.
Each generated folder pins both `CI_TF_PVE_ENDPOINT` and `pve_cluster`, so a
server stays tied to its cluster for life, including its destroy.

## Security

| Credential | Where it lives |
|---|---|
| GitLab token | **server-side** — nginx `/glproxy/` adds it, and only for the one deployments project |
| Proxmox tokens | **server-side** — nginx `/pveproxy/<key>/` adds them |
| vCenter REST | **server-side** — nginx adds Basic auth on `/vcproxy/<dc>/api/` |
| vCenter SOAP login | **browser** — see below |

Known limitation: the vSphere SOAP login sends the username and password in
the request *body*, which an nginx proxy cannot inject, so `VCENTER_USER` /
`VCENTER_PASS` are served to the browser in `config.js`. Use a **read-only**
vCenter account for the portal. Removing this needs a small backend that
performs the SOAP login server-side.

The portal itself has no authentication. Run it on a trusted network or put
it behind your SSO proxy — anyone who can load the page can commit server
folders through the GitLab proxy (scoped to the deployments project, but
that project creates infrastructure).

## Tests

```bash
npm ci
npm test         # cloud-init rendering, SSH keys, OS detection, disks, app render
npm run build
```

`tests/templates.test.mjs` renders every OS × role combination, applies the
same placeholder substitution Terraform does, and parses the result as YAML —
an invalid document makes cloud-init load an *empty* config and the VM boots
unconfigured while the pipeline reports success. `tests/smoke.test.mjs`
server-side renders the whole app to catch crashes a successful build misses.
