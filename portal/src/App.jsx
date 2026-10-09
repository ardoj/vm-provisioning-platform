import { useState, useCallback, useEffect, useRef } from "react";
import { generateMainTf }  from "./templates/main.tf.js";
import { providerTf }      from "./templates/provider.tf.js";
import { variablesTf }     from "./templates/variables.tf.js";
import { generateMainTfPve } from "./templates/main.pve.tf.js";
import { providerTfPve }   from "./templates/provider.pve.tf.js";
import { variablesTfPve }  from "./templates/variables.pve.tf.js";
import { ubuntuUserData }  from "./templates/userdata.ubuntu.js";
import { rhel10UserData }  from "./templates/userdata.redhat10.js";
import { rhel9UserData }  from "./templates/userdata.redhat9.js";
import { DEFAULT_CI_USERS } from "./templates/userdata.defaults.js";
import { disksToTfvars, validateDisks, deviceFor, FS_CHOICES, DEFAULT_FS } from "./templates/userdata.disks.js";
import {
  PROFILES, PROFILE_IDS, profilesForOs, profileSupportsOs, profileTags, ALL_PROFILE_TAGS,
  defaultDisks, osFamilyOf, elMajorOf, osFlavorOf,
  PG_VERSIONS, PG_DEFAULT_VERSION, pgSupported,
} from "./templates/profiles.js";

// ─────────────────────────────────────────────────────────────
//  CONFIG  — values from ENV
// ─────────────────────────────────────────────────────────────
if (!window.ENV) {
  window.ENV = { GITLAB_URL:"", PROJECT_ID:"", REPO_BRANCH:"", SERVERS_DIR:"servers", REPO_PATH:"" };
}
const GITLAB_URL     = window.ENV.GITLAB_URL;   // public URL, only used for links
// All GitLab API calls go through the nginx /glproxy/ location, which adds the
// access token server-side — the token never reaches the browser.
const GITLAB_API     = "/glproxy/api/v4";
const PROJECT_ID     = window.ENV.PROJECT_ID;
const REPO_BRANCH    = window.ENV.REPO_BRANCH;
const SERVERS_DIR    = window.ENV.SERVERS_DIR || "servers";
const YOUR_REPO_PATH = window.ENV.REPO_PATH;
const VCENTER_USER   = window.ENV.VCENTER_USER || "";
const VCENTER_PASS   = window.ENV.VCENTER_PASS || "";
// Module version pinned into generated main.tf. Configured via gitlab.env so a
// module upgrade is a container restart, not a portal rebuild; empty falls back
// to the default in templates/main.tf.js.
const MODULE_VERSION = window.ENV.MODULE_VERSION || "";
// PVE module version — REQUIRED for creating PVE VMs (no baked-in default:
// proxmox-clone-vm must be published on the registry's `main` channel and
// the version set here, or the form refuses PVE submissions).
const MODULE_VERSION_PVE = window.ENV.MODULE_VERSION_PVE || "";


// ─────────────────────────────────────────────────────────────
//  VLAN MAP  (keyed by DC)
// ─────────────────────────────────────────────────────────────
const VLAN_MAP = {
  DC1: {
    "vlan-100-prod":  { gateway: "192.0.2.1",     cidr: "192.0.2.0/25",     ipPrefix: "192.0.2.0/25" },
    "vlan-110-test":  { gateway: "192.0.2.129",   cidr: "192.0.2.128/25",   ipPrefix: "192.0.2.128/25" },
  },
  DC2: {
    "vlan-200-prod":  { gateway: "198.51.100.1",  cidr: "198.51.100.0/25",  ipPrefix: "198.51.100.0/25" },
    "vlan-210-test":  { gateway: "198.51.100.129", cidr: "198.51.100.128/25", ipPrefix: "198.51.100.128/25" },
  },
};

// ─────────────────────────────────────────────────────────────
//  DATACENTER CONFIG
// ─────────────────────────────────────────────────────────────
const DATACENTER_DEFAULTS = {
  DC2: {
    datacenter: "DC2", vcenterName: "Datacenter-2", folder: "Linux",
    clusters: {
      "dc2-cluster-01": ["dc2-cluster-01-ssd", "dc2-cluster-01-sata"],
      "dc2-cluster-02": ["dc2-cluster-02-ssd", "dc2-cluster-02-sata"],
    },
    dns1: "192.0.2.53", dns2: "198.51.100.53", domain: "example.internal",
    osTemplates: ["dc2_ubuntu2404_template","dc2_rhel10_template","dc2_rhel9_template"],
  },
  DC1: {
    datacenter: "DC1", vcenterName: "Datacenter-1", folder: "Linux",
    clusters: {
      "dc1-cluster-01": ["dc1-cluster-01-ssd", "dc1-cluster-01-sata"],
      "dc1-cluster-02": ["dc1-cluster-02-ssd", "dc1-cluster-02-sata"],
    },
    dns1: "198.51.100.53", dns2: "192.0.2.53", domain: "example.internal",
    osTemplates: ["dc1_ubuntu2404_template","dc1_rhel10_template","dc1_rhel9_template"],
  },
};

const DC_NETWORKS   = dc           => Object.keys(VLAN_MAP[dc]);
const DC_CLUSTERS   = dc           => Object.keys(DATACENTER_DEFAULTS[dc].clusters);
const DC_DATASTORES = (dc, cluster) => DATACENTER_DEFAULTS[dc].clusters[cluster] || [];

// ─────────────────────────────────────────────────────────────
//  PROXMOX TARGET
//  Networks are SDN vnets (the vnet carries the VLAN tag, so the NIC gets no
//  guest tag). Static values below are the fallback when the /pveproxy/ nginx
//  proxy is not configured — live inventory overrides them.
// ─────────────────────────────────────────────────────────────
// PVE endpoints (clusters). Configured via PVE_ENDPOINTS env as
// "key=host:port,key2=host2:port" — falls back to the test cluster. Each key
// gets its own /pveproxy/<key>/ nginx location with its own read-only token.
function parsePveEndpoints(raw) {
  const list = (raw || "").split(",").map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf("=");
    return i > 0 ? { key: s.slice(0, i).trim(), host: s.slice(i + 1).trim() } : null;
  }).filter(Boolean);
  return list.length ? list : [{ key: "test", host: "pve-test01.example.internal:8006" }];
}
const PVE_ENDPOINTS = parsePveEndpoints(window.ENV.PVE_ENDPOINTS);
const pveTplDisplay = t => `${t.label} (${t.vmid})`;
const pveEndpointHost = key =>
  (PVE_ENDPOINTS.find(e => e.key === key) || PVE_ENDPOINTS[0]).host;

const PVE_DEFAULTS = {
  domain: "example.internal",
  dns1: "192.0.2.53", dns2: "198.51.100.53",
  nodes: ["pve-node01"],
  templates: [
    { label: "ubuntu2404-template", vmid: 9000 },
  ],
  datastores: ["local-lvm"],
  snippetsDatastore: "local",
  vnets: ["vnet100", "vnet110"],
};

// vnet → gateway/cidr prefill (same job VLAN_MAP does for vSphere portgroups)
const PVE_NET_MAP = {
  "vnet100": { gateway: "203.0.113.1",   cidr: "203.0.113.0/25" },
  "vnet110": { gateway: "203.0.113.129", cidr: "203.0.113.128/25" },
};

async function pveFetch(endpointKey, path) {
  const res = await fetch(`/pveproxy/${endpointKey}${path}`);
  if (!res.ok) throw new Error(`PVE API ${res.status}`);
  return (await res.json()).data ?? [];
}

// Live inventory: nodes, clone templates, image datastores, SDN vnets.
// Any failure throws — the caller falls back to PVE_DEFAULTS.
async function fetchPveInventory(endpointKey) {
  const [nodes, resources] = await Promise.all([
    pveFetch(endpointKey, "/api2/json/nodes"),
    pveFetch(endpointKey, "/api2/json/cluster/resources?type=vm"),
  ]);
  const nodeNames = nodes.map(n => n.node).sort();
  const templates = resources
    .filter(r => r.template === 1)
    .map(r => ({ label: r.name, vmid: r.vmid, node: r.node }))
    .sort((a, b) => a.label.localeCompare(b.label));

  let vnets = [];
  try {
    vnets = (await pveFetch(endpointKey, "/api2/json/cluster/sdn/vnets")).map(v => v.vnet).sort();
  } catch { /* SDN not configured — fall back to static list */ }

  let datastores = [], snippetsDatastores = [];
  if (nodeNames.length) {
    const storages = await pveFetch(endpointKey, `/api2/json/nodes/${nodeNames[0]}/storage`);
    datastores = storages
      .filter(s => (s.content || "").includes("images") && s.enabled !== 0)
      .map(s => s.storage).sort();
    snippetsDatastores = storages
      .filter(s => (s.content || "").includes("snippets"))
      .map(s => s.storage).sort();
  }
  return { nodes: nodeNames, templates, vnets, datastores, snippetsDatastores };
}

const TEAMS = ["Platform","Data","Web","Security"];
const ENVS  = ["Dev","QA","Prod"];

// ─────────────────────────────────────────────────────────────
//  CLOUD-INIT — template dispatcher
// ─────────────────────────────────────────────────────────────
function mkRoutingOpts(form, showNic2, showNic3) {
  const gw = cidr => cidr ? cidr.split("/")[0].replace(/\.\d+$/, ".1") : "";
  return {
    gw1:  form.gateway || "",
    gw2:  showNic2 ? gw(form.ipCidr2) : "",
    gw3:  showNic2 && showNic3 ? gw(form.ipCidr3) : "",
    nic2: showNic2,
    nic3: showNic2 && showNic3,
  };
}

function renderUserData(os, guiUsers, opts = {}, defaults = DEFAULT_CI_USERS) {
  const allUsers = [...defaults, ...guiUsers];
  const flavor = osFlavorOf(os);
  if (flavor === "rhel9")  return rhel9UserData(allUsers, opts);
  if (flavor === "rhel10") return rhel10UserData(allUsers, opts);
  return ubuntuUserData(allUsers, opts);
}

// Everything the cloud-init templates need, gathered from the form in one place
// so every regeneration path stays in sync.
function userDataOpts(form, showNic2, showNic3) {
  return {
    ...mkRoutingOpts(form, showNic2, showNic3),
    disks:     form.disks,
    profile:   form.profile,
    pgVersion: form.pgVersion,
  };
}

// ─────────────────────────────────────────────────────────────
//  TAG SYNC HELPER
// ─────────────────────────────────────────────────────────────
// Auto-managed tags come from team/env/backup/service plus the selected profile
// (e.g. a PostgreSQL server always carries FirstDiskOnly). Tags the user typed
// by hand are preserved; tags a profile owns are dropped when the profile
// changes, so switching roles does not accumulate stale tags.
function autoTagsFor({ team, env, backup, service, profile }) {
  const t = [team, env];
  if (backup === "NO")            t.push("nobackup");
  if (service && service.trim())  t.push(service.trim());
  t.push(...profileTags(profile));
  return t.filter(Boolean);
}

function syncTags(next, prev, currentTags) {
  const newAuto    = autoTagsFor(next);
  const newAutoSet = new Set(newAuto);
  const oldAuto    = new Set([...autoTagsFor(prev), ...ALL_PROFILE_TAGS]);

  const extra = currentTags
    .split(",")
    .map(t => t.trim())
    .filter(t => t && !oldAuto.has(t) && !newAutoSet.has(t));

  return [...newAuto, ...extra].join(", ");
}

// ─────────────────────────────────────────────────────────────
//  GITLAB API
// ─────────────────────────────────────────────────────────────
// Shared tfvars pieces
function tfvarsCommon(form) {
  return {
    tags: form.tags.trim() ? form.tags.split(",").map(t=>`"${t.trim()}"`).join(", ") : "",
    vmShortName: form.vmName.split(".")[0],
    // Satellite values only make sense on RHEL (Ubuntu never registers) — the
    // CI postconfig stage skips when both are empty.
    satHg: osFamilyOf(form.os) === "rhel" ? (form.satelliteHostgroup || "").trim() : "",
    satHc: osFamilyOf(form.os) === "rhel" ? (form.satelliteHostCollection || "").trim() : "",
  };
}

function generatePveTfvars(form) {
  const { tags, vmShortName, satHg, satHc } = tfvarsCommon(form);
  // Every disk goes to the selected PVE datastore; per-disk overrides can be
  // edited in the tfvars by hand.
  const ds = form.pveDatastore || "local-lvm";
  const disks = form.disks
    .map(d => `  { size = ${Number(d.size) || 0}, datastore_id = "${ds}" },`)
    .join("\n");
  const endpointUrl = `https://${pveEndpointHost(form.pveEndpoint)}/`;
  return `vm_name               = "${vmShortName}"
vm_domain             = "${form.domain}"
# PVE cluster for this VM — *.auto.tfvars overrides the TF_VAR_ env default,
# so the folder stays pinned to its cluster whatever the CI default is.
# pve_cluster is the key the pipeline uses to pick this cluster's CI
# credentials (PVE_CI_TOKEN_<key> / PVE_CI_SSH_KEY_<key>).
pve_cluster           = "${form.pveEndpoint}"
CI_TF_PVE_ENDPOINT    = "${endpointUrl}"
node_name             = "${form.node}"
clone_vm_id           = ${form.cloneVmId}
cpu                   = ${form.cpu}
mem                   = ${form.ram}
# SDN vnets carry the VLAN tag themselves — NIC vlan stays null
vm_network1           = "${form.network1}"
vm_network1_vlan      = null
vm_network2           = "${form.network2}"
vm_network2_vlan      = null
vm_network3           = "${form.network3}"
vm_network3_vlan      = null
gateway               = "${form.gateway}"
dns_server_list       = ["${form.dns1}", "${form.dns2}"]
disks = [
${disks}
]
tags                  = [${tags}]
snippets_datastore_id = "${form.snippetsDatastore || "local"}"
nic1_ipv4_cidr        = "${form.ipCidr}"
nic2_ipv4_cidr        = "${form.ipCidr2}"
nic3_ipv4_cidr        = "${form.ipCidr3}"
dns_name_nic2         = "${form.dnsNic2}"
dns_name_nic3         = "${form.dnsNic3}"
satellite_hostgroup   = "${satHg}"
satellite_host_collection = "${satHc}"
`;
}

function generateTfvars(form) {
  if (form.datacenter === "PVE") return generatePveTfvars(form);
  const { tags, vmShortName, satHg, satHc } = tfvarsCommon(form);
  const disks = disksToTfvars(form.disks);
  const vcenterDc = DATACENTER_DEFAULTS[form.datacenter]?.vcenterName || form.datacenter;
  return `vm_name                = "${vmShortName}"
vm_domain              = "${form.domain}"
datacenter             = "${vcenterDc}"
cluster                = "${form.cluster}"
datastore_cluster      = "${form.datastoreCluster}"
folder                 = "${form.folder}"
cpu                    = ${form.cpu}
mem                    = ${form.ram}
vm_template            = "${form.os}"
vm_network1            = "${form.network1}"
vm_network2            = "${form.network2}"
vm_network3            = "${form.network3}"
gateway                = "${form.gateway}"
dns_server_list        = ["${form.dns1}", "${form.dns2}"]
disks                  = [${disks}]
tags                   = [${tags}]
nic1_ipv4_cidr         = "${form.ipCidr}"
nic2_ipv4_cidr         = "${form.ipCidr2}"
nic3_ipv4_cidr         = "${form.ipCidr3}"
dns_name_nic2          = "${form.dnsNic2}"
dns_name_nic3          = "${form.dnsNic3}"
satellite_hostgroup    = "${satHg}"
satellite_host_collection = "${satHc}"
`;
}

// The portal never triggers pipelines directly — it commits files and GitLab's
// `rules: changes` starts the pipeline. So the VM metadata travels in the
// commit message, in a stable machine-parseable form:
//   feat: provision <vm> on <DC> [team:X] [env:Y] [os:...] [cpu:4] [ram:8] [disks:20, 300]
function buildCommitMessage(form) {
  return `feat: provision ${form.vmName} on ${form.datacenter}`
    + ` [team:${form.team}] [env:${form.env}] [os:${form.os}]`
    + ` [cpu:${form.cpu}] [ram:${form.ram}] [disks:${disksToTfvars(form.disks)}]`;
}

function parseCommitTitle(title = "") {
  const head = title.match(/(provision|resize|decommission) (\S+) on (\S+)/);
  const tag  = k => (title.match(new RegExp(`\\[${k}:([^\\]]*)\\]`)) || [])[1]?.trim() || "—";
  return {
    action:     head?.[1] || null,
    vmName:     head?.[2] || null,
    datacenter: head?.[3] || "—",
    team: tag("team"), env: tag("env"), os: tag("os"),
    cpu:  tag("cpu"),  ram: tag("ram"), disk: tag("disks"),
  };
}

async function commitVmFiles(form) {
  const folder = `${SERVERS_DIR}/${form.vmName}`;

  // Pre-check: the commit uses action:"create", which fails with a cryptic
  // GitLab error if the folder already exists. Catch it up front instead.
  const check = await fetch(
    `${GITLAB_API}/projects/${PROJECT_ID}/repository/tree?path=${encodeURIComponent(folder)}&ref=${REPO_BRANCH}&per_page=1`,
    {}
  );
  if (check.ok && (await check.json()).length > 0) {
    throw new Error(`${form.vmName} already exists (${folder}/ is in the repo) — pick another name, or remove the old folder first`);
  }

  const isPve = form.datacenter === "PVE";
  const actions = [
    { file_path: `${folder}/main.tf`,                content: isPve ? generateMainTfPve(MODULE_VERSION_PVE) : generateMainTf(form.datacenter, MODULE_VERSION) },
    { file_path: `${folder}/provider.tf`,            content: isPve ? providerTfPve : providerTf },
    { file_path: `${folder}/variables.tf`,           content: isPve ? variablesTfPve : variablesTf },
    { file_path: `${folder}/parameters.auto.tfvars`, content: generateTfvars(form) },
    { file_path: `${folder}/user-data.tpl`,          content: form.userData },
  ].map(a => ({ action:"create", file_path:a.file_path, content:a.content, encoding:"text" }));

  const res = await fetch(`${GITLAB_API}/projects/${PROJECT_ID}/repository/commits`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      branch: REPO_BRANCH,
      commit_message: buildCommitMessage(form),
      actions,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(()=>({}));
    throw new Error(err.message || `GitLab API error ${res.status}`);
  }
  return res.json();
}

async function loadPipelines() {
  const res = await fetch(
    `${GITLAB_API}/projects/${PROJECT_ID}/pipelines?ref=${REPO_BRANCH}&per_page=20`,
    {}
  );
  if (!res.ok) {
    const raw = await res.text();
    console.error("GitLab pipelines error", res.status, raw);
    throw new Error(`GitLab API error ${res.status}`);
  }
  const list = await res.json();

  // Metadata comes from each pipeline's commit title (see buildCommitMessage).
  // Manual commits that don't match the format still get a readable row —
  // the commit title itself instead of "pipeline-<id>".
  return Promise.all(list.map(async p => {
    let title = "";
    try {
      const cr = await fetch(
        `${GITLAB_API}/projects/${PROJECT_ID}/repository/commits/${p.sha}`,
        {}
      );
      if (cr.ok) title = (await cr.json()).title || "";
    } catch { /* row falls back to pipeline id below */ }

    const meta = parseCommitTitle(title);
    return {
      id: String(p.id),
      vmName: meta.vmName || (title ? title.slice(0, 44) : `pipeline-${p.id}`),
      action: meta.action,
      team: meta.team, env: meta.env, datacenter: meta.datacenter, os: meta.os,
      cpu: meta.cpu, ram: meta.ram, disk: meta.disk,
      status: p.status, createdAt: p.created_at, createdBy: p.user?.name||"—", webUrl: p.web_url,
    };
  }));
}

// ─────────────────────────────────────────────────────────────
//  SERVERS  (existing VMs = folders under servers/ in vm-deploy)
// ─────────────────────────────────────────────────────────────
// Not VM folders: EXAMPLE is documentation
// the pipeline cannot handle as a terraform root.
const EXCLUDED_FOLDERS = new Set(["EXAMPLE"]);

async function glFetch(path) {
  const res = await fetch(`${GITLAB_API}/projects/${PROJECT_ID}${path}`,
    {});
  if (!res.ok) throw new Error(`GitLab API ${res.status}`);
  return res;
}

async function fetchServerFolders() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await glFetch(`/repository/tree?path=${SERVERS_DIR}&ref=${REPO_BRANCH}&per_page=100&page=${page}`);
    const items = await res.json();
    out.push(...items.filter(i => i.type === "tree" && !EXCLUDED_FOLDERS.has(i.name)).map(i => i.name));
    if (items.length < 100) break;
  }
  return out.sort();
}

async function fetchRawFile(path) {
  const res = await glFetch(`/repository/files/${encodeURIComponent(path)}/raw?ref=${REPO_BRANCH}`);
  return res.text();
}

// ── parameters.auto.tfvars parsing ──────────────────────────
// Regex-based on purpose: we only ever rewrite the three values the portal
// edits (cpu, mem, disks) and leave every other byte of the file untouched.
function tfvarsStr(raw, key) {
  const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : "";
}
function tfvarsNum(raw, key) {
  const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*([0-9]+)`, "m"));
  return m ? Number(m[1]) : null;
}
// disks = [...] — bracket-balanced span; PVE object lists span multiple lines
function tfvarsDisksSpan(raw) {
  const m = raw.match(/^\s*disks\s*=\s*\[/m);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === "[" || raw[i] === "{") depth++;
    else if (raw[i] === "]" || raw[i] === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i + 1, text: raw.slice(open, i + 1) };
    }
  }
  return null;
}

function parseTfvars(raw) {
  const span  = tfvarsDisksSpan(raw);
  const disksText = span ? span.text : "";
  const inner = disksText.slice(1, -1).trim();
  const numeric = inner === "" || /^[\d\s,]+$/.test(inner);
  return {
    vmName:   tfvarsStr(raw, "vm_name"),
    vmDomain: tfvarsStr(raw, "vm_domain"),
    datacenter: tfvarsStr(raw, "datacenter"),
    cluster:  tfvarsStr(raw, "cluster"),
    nodeName: tfvarsStr(raw, "node_name"),
    template: tfvarsStr(raw, "vm_template"),
    network1: tfvarsStr(raw, "vm_network1"),
    cidr:     tfvarsStr(raw, "nic1_ipv4_cidr"),
    cpu:      tfvarsNum(raw, "cpu"),
    mem:      tfvarsNum(raw, "mem"),
    disksText,
    disksNumeric: numeric
      ? (inner ? inner.split(",").map(s => Number(s.trim())).filter(n => !isNaN(n)) : [])
      : null,
    tagsRaw:  (raw.match(/^\s*tags\s*=\s*(\[[^\]]*\])/m) || [])[1] || "",
    isPve:    /^\s*node_name\s*=/m.test(raw),
  };
}

function updateTfvars(raw, { cpu, mem, disksText }) {
  let out = raw;
  out = out.replace(/^(\s*cpu\s*=\s*)\d+/m, `$1${cpu}`);
  out = out.replace(/^(\s*mem\s*=\s*)\d+/m, `$1${mem}`);
  const span = tfvarsDisksSpan(out);
  if (span && disksText) out = out.slice(0, span.start) + disksText + out.slice(span.end);
  return out;
}

// Reverse-map the tfvars datacenter (vCenter name like "Datacenter-2") to a DC key
function dcOfParsed(parsed) {
  if (!parsed) return "DC";
  if (parsed.isPve) return "PVE";
  for (const [key, d] of Object.entries(DATACENTER_DEFAULTS)) {
    if (d.vcenterName === parsed.datacenter || key === parsed.datacenter) return key;
  }
  return (parsed.datacenter || "DC").replace(/\s+/g, "_");
}

async function commitResize(folder, newRaw, parsed, edit) {
  const disks = edit.disks ? edit.disks.join(", ") : "…";
  const res = await fetch(`${GITLAB_API}/projects/${PROJECT_ID}/repository/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      branch: REPO_BRANCH,
      commit_message: `feat: resize ${folder} on ${dcOfParsed(parsed)}`
        + ` [cpu:${edit.cpu}] [ram:${edit.mem}] [disks:${disks}]`,
      actions: [{
        action: "update",
        file_path: `${SERVERS_DIR}/${folder}/parameters.auto.tfvars`,
        content: newRaw,
        encoding: "text",
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitLab API error ${res.status}`);
  }
  return res.json();
}

// Move servers/<folder> → deleted/<target> in ONE commit. The move is the
// delete request: the destroy pipeline keys off the folder vanishing from
// servers/, and the archived copy is its working directory + permanent record.
async function decommissionVm(folder, parsed) {
  const files = [];
  for (let page = 1; page <= 5; page++) {
    const res = await glFetch(`/repository/tree?path=${encodeURIComponent(`${SERVERS_DIR}/${folder}`)}&ref=${REPO_BRANCH}&recursive=true&per_page=100&page=${page}`);
    const items = await res.json();
    files.push(...items.filter(i => i.type === "blob").map(i => i.path));
    if (items.length < 100) break;
  }
  if (!files.length) throw new Error(`no files found under ${SERVERS_DIR}/${folder}`);

  // archive name must be unique (same VM name may have been deleted before) —
  // and must stay exactly one level deep (the module resolves ../../scripts)
  const taken = async name => {
    const res = await fetch(
      `${GITLAB_API}/projects/${PROJECT_ID}/repository/tree?path=${encodeURIComponent(`deleted/${name}`)}&ref=${REPO_BRANCH}&per_page=1`,
      {});
    return res.ok && (await res.json()).length > 0;
  };
  let target = folder;
  if (await taken(target)) {
    target = `${folder}_${new Date().toISOString().slice(0, 10)}`;
    if (await taken(target)) {
      target = `${folder}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
    }
  }

  const actions = files.map(p => ({
    action: "move",
    previous_path: p,
    file_path: p.replace(`${SERVERS_DIR}/${folder}/`, `deleted/${target}/`),
  }));
  const res = await fetch(`${GITLAB_API}/projects/${PROJECT_ID}/repository/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      branch: REPO_BRANCH,
      commit_message: `chore: decommission ${folder} on ${dcOfParsed(parsed)}`,
      actions,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitLab API error ${res.status}`);
  }
  return target;
}

// ─────────────────────────────────────────────────────────────
//  VCENTER API  (routed through /vcproxy/<dc>/ nginx proxy)
//  nginx injects Basic auth → vCenter returns session token
//  subsequent calls use that token via vmware-api-session-id
// ─────────────────────────────────────────────────────────────
const _vcSessions = {};

async function getVcSession(dc) {
  if (_vcSessions[dc]) return _vcSessions[dc];
  const res = await fetch(`/vcproxy/${dc.toLowerCase()}/api/session`, { method: "POST" });
  if (!res.ok) throw new Error(`vCenter login failed (${res.status})`);
  _vcSessions[dc] = await res.json();
  return _vcSessions[dc];
}

async function vcFetch(dc, path) {
  let token = await getVcSession(dc);
  let res = await fetch(`/vcproxy/${dc.toLowerCase()}${path}`, {
    headers: { "vmware-api-session-id": token },
  });
  if (res.status === 401) {
    delete _vcSessions[dc];
    token = await getVcSession(dc);
    res = await fetch(`/vcproxy/${dc.toLowerCase()}${path}`, {
      headers: { "vmware-api-session-id": token },
    });
  }
  if (!res.ok) throw new Error(`vCenter API error ${res.status}`);
  return res.json();
}

async function fetchVcClusters(dc) {
  const data = await vcFetch(dc, "/api/vcenter/cluster");
  return (data || []).map(c => ({ id: c.cluster, name: c.name }));
}

const _soapLoggedIn   = {};
const _soapLoginInFlight = {};

function xmlEscape(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

async function soapLogin(dc) {
  // Deduplicate concurrent login calls — only one Login request per DC at a time.
  if (_soapLoginInFlight[dc]) return _soapLoginInFlight[dc];

  const promise = (async () => {
    // Clear stale vmware_soap_session cookies from all paths before logging in.
    // Old cookies from previous container deploys get sent with Login and cause auth failures.
    const _exp = "expires=Thu, 01 Jan 1970 00:00:00 GMT";
    document.cookie = `vmware_soap_session=; ${_exp}; path=/`;
    document.cookie = `vmware_soap_session=; ${_exp}; path=/vcproxy/dc1/`;
    document.cookie = `vmware_soap_session=; ${_exp}; path=/vcproxy/dc2/`;

    // Login with credentials in SOAP body.
    // nginx removes Secure flag and rewrites Path to /vcproxy/<dc>/ so DC1 and DC2
    // cookies are stored under separate browser paths and never sent to the wrong DC.
    const res = await fetch(`/vcproxy/${dc.toLowerCase()}/sdk`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "text/xml; charset=UTF-8", "SOAPAction": "urn:vim25/6.5" },
      body: `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vim25="urn:vim25">
  <soapenv:Body>
    <vim25:Login>
      <vim25:_this type="SessionManager">SessionManager</vim25:_this>
      <vim25:userName>${xmlEscape(VCENTER_USER)}</vim25:userName>
      <vim25:password>${xmlEscape(VCENTER_PASS)}</vim25:password>
    </vim25:Login>
  </soapenv:Body>
</soapenv:Envelope>`,
    });
    const text = await res.text();
    const doc  = new DOMParser().parseFromString(text, "text/xml");
    const fault = doc.getElementsByTagName("faultstring")[0];
    if (fault) throw new Error(`SOAP Login: ${fault.textContent?.trim()}`);
    if (!res.ok) throw new Error(`SOAP Login HTTP ${res.status}: ${text.slice(0, 200)}`);
    _soapLoggedIn[dc] = true;
  })();
  _soapLoginInFlight[dc] = promise;
  promise.finally(() => { delete _soapLoginInFlight[dc]; });
  return promise;
}

async function soapCall(dc, body, isRetry = false) {
  if (!_soapLoggedIn[dc]) await soapLogin(dc);
  // credentials: include sends the DC-scoped cookie (Path=/vcproxy/<dc>/) automatically.
  const res = await fetch(`/vcproxy/${dc.toLowerCase()}/sdk`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "text/xml; charset=UTF-8",
      "SOAPAction":   "urn:vim25/6.5",
    },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:vim25="urn:vim25"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`,
  });
  const text = await res.text();
  const doc  = new DOMParser().parseFromString(text, "text/xml");
  const fault = doc.getElementsByTagName("faultstring")[0];
  if (fault) {
    const msg = fault.textContent?.trim();
    if (!isRetry && (msg?.includes("NotAuthenticated") || msg?.includes("not authenticated"))) {
      delete _soapLoggedIn[dc];
      return soapCall(dc, body, true);
    }
    throw new Error(`SOAP: ${msg}`);
  }
  if (!res.ok) throw new Error(`SOAP HTTP ${res.status}: ${text.slice(0, 200)}`);
  return doc;
}

async function fetchVcDatastoreClusters(dc, clusterId, clusterName) {
  // Step 1: datastores accessible from this cluster's hosts
  const hosts = await vcFetch(dc, `/api/vcenter/host?clusters=${clusterId}`);
  let clusterDs = [];
  const accessibleIds = new Set();
  if (hosts?.length) {
    const hq = hosts.map(h => `hosts=${h.host}`).join("&");
    const ds = await vcFetch(dc, `/api/vcenter/datastore?${hq}`);
    clusterDs = (ds || []).map(d => ({ id: d.datastore, name: d.name }));
    clusterDs.forEach(d => accessibleIds.add(d.id));
  }

  // Step 2: get MOIDs from ServiceContent
  const sc = await soapCall(dc, `
    <vim25:RetrieveServiceContent>
      <vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this>
    </vim25:RetrieveServiceContent>`);
  const rootFolder    = sc.getElementsByTagName("rootFolder")[0]?.textContent?.trim();
  const propCollector = sc.getElementsByTagName("propertyCollector")[0]?.textContent?.trim();
  const viewManager   = sc.getElementsByTagName("viewManager")[0]?.textContent?.trim();
  if (!rootFolder || !propCollector || !viewManager) throw new Error("Could not read ServiceContent");

  // Step 3: CreateContainerView for StoragePod — exactly what the pyvmomi sample does
  const cvDoc = await soapCall(dc, `
    <vim25:CreateContainerView>
      <vim25:_this type="ViewManager">${viewManager}</vim25:_this>
      <vim25:container type="Folder">${rootFolder}</vim25:container>
      <vim25:type>StoragePod</vim25:type>
      <vim25:recursive>true</vim25:recursive>
    </vim25:CreateContainerView>`);
  const viewRef = cvDoc.getElementsByTagName("returnval")[0]?.textContent?.trim();
  if (!viewRef) throw new Error("CreateContainerView returned no ref");

  // Step 4: retrieve name + childEntity for all StoragePods in the view
  const doc = await soapCall(dc, `
    <vim25:RetrievePropertiesEx>
      <vim25:_this type="PropertyCollector">${propCollector}</vim25:_this>
      <vim25:specSet>
        <vim25:propSet>
          <vim25:type>StoragePod</vim25:type>
          <vim25:pathSet>name</vim25:pathSet>
          <vim25:pathSet>childEntity</vim25:pathSet>
        </vim25:propSet>
        <vim25:objectSet>
          <vim25:obj type="ContainerView">${viewRef}</vim25:obj>
          <vim25:skip>true</vim25:skip>
          <vim25:selectSet xsi:type="vim25:TraversalSpec">
            <vim25:type>ContainerView</vim25:type>
            <vim25:path>view</vim25:path>
            <vim25:skip>false</vim25:skip>
          </vim25:selectSet>
        </vim25:objectSet>
      </vim25:specSet>
      <vim25:options/>
    </vim25:RetrievePropertiesEx>`);

  // Step 5: destroy the ContainerView to free server resources
  soapCall(dc, `
    <vim25:DestroyView>
      <vim25:_this type="ContainerView">${viewRef}</vim25:_this>
    </vim25:DestroyView>`).catch(() => {});

  // Step 6: parse StoragePod objects from response
  const pods = [];
  Array.from(doc.getElementsByTagName("objects")).forEach(obj => {
    const objEl = obj.getElementsByTagName("obj")[0];
    if (!objEl || objEl.getAttribute("type") !== "StoragePod") return;
    const moid = objEl.textContent?.trim();
    let name = "";
    const childIds = [];
    Array.from(obj.getElementsByTagName("propSet")).forEach(ps => {
      const path = ps.getElementsByTagName("name")[0]?.textContent?.trim();
      if (path === "name") {
        name = ps.getElementsByTagName("val")[0]?.textContent?.trim() || "";
      } else if (path === "childEntity") {
        Array.from(ps.getElementsByTagName("ManagedObjectReference"))
          .forEach(ref => childIds.push(ref.textContent?.trim()));
      }
    });
    if (moid && name) pods.push({ id: moid, name, childIds });
  });

  // No StoragePods configured — fall back to individual datastores
  if (!pods.length) return clusterDs;

  // Match by the number embedded in the cluster name (e.g. "dc1-clu01" → 1, "dc2-cluster-02" → 2).
  // Every datastore cluster for that cluster contains the same number in its name
  // (e.g. cluster "dc2-cluster-02" → "dc2-cluster-02-sata", "dc2-cluster-02-ssd"). Compare the
  // numbers numerically so zero-padding differences (e.g. "02" vs "2") still match.
  if (clusterName) {
    const numMatch = clusterName.match(/\d+/);
    if (numMatch) {
      const num = parseInt(numMatch[0], 10);
      const matched = pods.filter(p => {
        const m = p.name.match(/\d+/);
        return m && parseInt(m[0], 10) === num;
      });
      if (matched.length) return matched.map(p => ({ id: p.id, name: p.name }));
    }
  }

  return pods.map(p => ({ id: p.id, name: p.name }));
}

async function fetchVcNetworks(dc, clusterId) {
  const data = await vcFetch(dc, `/api/vcenter/network?clusters=${clusterId}&types=DISTRIBUTED_PORTGROUP`);
  const networks = (data || []).map(n => ({ id: n.network, name: n.name, cidr: "" }));

  if (!networks.length) return networks;

  // REST /api/vcenter/network/distributed-port-group/{id} returns 404 on this vCenter.
  // Use SOAP RetrievePropertiesEx to fetch config.description for all portgroups in one call.
  try {
    const sc = await soapCall(dc, `
      <vim25:RetrieveServiceContent>
        <vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this>
      </vim25:RetrieveServiceContent>`);
    const propCollector = sc.getElementsByTagName("propertyCollector")[0]?.textContent?.trim();
    if (propCollector) {
      const objectSet = networks.map(n =>
        `<vim25:objectSet>
          <vim25:obj type="DistributedVirtualPortgroup">${n.id}</vim25:obj>
          <vim25:skip>false</vim25:skip>
        </vim25:objectSet>`
      ).join("\n");

      const doc = await soapCall(dc, `
        <vim25:RetrievePropertiesEx>
          <vim25:_this type="PropertyCollector">${propCollector}</vim25:_this>
          <vim25:specSet>
            <vim25:propSet>
              <vim25:type>DistributedVirtualPortgroup</vim25:type>
              <vim25:pathSet>config.description</vim25:pathSet>
            </vim25:propSet>
            ${objectSet}
          </vim25:specSet>
          <vim25:options/>
        </vim25:RetrievePropertiesEx>`);

      Array.from(doc.getElementsByTagName("objects")).forEach(obj => {
        const objEl = obj.getElementsByTagName("obj")[0];
        if (!objEl || objEl.getAttribute("type") !== "DistributedVirtualPortgroup") return;
        const moid = objEl.textContent?.trim();
        const net = networks.find(n => n.id === moid);
        if (!net) return;
        Array.from(obj.getElementsByTagName("propSet")).forEach(ps => {
          const path = ps.getElementsByTagName("name")[0]?.textContent?.trim();
          if (path === "config.description") {
            const desc = (ps.getElementsByTagName("val")[0]?.textContent || "").trim();
            const match = desc.match(/(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2})/);
            if (match) net.cidr = `${match[1]}/${match[2]}`;
          }
        });
      });
    }
  } catch { /* descriptions unavailable — networks still returned without cidr */ }

  return networks;
}

// ─────────────────────────────────────────────────────────────
//  SSH DIRECTORY  (proxied via nginx /sshproxy/)
// ─────────────────────────────────────────────────────────────
async function fetchSshUsers() {
  const res = await fetch("/sshproxy/");
  if (!res.ok) throw new Error(`SSH dir ${res.status}`);
  const html = await res.text();
  // directory listing: links like href="firstname.lastname.pub"
  const matches = [...html.matchAll(/href="([\w.-]+\.pub)"/gi)];
  return matches
    .map(m => ({ name: m[1].replace(/\.pub$/i, ""), file: m[1] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchSshKey(filename) {
  const res = await fetch(`/sshproxy/${filename}`);
  if (!res.ok) throw new Error(`Key fetch ${res.status}`);
  return (await res.text()).trim();
}

// ─────────────────────────────────────────────────────────────
//  HELPERS & CONSTANTS
// ─────────────────────────────────────────────────────────────
const S = {
  success:   { bg:"#f0fdf4", text:"#15803d", border:"#86efac" },
  running:   { bg:"#fefce8", text:"#a16207", border:"#fde047" },
  failed:    { bg:"#fef2f2", text:"#b91c1c", border:"#fca5a5" },
  pending:   { bg:"#f5f3ff", text:"#6d28d9", border:"#c4b5fd" },
  cancelled: { bg:"#f9fafb", text:"#6b7280", border:"#d1d5db" },
  created:   { bg:"#eff6ff", text:"#1d4ed8", border:"#93c5fd" },
  manual:    { bg:"#fff7ed", text:"#c2410c", border:"#fdba74" },
};
const SICON = { success:"✓", running:"⟳", failed:"✕", pending:"…", cancelled:"⊘", created:"…", manual:"▶" };
const DC    = { DC1:{ bg:"#eff6ff", text:"#1d4ed8", border:"#93c5fd" }, DC2:{ bg:"#f0fdf4", text:"#15803d", border:"#86efac" }, PVE:{ bg:"#fff7ed", text:"#c2410c", border:"#fdba74" } };

function ago(iso) {
  const d = Math.floor((Date.now()-new Date(iso))/1000);
  if(d<60)    return `${d}s ago`;
  if(d<3600)  return `${Math.floor(d/60)}m ago`;
  if(d<86400) return `${Math.floor(d/3600)}h ago`;
  return `${Math.floor(d/86400)}d ago`;
}
function validateName(n) {
  if(!n)                                            return "Required";
  if(!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(n)) return "Lowercase, numbers, hyphens only";
  if(n.length<3)                                    return "Min 3 characters";
  if(n.length>52)                                   return "Max 52 characters";
  return null;
}
function validateCidr(v) {
  if(!v) return null;
  if(!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(v)) return "Invalid CIDR e.g. 192.0.2.10/24";
  return null;
}

// ─────────────────────────────────────────────────────────────
//  UI COMPONENTS
// ─────────────────────────────────────────────────────────────
function Badge({ status }) {
  const c = S[status]||S.cancelled;
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:4, padding:"3px 10px",
      borderRadius:99, fontSize:11, fontWeight:600, letterSpacing:0.3,
      textTransform:"uppercase", fontFamily:"monospace",
      background:c.bg, color:c.text, border:`1px solid ${c.border}` }}>
      <span style={{ display:"inline-block", animation:status==="running"?"spin 1s linear infinite":"none" }}>
        {SICON[status]||"?"}
      </span>
      {status}
    </span>
  );
}

function DcTag({ dc }) {
  const c = DC[dc]||{ bg:"#f9fafb", text:"#374151", border:"#e5e7eb" };
  return (
    <span style={{ fontSize:11, padding:"2px 8px", borderRadius:5, fontWeight:700,
      fontFamily:"monospace", letterSpacing:0.5,
      background:c.bg, color:c.text, border:`1px solid ${c.border}` }}>
      {dc}
    </span>
  );
}

function Lbl({ t }) {
  return <div style={{ fontSize:11, color:"#9ca3af", textTransform:"uppercase",
    letterSpacing:0.7, marginBottom:5, fontFamily:"monospace" }}>{t}</div>;
}

function Field({ label, value, onChange, placeholder, error, hint, mono }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <Lbl t={label} />}
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        style={{ width:"100%", background:"#ffffff", color:"#111827", fontSize:13,
          border:`1.5px solid ${error?"#f87171":"#e5e7eb"}`,
          borderRadius:7, padding:"9px 12px", outline:"none", boxSizing:"border-box",
          fontFamily:mono?"'JetBrains Mono',monospace":"'Inter',sans-serif",
          boxShadow:"0 1px 2px rgba(0,0,0,0.05)", transition:"border-color 0.15s" }} />
      {error && <p style={{ margin:"4px 0 0", fontSize:11, color:"#ef4444" }}>{error}</p>}
      {hint&&!error && <p style={{ margin:"4px 0 0", fontSize:11, color:"#9ca3af" }}>{hint}</p>}
    </div>
  );
}

function Pick({ label, value, onChange, options, error, disabled }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <Lbl t={label} />}
      <div style={{ position:"relative" }}>
        <select value={value} onChange={e=>onChange(e.target.value)} disabled={disabled}
          style={{ width:"100%", background:"#ffffff", color:"#111827", fontSize:13,
            border:`1.5px solid ${error?"#f87171":"#e5e7eb"}`,
            borderRadius:7, padding:"9px 32px 9px 12px", outline:"none",
            appearance:"none", cursor:disabled?"not-allowed":"pointer", fontFamily:"'Inter',sans-serif",
            boxShadow:"0 1px 2px rgba(0,0,0,0.05)", opacity:disabled?0.65:1 }}>
          {options.map(o=><option key={o} value={o}>{o||"— none —"}</option>)}
        </select>
        <span style={{ position:"absolute", right:11, top:"50%", transform:"translateY(-50%)",
          pointerEvents:"none", color:"#9ca3af", fontSize:11 }}>▾</span>
      </div>
      {error && <p style={{ margin:"4px 0 0", fontSize:11, color:"#ef4444" }}>{error}</p>}
    </div>
  );
}

function SearchPick({ label, value, onChange, options, disabled, error }) {
  const [open,  setOpen]  = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQuery(""); }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = options.filter(o =>
    !query || o.toLowerCase().includes(query.toLowerCase())
  );

  // Highlight matching substring
  function highlight(text, q) {
    if (!q) return text || "— none —";
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark style={{ background:"#fef08a", color:"inherit", borderRadius:2 }}>
          {text.slice(idx, idx + q.length)}
        </mark>
        {text.slice(idx + q.length)}
      </>
    );
  }

  return (
    <div style={{ marginBottom:14, position:"relative" }} ref={ref}>
      {label && <Lbl t={label} />}
      {/* Trigger button */}
      <div onClick={() => { if (!disabled) { setOpen(o => !o); setQuery(""); } }}
        style={{ width:"100%", background:"#ffffff", color: value ? "#111827" : "#9ca3af",
          fontSize:13, border:`1.5px solid ${error?"#f87171": open?"#93c5fd":"#e5e7eb"}`,
          borderRadius:7, padding:"9px 32px 9px 12px", cursor:disabled?"not-allowed":"pointer",
          fontFamily:"'Inter',sans-serif", opacity:disabled?0.65:1, userSelect:"none",
          boxShadow: open ? "0 0 0 3px rgba(147,197,253,0.35)" : "0 1px 2px rgba(0,0,0,0.05)",
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
        {value || "— none —"}
      </div>
      <span style={{ position:"absolute", right:11, top: label ? "calc(50% + 11px)" : "50%",
        transform:"translateY(-50%)", pointerEvents:"none", color:"#9ca3af", fontSize:11 }}>▾</span>

      {/* Dropdown */}
      {open && (
        <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, zIndex:200,
          background:"#ffffff", border:"1.5px solid #93c5fd", borderRadius:8,
          boxShadow:"0 8px 24px rgba(0,0,0,0.14)", overflow:"hidden" }}>
          <div style={{ padding:"7px 8px", borderBottom:"1px solid #e5e7eb" }}>
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Type to filter…"
              style={{ width:"100%", border:"1px solid #e5e7eb", borderRadius:5,
                padding:"5px 10px", fontSize:12, outline:"none", color:"#111827",
                fontFamily:"'Inter',sans-serif" }} />
          </div>
          <div style={{ maxHeight:220, overflowY:"auto" }}>
            {filtered.length === 0 ? (
              <div style={{ padding:"10px 14px", fontSize:12, color:"#9ca3af" }}>No matches</div>
            ) : filtered.map(o => (
              <div key={o} onClick={() => { onChange(o); setOpen(false); setQuery(""); }}
                style={{ padding:"8px 14px", fontSize:13, cursor:"pointer",
                  color: o === value ? "#1d4ed8" : "#111827",
                  background: o === value ? "#eff6ff" : "transparent",
                  fontFamily:"'Inter',sans-serif" }}
                onMouseEnter={e => { if (o !== value) e.currentTarget.style.background = "#f9fafb"; }}
                onMouseLeave={e => { if (o !== value) e.currentTarget.style.background = "transparent"; }}>
                {highlight(o || "", query)}
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <p style={{ margin:"4px 0 0", fontSize:11, color:"#ef4444" }}>{error}</p>}
    </div>
  );
}

function PickOrType({ label, value, onChange, options, unit = "" }) {
  const [manual, setManual] = useState(false);
  const [raw, setRaw] = useState(String(value));

  // keep raw in sync if parent value changes externally
  useEffect(() => {
    setRaw(String(value));
  }, [value]);

  return (
    <div style={{ marginBottom: 14 }}>
      {label && <Lbl t={label} />}
      <div style={{ display: "flex", gap: 6 }}>
        {!manual ? (
          <div style={{ position: "relative", flex: 1 }}>
            <select
              value={value}
              onChange={e => onChange(+e.target.value)}
              style={{
                width: "100%", background: "#ffffff", color: "#111827", fontSize: 13,
                border: "1.5px solid #e5e7eb", borderRadius: 7,
                padding: "9px 32px 9px 12px", outline: "none",
                appearance: "none", cursor: "pointer", fontFamily: "'Inter',sans-serif",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
              }}>
              {options.map(o => (
                <option key={o} value={o}>{o}{unit ? ` ${unit}` : ""}</option>
              ))}
            </select>
            <span style={{
              position: "absolute", right: 11, top: "50%",
              transform: "translateY(-50%)", pointerEvents: "none",
              color: "#9ca3af", fontSize: 11,
            }}>▾</span>
          </div>
        ) : (
          <input
            type="text"
            inputMode="numeric"
            value={raw}
            onChange={e => {
              const v = e.target.value;
              // allow empty string or digits only while typing
              if (v === "" || /^\d+$/.test(v)) {
                setRaw(v);
                if (v !== "") onChange(+v);
              }
            }}
            onBlur={() => {
              // on blur, if empty or 0 reset to 1
              if (!raw || +raw === 0) {
                setRaw("1");
                onChange(1);
              }
            }}
            style={{
              flex: 1, background: "#ffffff", color: "#111827", fontSize: 13,
              border: "1.5px solid #93c5fd", borderRadius: 7, padding: "9px 12px",
              outline: "none", fontFamily: "'JetBrains Mono',monospace",
              boxShadow: "0 0 0 3px rgba(147,197,253,0.35)",
            }}
          />
        )}
        <button
          onClick={() => {
            setManual(m => !m);
            setRaw(String(value));
          }}
          title={manual ? "Switch to dropdown" : "Type custom value"}
          style={{
            padding: "0 12px", borderRadius: 7, cursor: "pointer", fontSize: 12,
            border: "1.5px solid #e5e7eb", fontFamily: "'Inter',sans-serif",
            background:  manual ? "#eff6ff" : "#f9fafb",
            color:       manual ? "#2563eb" : "#6b7280",
            borderColor: manual ? "#bfdbfe" : "#e5e7eb",
            fontWeight: 600, whiteSpace: "nowrap", transition: "all 0.15s",
          }}>
          {manual ? "↩ Preset" : "✎ Custom"}
        </button>
      </div>
      {manual && (
        <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>
          Enter any value — will be passed directly to Terraform
        </p>
      )}
    </div>
  );
}


// Disk list editor. Row 0 is the OS disk (size only); every further row is a
// data disk and drives one fs_setup + one mounts entry in the cloud-init, so
// the Terraform disk list and the guest filesystem layout cannot drift apart.
function DiskRows({ disks, onChange, error }) {
  const set = (i, patch) => onChange(disks.map((d, idx) => idx === i ? { ...d, ...patch } : d));
  const add = ()         => onChange([...disks, { size:50, mount:"", label:"", fs:DEFAULT_FS }]);
  const del = i          => onChange(disks.filter((_, idx) => idx !== i));

  const inp = extra => ({ width:"100%", background:"#ffffff", color:"#111827", fontSize:12,
    border:"1.5px solid #e5e7eb", borderRadius:6, padding:"7px 10px", outline:"none",
    boxSizing:"border-box", fontFamily:"'JetBrains Mono',monospace", ...extra });

  const sizeInput = (i, d) => (
    <input value={String(d.size)} inputMode="numeric" placeholder="GB"
      onChange={e => { const v = e.target.value; if (v === "" || /^\d+$/.test(v)) set(i, { size:v }); }}
      style={inp({ textAlign:"right" })} />
  );

  const chip = txt => (
    <span style={{ fontSize:11, fontFamily:"'JetBrains Mono',monospace", color:"#64748b",
      background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:5,
      padding:"5px 8px", whiteSpace:"nowrap" }}>{txt}</span>
  );

  return (
    <div style={{ marginBottom:14 }}>
      <Lbl t="Disks" />

      {/* Root disk */}
      <div style={{ display:"grid", gridTemplateColumns:"90px 90px 1fr", gap:8,
        alignItems:"center", marginBottom:6 }}>
        {sizeInput(0, disks[0] ?? { size:20 })}
        {chip("/dev/sda")}
        <span style={{ fontSize:12, color:"#6b7280" }}>
          OS disk — mounted on <code>/</code>, grown automatically on first boot
        </span>
      </div>

      {/* Data disks */}
      {disks.slice(1).map((d, idx) => {
        const i = idx + 1;
        return (
          <div key={i} style={{ display:"grid",
            gridTemplateColumns:"90px 90px 1fr 130px 80px 28px", gap:8,
            alignItems:"center", marginBottom:6 }}>
            {sizeInput(i, d)}
            {chip(deviceFor(i))}
            <input value={d.mount} placeholder="/storage/disk01"
              onChange={e => set(i, { mount:e.target.value })} style={inp()} />
            <input value={d.label} placeholder="label"
              onChange={e => set(i, { label:e.target.value })} style={inp()} />
            <div style={{ position:"relative" }}>
              <select value={d.fs || DEFAULT_FS} onChange={e => set(i, { fs:e.target.value })}
                style={inp({ appearance:"none", cursor:"pointer", paddingRight:22 })}>
                {FS_CHOICES.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <span style={{ position:"absolute", right:7, top:"50%", transform:"translateY(-50%)",
                pointerEvents:"none", color:"#9ca3af", fontSize:10 }}>▾</span>
            </div>
            <button onClick={() => del(i)} title="Remove disk"
              style={{ width:26, height:26, borderRadius:5, background:"#fef2f2",
                border:"1px solid #fca5a5", color:"#b91c1c", cursor:"pointer",
                fontSize:12, lineHeight:1, padding:0 }}>✕</button>
          </div>
        );
      })}

      <button onClick={add}
        style={{ padding:"6px 14px", borderRadius:7, border:"1.5px dashed #cbd5e1",
          background:"#f8fafc", color:"#6b7280", fontSize:12, cursor:"pointer",
          fontFamily:"'Inter',sans-serif", marginTop:2 }}>
        + Add disk
      </button>

      {error && <p style={{ margin:"6px 0 0", fontSize:11, color:"#ef4444" }}>{error}</p>}
    </div>
  );
}

function Card({ n, title, children }) {
  return (
    <div style={{ background:"#ffffff", border:"1.5px solid #e5e7eb", borderRadius:12,
      padding:24, marginBottom:14, boxShadow:"0 1px 4px rgba(0,0,0,0.06)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:18 }}>
        <span style={{ width:24, height:24, borderRadius:6, background:"#eff6ff",
          color:"#2563eb", fontSize:12, fontWeight:700, display:"flex",
          alignItems:"center", justifyContent:"center" }}>{n}</span>
        <span style={{ fontSize:11, color:"#6b7280", textTransform:"uppercase",
          letterSpacing:1, fontFamily:"monospace" }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function Toasts({ list, del }) {
  return (
    <div style={{ position:"fixed", bottom:20, right:20, zIndex:999,
      display:"flex", flexDirection:"column", gap:8 }}>
      {list.map(t=>(
        <div key={t.id} onClick={()=>del(t.id)} style={{
          display:"flex", alignItems:"center", gap:10, padding:"12px 16px",
          cursor:"pointer", maxWidth:360, borderRadius:10,
          boxShadow:"0 4px 16px rgba(0,0,0,0.12)", animation:"slideIn 0.25s ease",
          background: t.type==="success"?"#f0fdf4":t.type==="error"?"#fef2f2":"#fffbeb",
          border:`1px solid ${t.type==="success"?"#86efac":t.type==="error"?"#fca5a5":"#fde68a"}`,
          color: t.type==="success"?"#15803d":t.type==="error"?"#b91c1c":"#92400e",
          fontSize:13, fontFamily:"'Inter',sans-serif",
        }}>
          <span style={{ fontSize:16 }}>{t.type==="success"?"✓":t.type==="error"?"✕":"ℹ"}</span>
          <span style={{ flex:1 }}>{t.msg}</span>
          <span style={{ color:"#9ca3af", fontSize:12 }}>✕</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  PIPELINE ROW
// ─────────────────────────────────────────────────────────────
function Row({ p }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr onClick={()=>setOpen(o=>!o)} style={{ cursor:"pointer", borderBottom:"1px solid #f3f4f6" }}
        onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"}
        onMouseLeave={e=>e.currentTarget.style.background="#ffffff"}>
        <td style={{ padding:"13px 16px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:13,
              fontWeight:500, color:"#111827" }}>{p.vmName}</span>
            {p.action === "resize" && (
              <span style={{ fontSize:10, padding:"1px 7px", borderRadius:5, fontWeight:700,
                background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe" }}>RESIZE</span>
            )}
            {p.action === "decommission" && (
              <span style={{ fontSize:10, padding:"1px 7px", borderRadius:5, fontWeight:700,
                background:"#fef2f2", color:"#b91c1c", border:"1px solid #fca5a5" }}>DELETE</span>
            )}
          </div>
          <div style={{ fontSize:10, color:"#d1d5db", marginTop:1 }}>#{p.id}</div>
        </td>
        <td style={{ padding:"13px 16px" }}><DcTag dc={p.datacenter} /></td>
        <td style={{ padding:"13px 16px" }}>
          <span style={{ fontSize:12, padding:"3px 9px", borderRadius:6,
            background:"#f3f4f6", color:"#374151", border:"1px solid #e5e7eb" }}>{p.team}</span>
        </td>
        <td style={{ padding:"13px 16px" }}>
          <span style={{ fontSize:11, padding:"2px 8px", borderRadius:5,
            background:"#f9fafb", color:"#6b7280", border:"1px solid #f0f0f0" }}>{p.env}</span>
        </td>
        <td style={{ padding:"13px 16px", fontSize:12, color:"#6b7280", fontFamily:"monospace" }}>
          {p.cpu}c / {p.ram}GB / [{p.disk}]GB
        </td>
        <td style={{ padding:"13px 16px" }}><Badge status={p.status} /></td>
        <td style={{ padding:"13px 16px", fontSize:12, color:"#6b7280" }}>
          <div style={{ color:"#374151", fontWeight:500 }}>{p.createdBy}</div>
          <div style={{ fontSize:11, color:"#9ca3af" }}>{ago(p.createdAt)}</div>
        </td>
        <td style={{ padding:"13px 16px", fontSize:12, color:"#9ca3af" }}>{open?"▲":"▼"}</td>
      </tr>
      {open && (
        <tr style={{ background:"#f9fafb" }}>
          <td colSpan={8} style={{ padding:"16px 20px", borderBottom:"1px solid #f3f4f6" }}>
            <div style={{ display:"flex", gap:20, flexWrap:"wrap", marginBottom:14 }}>
              {[["Commit",p.vmName],["Pipeline",`#${p.id}`],["DC",p.datacenter],
                ["OS",p.os],["CPU",`${p.cpu}c`],["RAM",`${p.ram}GB`],["Disk",`${p.disk}GB`],
                ["Team",p.team],["Env",p.env],["By",p.createdBy],
                ["At",new Date(p.createdAt).toLocaleString()]
              ].map(([k,v])=>(
                <div key={k}>
                  <div style={{ fontSize:9, color:"#9ca3af", textTransform:"uppercase",
                    letterSpacing:1, fontFamily:"monospace", marginBottom:2 }}>{k}</div>
                  <div style={{ fontSize:12, color:"#374151", fontFamily:"monospace" }}>{v}</div>
                </div>
              ))}
            </div>
            {p.webUrl && (
              <a href={p.webUrl} target="_blank" rel="noreferrer"
                style={{ fontSize:12, color:"#2563eb", textDecoration:"none",
                  padding:"5px 12px", borderRadius:6, display:"inline-block",
                  background:"#eff6ff", border:"1px solid #bfdbfe" }}>
                → View in GitLab
              </a>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
//  APP
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [view,       setView]       = useState("list");
  const [pipelines,  setPipelines]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [loadErr,    setLoadErr]    = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [toasts,     setToasts]     = useState([]);
  const [errors,     setErrors]     = useState({});
  const [filter,     setFilter]     = useState({ dc:"All", team:"All", status:"All", env:"All" });

  const [showNic2, setShowNic2] = useState(false);
  const [showNic3, setShowNic3] = useState(false);

  const [ciUsers, setCiUsers] = useState([]);
  const [newUser, setNewUser] = useState({ name:"", sudo:"NOPASSWD", shell:"/bin/bash", sshKey:"" });
  // Default admins with keys refreshed live from the SSH directory — the
  // bundled key in userdata.defaults.js is only a fallback, so a rotated or
  // revoked key in the SSH key directory takes effect without a portal rebuild.
  const [defaultUsers, setDefaultUsers] = useState(DEFAULT_CI_USERS);
  const [sshDir,  setSshDir]  = useState({ users:[], loading:true, error:null });
  const [sshQuery,    setSshQuery]    = useState("");
  const [sshKeyBusy,  setSshKeyBusy]  = useState(false);

  // ── Servers view (existing VMs) ──
  const [srvList,    setSrvList]    = useState({ items:[], loading:false, error:null, loaded:false });
  const [srvQuery,   setSrvQuery]   = useState("");
  const [srvSel,     setSrvSel]     = useState(null);   // selected folder name
  const [srvDetail,  setSrvDetail]  = useState(null);   // { loading, raw, parsed, error }
  const [srvEdit,    setSrvEdit]    = useState(null);   // { cpu, mem, disks:[n]|null, disksRaw }
  const [srvBusy,    setSrvBusy]    = useState(false);
  const [srvConfirm, setSrvConfirm] = useState("");     // typed name to confirm delete

  const [vcState, setVcState] = useState({
    clusters:   [],  // [{ id, name }]
    datastores: [],  // [{ id, name }]
    networks:   [],  // [{ id, name }]
    clusterMap: {},  // name → id
    loading:    false,
    error:      null,
  });

  // PVE inventory — starts as the static fallback, replaced by live data when
  // the /pveproxy/ nginx proxy is configured and reachable.
  const [pveState, setPveState] = useState({
    nodes: PVE_DEFAULTS.nodes,
    templates: PVE_DEFAULTS.templates,
    vnets: PVE_DEFAULTS.vnets,
    datastores: PVE_DEFAULTS.datastores,
    snippetsDatastores: [PVE_DEFAULTS.snippetsDatastore],
    loading: false, live: false, error: null,
  });

  const [form, setForm] = useState(() => {
    const dc1         = DATACENTER_DEFAULTS.DC1;
    const initialOs   = dc1.osTemplates[0];
    const initialProfile = "generic";
    const initialDisks   = defaultDisks(initialProfile, initialOs);
    const initialTags = syncTags(
      { team:TEAMS[0], env:ENVS[0], backup:"YES", service:"", profile:initialProfile },
      { team:"", env:"", backup:"", service:"", profile:initialProfile },
      "",
    );
    return {
      vmName:"", team:TEAMS[0], env:ENVS[0],
      backup:"YES", service:"",
      datacenter:"DC1", domain:dc1.domain,
      cluster:"", datastoreCluster:"", folder:dc1.folder,
      os:initialOs, network1:"", network2:"", network3:"",
      gateway:"", ipCidr:"", ipCidr2:"", ipCidr3:"",
      dns1:dc1.dns1, dns2:dc1.dns2,
      dnsNic2:"", dnsNic3:"",
      tags:initialTags,
      cpu:4, ram:4,
      satelliteHostgroup:"", satelliteHostCollection:"",
      node:"", cloneVmId:null, pveEndpoint:PVE_ENDPOINTS[0].key,
      pveDatastore:PVE_DEFAULTS.datastores[0], snippetsDatastore:PVE_DEFAULTS.snippetsDatastore,
      profile:initialProfile, pgVersion:PG_DEFAULT_VERSION,
      disks:initialDisks,
      userData:renderUserData(initialOs, [], { disks:initialDisks, profile:initialProfile, pgVersion:PG_DEFAULT_VERSION }),
    };
  });

  const toast    = useCallback((msg, type="info") => {
    const id = Date.now();
    setToasts(t=>[...t,{id,msg,type}]);
    setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)), 5000);
  },[]);
  const delToast = useCallback(id=>setToasts(t=>t.filter(x=>x.id!==id)),[]);

  const refresh = useCallback((silent=false) => {
    if(!silent) setLoading(true);
    loadPipelines()
      .then(d=>{ setPipelines(d); setLoading(false); setLoadErr(null); })
      .catch(e=>{ setLoadErr(e.message); setLoading(false); });
  },[]);

  useEffect(()=>{ refresh(); },[refresh]);
  useEffect(()=>{ const t=setInterval(()=>refresh(true),30000); return ()=>clearInterval(t); },[refresh]);

  useEffect(()=>{
    fetchSshUsers()
      .then(users => setSshDir({ users, loading:false, error:null }))
      .catch(e    => setSshDir({ users:[], loading:false, error:e.message }));
  },[]);

  // Refresh default-admin SSH keys from the directory; keep the bundled key
  // for anyone whose file is missing or unreachable.
  useEffect(()=>{
    (async () => {
      const refreshed = await Promise.all(DEFAULT_CI_USERS.map(async u => {
        try { return { ...u, sshKey: await fetchSshKey(`${u.name}.pub`) }; }
        catch { return u; }
      }));
      setDefaultUsers(refreshed);
    })();
  },[]);

  // Changing the OS template — directly, or by switching datacenter — can
  // invalidate the selected profile (PostgreSQL is RHEL-only) and always resets
  // the disk layout to that profile's default for the new OS.
  const osPatch = useCallback((f, newOs) => {
    const profile = profileSupportsOs(f.profile, newOs) ? f.profile : "generic";
    const tags    = profile === f.profile
      ? f.tags
      : syncTags({ ...f, profile }, f, f.tags);
    return { os:newOs, profile, tags, disks:defaultDisks(profile, newOs) };
  }, []);

  const loadVcForDc = useCallback(async (dc) => {
    const d     = DATACENTER_DEFAULTS[dc];
    const newOs = d.osTemplates[0];

    setForm(f => ({ ...f, datacenter:dc, folder:d.folder,
      cluster:"", datastoreCluster:"", network1:"", network2:"", network3:"",
      gateway:"", ipCidr:"", ipCidr2:"", ipCidr3:"",
      dns1:d.dns1, dns2:d.dns2,
      ...osPatch(f, newOs),
    }));
    setVcState(s => ({ ...s, loading:true, error:null, clusters:[], datastores:[], networks:[], clusterMap:{} }));

    try {
      const clusters   = await fetchVcClusters(dc);
      const clusterMap = Object.fromEntries(clusters.map(c => [c.name, c.id]));
      let datastores = [], networks = [], firstCluster = "";

      if (clusters.length > 0) {
        firstCluster = clusters[0].name;
        [datastores, networks] = await Promise.all([
          fetchVcDatastoreClusters(dc, clusters[0].id, clusters[0].name),
          fetchVcNetworks(dc, clusters[0].id),
        ]);
      }

      setVcState(s => ({ ...s, loading:false, clusters, datastores, networks, clusterMap }));

      const firstDs  = datastores[0]?.name || "";
      const firstNet = networks[0]?.name   || "";
      const firstCidr = networks.find(n => n.name === firstNet)?.cidr || VLAN_MAP[dc]?.[firstNet]?.ipPrefix || "";
      const firstGw   = VLAN_MAP[dc]?.[firstNet]?.gateway || firstCidr.replace(/\.\d+\/\d+$/, ".1");
      setForm(f => ({ ...f, cluster:firstCluster, datastoreCluster:firstDs,
        network1:firstNet, gateway:firstGw, ipCidr:firstCidr,
      }));
    } catch(e) {
      setVcState(s => ({ ...s, loading:false, error:e.message }));
      toast(`vCenter (${dc}): ${e.message}`, "error");
    }
  }, [toast, osPatch]);

  const loadPveTarget = useCallback(async (endpointKey = PVE_ENDPOINTS[0].key) => {
    // static fallback first so the form is instantly usable
    let inv = {
      nodes: PVE_DEFAULTS.nodes, templates: PVE_DEFAULTS.templates,
      vnets: PVE_DEFAULTS.vnets, datastores: PVE_DEFAULTS.datastores,
      snippetsDatastores: [PVE_DEFAULTS.snippetsDatastore],
    };
    setPveState(s => ({ ...s, loading: true, error: null }));
    let live = false;
    try {
      const fetched = await fetchPveInventory(endpointKey);
      if (fetched.nodes.length) {
        inv = {
          ...fetched,
          vnets: fetched.vnets.length ? fetched.vnets : PVE_DEFAULTS.vnets,
          datastores: fetched.datastores.length ? fetched.datastores : PVE_DEFAULTS.datastores,
          snippetsDatastores: fetched.snippetsDatastores.length ? fetched.snippetsDatastores : [PVE_DEFAULTS.snippetsDatastore],
        };
        live = true;
      }
    } catch (e) {
      // proxy not configured / unreachable — stay on the static fallback
      console.warn("PVE inventory unavailable, using static defaults:", e.message);
    }
    setPveState({ ...inv, loading: false, live, error: null });

    const tpl      = inv.templates[0];
    const firstNet = inv.vnets[0] || "";
    const net      = PVE_NET_MAP[firstNet] || {};
    setForm(f => ({ ...f,
      datacenter: "PVE", pveEndpoint: endpointKey, domain: PVE_DEFAULTS.domain,
      dns1: PVE_DEFAULTS.dns1, dns2: PVE_DEFAULTS.dns2,
      cluster: "", datastoreCluster: "", folder: "",
      node: inv.nodes[0] || "",
      cloneVmId: tpl?.vmid ?? null,
      pveDatastore: inv.datastores[0],
      snippetsDatastore: inv.snippetsDatastores[0],
      network1: firstNet, network2: "", network3: "",
      gateway: net.gateway || "", ipCidr: net.cidr || "", ipCidr2: "", ipCidr3: "",
      ...osPatch(f, tpl ? pveTplDisplay(tpl) : "ubuntu24"),
    }));
  }, [osPatch]);

  const switchDc = dc => (dc === "PVE" ? loadPveTarget(form.pveEndpoint) : loadVcForDc(dc));

  // Load clusters/datastores/networks from vCenter on mount
  useEffect(()=>{ loadVcForDc("DC1"); },[loadVcForDc]);

  // Single regeneration path for user-data: anything the templates read is a
  // dependency here, so no handler needs to rebuild the cloud-init itself.
  // Hand-edits to the textarea are overwritten when one of these changes.
  useEffect(() => {
    setForm(f => ({ ...f, userData: renderUserData(f.os, ciUsers, userDataOpts(f, showNic2, showNic3), defaultUsers) }));
  }, [showNic2, showNic3, form.ipCidr2, form.ipCidr3, form.gateway,
      form.os, form.disks, form.profile, form.pgVersion, ciUsers, defaultUsers]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCluster = async v => {
    setForm(f => ({ ...f, cluster:v, datastoreCluster:"", network1:"", network2:"", network3:"" }));
    setVcState(s => ({ ...s, loading:true, datastores:[], networks:[] }));
    try {
      const clusterId = vcState.clusterMap[v];
      if (!clusterId) throw new Error("cluster ID not found");
      const [datastores, networks] = await Promise.all([
        fetchVcDatastoreClusters(form.datacenter, clusterId, v),
        fetchVcNetworks(form.datacenter, clusterId),
      ]);
      setVcState(s => ({ ...s, loading:false, datastores, networks }));
      const firstDs  = datastores[0]?.name || "";
      const firstNet = networks[0]?.name   || "";
      const firstCidr = networks.find(n => n.name === firstNet)?.cidr || VLAN_MAP[form.datacenter]?.[firstNet]?.ipPrefix || "";
      const firstGw   = VLAN_MAP[form.datacenter]?.[firstNet]?.gateway || firstCidr.replace(/\.\d+\/\d+$/, ".1");
      setForm(f => ({ ...f, datastoreCluster:firstDs,
        network1:firstNet, gateway:firstGw, ipCidr:firstCidr,
        network2:"", network3:"", ipCidr2:"", ipCidr3:"",
      }));
    } catch(e) {
      setVcState(s => ({ ...s, loading:false, error:e.message }));
      toast(`vCenter: ${e.message}`, "error");
    }
  };

  function cidrFromNet(name) {
    // Prefer live vCenter description; fall back to static VLAN_MAP
    return netCidr[name] || NET_HINTS[name]?.ipPrefix || NET_HINTS[name]?.cidr || "";
  }
  function gatewayFromCidr(cidr) {
    if (!cidr) return "";
    const base = cidr.split("/")[0];                        // e.g. "192.0.2.0/24"
    return base.replace(/\.\d+$/, ".1");                    // → "192.0.2.0/24"
  }

  const onNet1 = v => {
    const cidr = cidrFromNet(v);
    const gw   = NET_HINTS[v]?.gateway || gatewayFromCidr(cidr);
    setForm(f => ({ ...f, network1:v, gateway:gw, ipCidr:cidr }));
  };
  const onNet2 = v => {
    const cidr = v ? cidrFromNet(v) : "";
    setForm(f => ({ ...f, network2:v, ipCidr2:cidr }));
  };
  const onNet3 = v => {
    const cidr = v ? cidrFromNet(v) : "";
    setForm(f => ({ ...f, network3:v, ipCidr3:cidr }));
  };

  // ── Servers view handlers ──
  const reloadServers = useCallback(() => {
    setSrvList(s => ({ ...s, loading:true, error:null }));
    fetchServerFolders()
      .then(items => setSrvList({ items, loading:false, error:null, loaded:true }))
      .catch(e    => setSrvList({ items:[], loading:false, error:e.message, loaded:true }));
  }, []);

  useEffect(() => {
    if (view === "servers" && !srvList.loaded && !srvList.loading) reloadServers();
  }, [view, srvList.loaded, srvList.loading, reloadServers]);

  const selectServer = useCallback(async (name) => {
    setSrvSel(name); setSrvConfirm(""); setSrvEdit(null);
    setSrvDetail({ loading:true });
    try {
      const raw    = await fetchRawFile(`${SERVERS_DIR}/${name}/parameters.auto.tfvars`);
      const parsed = parseTfvars(raw);
      setSrvDetail({ loading:false, raw, parsed });
      setSrvEdit({
        cpu: parsed.cpu ?? 2, mem: parsed.mem ?? 4,
        disks: parsed.disksNumeric ? [...parsed.disksNumeric] : null,
        disksRaw: parsed.disksText,
      });
    } catch (e) {
      // folder without parameters.auto.tfvars — still allow delete
      setSrvDetail({ loading:false, error:e.message });
    }
  }, []);

  const saveResize = async () => {
    if (!srvDetail?.raw || !srvEdit) return;
    setSrvBusy(true);
    try {
      const disksText = srvEdit.disks ? `[${srvEdit.disks.join(", ")}]` : srvEdit.disksRaw;
      const newRaw = updateTfvars(srvDetail.raw, { cpu:srvEdit.cpu, mem:srvEdit.mem, disksText });
      const c = await commitResize(srvSel, newRaw, srvDetail.parsed, srvEdit);
      toast(`Committed ${c.short_id} — review the plan, then approve apply in GitLab`, "success");
      setTimeout(() => refresh(true), 4000);
      selectServer(srvSel);
    } catch (e) {
      toast(`Resize failed: ${e.message}`, "error");
    } finally {
      setSrvBusy(false);
    }
  };

  const deleteServer = async () => {
    if (srvConfirm !== srvSel) return;
    setSrvBusy(true);
    try {
      const target = await decommissionVm(srvSel, srvDetail?.parsed);
      toast(`${srvSel} moved to deleted/${target} — approve the destroy step in GitLab to remove the VM`, "success");
      setSrvSel(null); setSrvDetail(null); setSrvEdit(null); setSrvConfirm("");
      reloadServers();
      setTimeout(() => refresh(true), 4000);
    } catch (e) {
      toast(`Delete failed: ${e.message}`, "error");
    } finally {
      setSrvBusy(false);
    }
  };

  // Switching role swaps in that role's default disk layout and re-syncs the
  // tags it owns (PostgreSQL brings FirstDiskOnly).
  const onProfile = id => setForm(f => ({
    ...f,
    profile: id,
    disks:   defaultDisks(id, f.os),
    tags:    syncTags({ ...f, profile:id }, f, f.tags),
  }));

  const sf = k => v => setForm(f=>({...f,[k]:v}));

  const validate = () => {
    const e={};
    const ne=validateName(form.vmName); if(ne) e.vmName=ne;
    const ce=validateCidr(form.ipCidr); if(ce) e.ipCidr=ce;
    const de=validateDisks(form.disks); if(de) e.disks=de;
    if(!form.gateway)        e.gateway = "Required";
    if(!form.service.trim()) e.service = "Service name is required";
    if(form.profile === "postgresql" && !pgSupported(form.pgVersion, elMajorOf(form.os)))
      e.pgVersion = `No verified Satellite repo labels for PostgreSQL ${form.pgVersion} on this OS`;
    if(form.datacenter === "PVE") {
      if(!MODULE_VERSION_PVE) e.vmName = "MODULE_VERSION_PVE is not configured — publish proxmox-clone-vm on the main channel and set it in gitlab.env";
      if(!form.cloneVmId)     e.vmName = e.vmName || "No PVE template selected (clone_vm_id missing)";
      if(!form.node)          e.vmName = e.vmName || "No PVE node selected";
    }
    setErrors(e);
    return Object.keys(e).length===0;
  };

  const submit = async () => {
    if(!validate()) return;
    setSubmitting(true);
    try {
      const c = await commitVmFiles(form);
      toast(`Committed ${c.short_id} — pipeline starting`, "success");
      setTimeout(()=>refresh(true), 4000);
      setView("list");
    } catch(e) {
      toast(`Error: ${e.message}`, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = pipelines.filter(p=>
    (filter.dc    ==="All"||p.datacenter===filter.dc)     &&
    (filter.team  ==="All"||p.team      ===filter.team)   &&
    (filter.status==="All"||p.status    ===filter.status) &&
    (filter.env   ==="All"||p.env       ===filter.env)
  );

  const stats = {
    total:   pipelines.length,
    running: pipelines.filter(p=>["running","created","pending"].includes(p.status)).length,
    success: pipelines.filter(p=>p.status==="success").length,
    failed:  pipelines.filter(p=>p.status==="failed").length,
  };

  const availableProfiles = profilesForOs(form.os);
  const pgOk = pgSupported(form.pgVersion, elMajorOf(form.os));
  const isRhel = osFamilyOf(form.os) === "rhel";
  const isPveTarget = form.datacenter === "PVE";
  // gateway/CIDR prefill source for the selected target
  const NET_HINTS = isPveTarget ? PVE_NET_MAP : (VLAN_MAP[form.datacenter] || {});

  const nets    = isPveTarget ? pveState.vnets : vcState.networks.map(n => n.name);
  const netCidr = Object.fromEntries(vcState.networks.map(n => [n.name, n.cidr]));
  const netsLoading = isPveTarget ? pveState.loading : vcState.loading;
  const oses = isPveTarget
    ? pveState.templates.map(pveTplDisplay)
    : DATACENTER_DEFAULTS[form.datacenter].osTemplates;

  return (
    <>
      <style>{`
        /* No external font CDN — internal portal must not call out to the
           internet. 'Inter'/'JetBrains Mono' are used when installed locally;
           every rule already falls back to system sans-serif/monospace. */
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        html, body { background:#f1f5f9 !important; color:#111827; }
        @keyframes spin    { to { transform:rotate(360deg); } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        @keyframes slideIn { from { opacity:0; transform:translateX(12px); } to { opacity:1; transform:translateX(0); } }
        ::-webkit-scrollbar { width:6px; }
        ::-webkit-scrollbar-track { background:#f1f5f9; }
        ::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:3px; }
        select option { background:#ffffff; color:#111827; }
        input::placeholder, textarea::placeholder { color:#d1d5db; }
        input:focus, select:focus, textarea:focus {
          border-color:#93c5fd !important;
          box-shadow: 0 0 0 3px rgba(147,197,253,0.35) !important;
          outline:none;
        }
      `}</style>

      <div style={{ minHeight:"100vh", background:"#f1f5f9", fontFamily:"'Inter',sans-serif", color:"#111827" }}>

        {/* ── NAV ── */}
        <nav style={{ background:"#ffffff", borderBottom:"1px solid #e5e7eb",
          padding:"0 28px", position:"sticky", top:0, zIndex:50,
          boxShadow:"0 1px 3px rgba(0,0,0,0.07)" }}>
          <div style={{ maxWidth:1280, margin:"0 auto", height:58,
            display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:34, height:34, borderRadius:9, background:"#2563eb",
                display:"flex", alignItems:"center", justifyContent:"center",
                color:"#ffffff", fontSize:16, boxShadow:"0 2px 8px rgba(37,99,235,0.35)" }}>⬡</div>
              <div>
                <div style={{ fontSize:15, fontWeight:700, color:"#111827", letterSpacing:-0.3 }}>VM Portal</div>
                <div style={{ fontSize:9, color:"#9ca3af", fontFamily:"'JetBrains Mono',monospace",
                  letterSpacing:1.5, textTransform:"uppercase" }}>vSphere · Proxmox · Terraform · GitLab</div>
              </div>
            </div>
            <div style={{ display:"flex", gap:6, alignItems:"center" }}>
              <button onClick={()=>refresh()} title="Refresh pipelines"
                style={{ width:34, height:34, borderRadius:7, background:"#f9fafb",
                  border:"1px solid #e5e7eb", color:"#6b7280", cursor:"pointer",
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>
                <span style={{ display:"inline-block", animation:loading?"spin 1s linear infinite":"none" }}>⟳</span>
              </button>
              {[["list","☰  Latest Pipelines"],["create","＋  New VM"],["servers","▤  Servers"]].map(([v,lbl])=>(
                <button key={v} onClick={()=>setView(v)} style={{
                  padding:"8px 16px", borderRadius:7, fontSize:13, fontWeight:500,
                  cursor:"pointer", fontFamily:"'Inter',sans-serif", transition:"all 0.15s",
                  background: view===v ? "#eff6ff" : "transparent",
                  border:     view===v ? "1px solid #bfdbfe" : "1px solid transparent",
                  color:      view===v ? "#1d4ed8" : "#6b7280",
                }}>{lbl}</button>
              ))}
            </div>
          </div>
        </nav>

        <main style={{ maxWidth:1280, margin:"0 auto", padding:"28px", animation:"fadeUp 0.3s ease" }}>

          {/* ── STATS ── */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:24 }}>
            {[
              ["Latest Pipelines", stats.total,   "#1d4ed8","#eff6ff","#bfdbfe"],
              ["Running",          stats.running, "#b45309","#fffbeb","#fcd34d"],
              ["Successful",       stats.success, "#15803d","#f0fdf4","#86efac"],
              ["Failed",           stats.failed,  "#b91c1c","#fef2f2","#fca5a5"],
            ].map(([lbl,val,tc,bg,bc])=>(
              <div key={lbl} style={{ background:bg, border:`1px solid ${bc}`,
                borderRadius:12, padding:"16px 20px", boxShadow:"0 1px 3px rgba(0,0,0,0.05)" }}>
                <div style={{ fontSize:11, color:tc, fontFamily:"monospace",
                  textTransform:"uppercase", letterSpacing:1, marginBottom:6, opacity:0.7 }}>{lbl}</div>
                <div style={{ fontSize:30, fontWeight:700, color:tc }}>{val}</div>
              </div>
            ))}
          </div>

          {/* ── LIST ── */}
          {view==="list" && (
            <div style={{ animation:"fadeUp 0.2s ease" }}>
              {loadErr && (
                <div style={{ marginBottom:14, padding:"12px 16px", borderRadius:9,
                  background:"#fef2f2", border:"1px solid #fca5a5", color:"#b91c1c",
                  fontSize:13, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span>Failed to load: {loadErr}</span>
                  <button onClick={()=>refresh()}
                    style={{ padding:"4px 12px", borderRadius:6, cursor:"pointer",
                      background:"#ffffff", border:"1px solid #fca5a5", color:"#b91c1c", fontSize:12 }}>
                    Retry
                  </button>
                </div>
              )}

              {/* filter bar */}
              <div style={{ background:"#ffffff", border:"1px solid #e5e7eb", borderRadius:10,
                padding:"12px 16px", marginBottom:14, boxShadow:"0 1px 3px rgba(0,0,0,0.05)",
                display:"flex", gap:12, flexWrap:"wrap", alignItems:"center" }}>
                <span style={{ fontSize:12, color:"#9ca3af" }}>Filter by</span>
                {[
                  ["DC",     ["All","DC1","DC2","PVE"],                               filter.dc,     v=>setFilter(f=>({...f,dc:v}))],
                  ["Team",   ["All",...TEAMS],                                         filter.team,   v=>setFilter(f=>({...f,team:v}))],
                  ["Status", ["All","success","running","failed","pending","created"], filter.status, v=>setFilter(f=>({...f,status:v}))],
                  ["Env",    ["All",...ENVS],                                          filter.env,    v=>setFilter(f=>({...f,env:v}))],
                ].map(([lbl,opts,val,setter])=>(
                  <div key={lbl} style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:11, color:"#9ca3af", fontFamily:"monospace",
                      textTransform:"uppercase", letterSpacing:0.5 }}>{lbl}</span>
                    <div style={{ position:"relative" }}>
                      <select value={val} onChange={e=>setter(e.target.value)} style={{
                        background:"#f9fafb", border:"1px solid #e5e7eb", borderRadius:6,
                        padding:"5px 28px 5px 10px", color:"#374151", fontSize:12,
                        fontFamily:"'Inter',sans-serif", appearance:"none", cursor:"pointer", outline:"none" }}>
                        {opts.map(o=><option key={o}>{o}</option>)}
                      </select>
                      <span style={{ position:"absolute", right:8, top:"50%",
                        transform:"translateY(-50%)", pointerEvents:"none", color:"#9ca3af", fontSize:10 }}>▾</span>
                    </div>
                  </div>
                ))}
                <span style={{ marginLeft:"auto", fontSize:12, color:"#9ca3af" }}>
                  {loading ? "loading…" : `${filtered.length} result${filtered.length!==1?"s":""}`}
                </span>
              </div>

              {/* table */}
              <div style={{ background:"#ffffff", border:"1px solid #e5e7eb", borderRadius:12,
                overflow:"hidden", boxShadow:"0 1px 4px rgba(0,0,0,0.06)" }}>
                <table style={{ width:"100%", borderCollapse:"collapse" }}>
                  <thead>
                    <tr style={{ background:"#f9fafb", borderBottom:"1px solid #e5e7eb" }}>
                      {["Commit","DC","Team","Env","Resources","Status","Created",""].map(h=>(
                        <th key={h} style={{ padding:"10px 16px", textAlign:"left", fontSize:11,
                          color:"#6b7280", fontWeight:600, textTransform:"uppercase", letterSpacing:0.5 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={8} style={{ padding:44, textAlign:"center", color:"#9ca3af", fontSize:13 }}>
                        <span style={{ display:"inline-block", animation:"spin 1s linear infinite", marginRight:8 }}>⟳</span>
                        Loading from GitLab…
                      </td></tr>
                    ) : filtered.length===0 ? (
                      <tr><td colSpan={8} style={{ padding:44, textAlign:"center", color:"#d1d5db", fontSize:13 }}>
                        {pipelines.length===0 ? "No pipelines found on vm-portal branch" : "No results match the current filters"}
                      </td></tr>
                    ) : filtered.map(p=><Row key={p.id} p={p} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── CREATE ── */}
          {view==="create" && (
            <div style={{ maxWidth:700, animation:"fadeUp 0.2s ease" }}>
              <div style={{ marginBottom:22 }}>
                <h2 style={{ fontSize:22, fontWeight:700, color:"#111827", letterSpacing:-0.4 }}>
                  New Virtual Machine
                </h2>
                <p style={{ fontSize:12, color:"#9ca3af", marginTop:5, fontFamily:"'JetBrains Mono',monospace" }}>
                  Commits to{" "}
                  <code style={{ background:"#eff6ff", color:"#2563eb", padding:"1px 6px", borderRadius:4 }}>
                    servers/{form.vmName||"vm-name"}/
                  </code>
                  {" "}→ GitLab CI → Terraform → {form.datacenter === "PVE" ? "Proxmox VE" : "vSphere"}
                </p>
              </div>

              {/* ① Identity */}
              <Card n="①" title="Identity">
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                  <div style={{ gridColumn:"1/-1" }}>
                    <Field label="VM Name" value={form.vmName} onChange={v => {
                      const parts  = v.split(".");
                      const domain = parts.length > 1 ? parts.slice(1).join(".") : form.domain;
                      setForm(f => ({ ...f, vmName:v, domain }));
                    }} placeholder="dc2-test-01" error={errors.vmName}
                      hint="Lowercase · hyphens · e.g. dc2-test-01" mono />
                  </div>
                  <Pick label="Team" value={form.team} onChange={v => {
                    setForm(f => ({ ...f, team:v, tags:syncTags({ ...f, team:v }, f, f.tags) }));
                  }} options={TEAMS} />
                  <Pick label="Environment" value={form.env} onChange={v => {
                    setForm(f => ({ ...f, env:v, tags:syncTags({ ...f, env:v }, f, f.tags) }));
                  }} options={ENVS} />
                </div>
              </Card>

              {/* ② Tags */}
              <Card n="②" title="Tags">
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                  <Pick label="Backup" value={form.backup} onChange={v => {
                    setForm(f => ({ ...f, backup:v, tags:syncTags({ ...f, backup:v }, f, f.tags) }));
                  }} options={["YES","NO"]} />
                  <Field label="Service *" value={form.service} onChange={v => {
                    setForm(f => ({ ...f, service:v, tags:syncTags({ ...f, service:v }, f, f.tags) }));
                  }} placeholder="e.g. payment-api" error={errors.service} />
                </div>
                <Field label="All Tags (comma separated — auto-managed)" value={form.tags} onChange={sf("tags")} mono />
              </Card>

              {/* ③ Datacenter */}
              <Card n="③" title="Datacenter">
                <div style={{ display:"flex", gap:10, marginBottom:18 }}>
                  {["DC1","DC2","PVE"].map(dc=>{
                    const a = form.datacenter===dc;
                    const c = DC[dc];
                    return (
                      <button key={dc} onClick={()=>switchDc(dc)} style={{
                        flex:1, padding:"14px", borderRadius:10, cursor:"pointer",
                        fontFamily:"'JetBrains Mono',monospace", fontSize:16, fontWeight:700,
                        transition:"all 0.15s",
                        background: a ? c.bg   : "#f9fafb",
                        border:     a ? `2px solid ${c.border}` : "2px solid #e5e7eb",
                        color:      a ? c.text : "#9ca3af",
                        boxShadow:  a ? `0 0 0 3px ${c.border}55` : "none",
                      }}>
                        {dc}
                        <div style={{ fontSize:10, fontWeight:400, marginTop:4,
                          color: a ? `${c.text}99` : "#d1d5db" }}>
                          {dc === "PVE" ? "proxmox ve" : `vsphere.${dc.toLowerCase()}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {!isPveTarget && vcState.error && (
                  <div style={{ marginBottom:12, padding:"8px 12px", borderRadius:7,
                    background:"#fef2f2", border:"1px solid #fca5a5", color:"#b91c1c", fontSize:12 }}>
                    vCenter error: {vcState.error}
                  </div>
                )}
                {isPveTarget && !pveState.live && !pveState.loading && (
                  <div style={{ marginBottom:12, padding:"8px 12px", borderRadius:7,
                    background:"#fffbeb", border:"1px solid #fde68a", color:"#92400e", fontSize:12 }}>
                    PVE API not reachable — showing static defaults (configure PVE_ENDPOINT +
                    PVE_API_TOKEN in gitlab.env for live nodes/templates/vnets).
                  </div>
                )}
                {isPveTarget ? (
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                    <div>
                      <Pick label="PVE Cluster"
                        value={form.pveEndpoint}
                        onChange={k => loadPveTarget(k)}
                        disabled={pveState.loading || PVE_ENDPOINTS.length === 1}
                        options={PVE_ENDPOINTS.map(e => e.key)} />
                      <div style={{ fontSize:11, color:"#2563eb", fontFamily:"monospace",
                        background:"#eff6ff", border:"1px solid #bfdbfe",
                        padding:"3px 8px", borderRadius:5, marginTop:-10, display:"inline-block" }}>
                        https://{pveEndpointHost(form.pveEndpoint)}/
                      </div>
                    </div>
                    <Pick label="Node"
                      value={form.node}
                      onChange={sf("node")}
                      disabled={pveState.loading}
                      options={pveState.loading ? ["Loading…"] : pveState.nodes} />
                    <Pick label="Disk Datastore"
                      value={form.pveDatastore}
                      onChange={sf("pveDatastore")}
                      disabled={pveState.loading}
                      options={pveState.loading ? ["Loading…"] : pveState.datastores} />
                    <Pick label="Snippets Datastore (cloud-init)"
                      value={form.snippetsDatastore}
                      onChange={sf("snippetsDatastore")}
                      options={pveState.snippetsDatastores} />
                    <Field label="Domain" value={form.domain} onChange={sf("domain")} />
                  </div>
                ) : (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                  <Pick label="Cluster"
                    value={form.cluster}
                    onChange={onCluster}
                    disabled={vcState.loading}
                    options={vcState.loading ? ["Loading…"] : vcState.clusters.map(c => c.name)} />
                  <Pick label="Datastore Cluster"
                    value={form.datastoreCluster}
                    onChange={sf("datastoreCluster")}
                    disabled={vcState.loading}
                    options={vcState.loading ? ["Loading…"] : vcState.datastores.map(d => d.name)} />
                  <Field label="Folder"  value={form.folder} onChange={sf("folder")} />
                  <Field label="Domain"  value={form.domain} onChange={sf("domain")} />
                </div>
                )}
              </Card>

              {/* ④ OS & Network */}
              <Card n="④" title="OS & Network">

                {/* OS Template */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:20 }}>
                  <Pick label={isPveTarget ? "PVE Template (clone source)" : "OS Template"}
                    value={form.os} onChange={v => {
                    // On PVE the template choice also fixes the clone vmid (and
                    // the node it lives on, for non-shared storage).
                    const tpl = isPveTarget ? pveState.templates.find(t => pveTplDisplay(t) === v) : null;
                    setForm(f => ({ ...f,
                      ...(tpl ? { cloneVmId: tpl.vmid, node: tpl.node || f.node } : {}),
                      ...osPatch(f, v),
                    }));
                  }} options={oses} />
                  {isPveTarget ? (
                    <div style={{ alignSelf:"end", marginBottom:14 }}>
                      <span style={{ fontSize:11, fontFamily:"monospace", padding:"5px 10px",
                        borderRadius:6, border:"1px solid #bfdbfe",
                        background:"#eff6ff", color:"#1d4ed8" }}>
                        cloud-init: {osFlavorOf(form.os) === "rhel10" ? "RHEL 10"
                          : osFlavorOf(form.os) === "rhel9" ? "RHEL 9"
                          : form.os.toLowerCase().includes("ubuntu") ? "Ubuntu"
                          : "Ubuntu (fallback — no OS token in template name)"}
                      </span>
                    </div>
                  ) : <div />}
                </div>

                {/* Satellite placement — RHEL only; assigned by the CI
                    postconfig stage after the VM self-registers */}
                {isRhel && (
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:20 }}>
                    <Field label="Satellite Host Group (optional)" value={form.satelliteHostgroup}
                      onChange={sf("satelliteHostgroup")} placeholder="e.g. Linux/Prod" mono
                      hint="Nested groups by title" />
                    <Field label="Satellite Host Collection (optional)" value={form.satelliteHostCollection}
                      onChange={sf("satelliteHostCollection")} placeholder="e.g. web servers" mono
                      hint="Assigned via API after registration" />
                  </div>
                )}

                {/* NIC 1 */}
                <div style={{ background:"#f8fafc", border:"1.5px solid #e2e8f0", borderRadius:9,
                  padding:"14px 16px", marginBottom:10 }}>
                  <div style={{ fontSize:10, color:"#2563eb", fontFamily:"monospace", fontWeight:700,
                    textTransform:"uppercase", letterSpacing:1, marginBottom:10,
                    display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ background:"#2563eb", color:"#fff", borderRadius:4,
                      padding:"1px 6px", fontSize:10 }}>NIC 1</span>
                    <span style={{ color:"#9ca3af", fontWeight:400 }}>required</span>
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                    <div>
                      <SearchPick label="Network" value={form.network1} onChange={onNet1}
                        disabled={netsLoading}
                        options={netsLoading ? ["Loading…"] : nets} />
                      {NET_HINTS[form.network1] && (
                        <div style={{ fontSize:11, color:"#2563eb", fontFamily:"monospace",
                          background:"#eff6ff", border:"1px solid #bfdbfe",
                          padding:"3px 8px", borderRadius:5, marginTop:-10, marginBottom:0, display:"inline-block" }}>
                          gw {NET_HINTS[form.network1]?.gateway} · {NET_HINTS[form.network1]?.cidr}
                        </div>
                      )}
                    </div>
                    <Field label="IP CIDR" value={form.ipCidr} onChange={sf("ipCidr")}
                      placeholder="192.0.2.10/24" error={errors.ipCidr} mono />
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginTop:4 }}>
                    <Field label="Gateway"    value={form.gateway} onChange={sf("gateway")} placeholder="192.0.2.1"    error={errors.gateway} mono />
                    <Field label="DNS Server 1" value={form.dns1}  onChange={sf("dns1")}   placeholder="198.51.100.53"  mono />
                    <Field label="DNS Server 2" value={form.dns2}  onChange={sf("dns2")}   placeholder="192.0.2.53" mono />
                  </div>
                </div>

                {/* NIC 2 — shown on demand */}
                {showNic2 && (
                <div style={{ background:"#f8fafc", border:"1.5px solid #e2e8f0", borderRadius:9,
                  padding:"14px 16px", marginBottom:10 }}>
                  <div style={{ fontSize:10, color:"#6b7280", fontFamily:"monospace", fontWeight:700,
                    textTransform:"uppercase", letterSpacing:1, marginBottom:10,
                    display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ background:"#e5e7eb", color:"#374151", borderRadius:4,
                      padding:"1px 6px", fontSize:10 }}>NIC 2</span>
                    <button onClick={() => {
                      setShowNic2(false); setShowNic3(false);
                      setForm(f => ({ ...f, network2:"", ipCidr2:"", dnsNic2:"", network3:"", ipCidr3:"", dnsNic3:"" }));
                    }} style={{ marginLeft:"auto", width:20, height:20, borderRadius:4,
                      background:"#fef2f2", border:"1px solid #fca5a5", color:"#b91c1c",
                      cursor:"pointer", fontSize:11, lineHeight:1, padding:0 }}>✕</button>
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                    <div>
                      <SearchPick label="Network" value={form.network2} onChange={onNet2}
                        disabled={netsLoading}
                        options={netsLoading ? ["Loading…"] : ["", ...nets]} />
                      {NET_HINTS[form.network2] && (
                        <div style={{ fontSize:11, color:"#2563eb", fontFamily:"monospace",
                          background:"#eff6ff", border:"1px solid #bfdbfe",
                          padding:"3px 8px", borderRadius:5, marginTop:-10, marginBottom:0, display:"inline-block" }}>
                          gw {NET_HINTS[form.network2]?.gateway} · {NET_HINTS[form.network2]?.cidr}
                        </div>
                      )}
                    </div>
                    <Field label="IP CIDR" value={form.ipCidr2} onChange={sf("ipCidr2")}
                      placeholder="leave blank if unused" mono />
                    <Field label="DNS Name (FQDN)" value={form.dnsNic2} onChange={sf("dnsNic2")}
                      placeholder="example.internal" mono />
                  </div>
                </div>
                )}

                {/* NIC 3 — shown on demand */}
                {showNic2 && showNic3 && (
                <div style={{ background:"#f8fafc", border:"1.5px solid #e2e8f0", borderRadius:9,
                  padding:"14px 16px", marginBottom:10 }}>
                  <div style={{ fontSize:10, color:"#6b7280", fontFamily:"monospace", fontWeight:700,
                    textTransform:"uppercase", letterSpacing:1, marginBottom:10,
                    display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ background:"#e5e7eb", color:"#374151", borderRadius:4,
                      padding:"1px 6px", fontSize:10 }}>NIC 3</span>
                    <button onClick={() => {
                      setShowNic3(false);
                      setForm(f => ({ ...f, network3:"", ipCidr3:"", dnsNic3:"" }));
                    }} style={{ marginLeft:"auto", width:20, height:20, borderRadius:4,
                      background:"#fef2f2", border:"1px solid #fca5a5", color:"#b91c1c",
                      cursor:"pointer", fontSize:11, lineHeight:1, padding:0 }}>✕</button>
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                    <div>
                      <SearchPick label="Network" value={form.network3} onChange={onNet3}
                        disabled={netsLoading}
                        options={netsLoading ? ["Loading…"] : ["", ...nets]} />
                      {NET_HINTS[form.network3] && (
                        <div style={{ fontSize:11, color:"#2563eb", fontFamily:"monospace",
                          background:"#eff6ff", border:"1px solid #bfdbfe",
                          padding:"3px 8px", borderRadius:5, marginTop:-10, marginBottom:0, display:"inline-block" }}>
                          gw {NET_HINTS[form.network3]?.gateway} · {NET_HINTS[form.network3]?.cidr}
                        </div>
                      )}
                    </div>
                    <Field label="IP CIDR" value={form.ipCidr3} onChange={sf("ipCidr3")}
                      placeholder="leave blank if unused" mono />
                    <Field label="DNS Name (FQDN)" value={form.dnsNic3} onChange={sf("dnsNic3")}
                      placeholder="example.internal" mono />
                  </div>
                </div>
                )}

                {/* Add NIC buttons */}
                <div style={{ display:"flex", gap:8 }}>
                  {!showNic2 && (
                    <button onClick={() => setShowNic2(true)}
                      style={{ padding:"6px 14px", borderRadius:7, border:"1.5px dashed #cbd5e1",
                        background:"#f8fafc", color:"#6b7280", fontSize:12, cursor:"pointer",
                        fontFamily:"'Inter',sans-serif" }}>
                      + Add NIC 2
                    </button>
                  )}
                  {showNic2 && !showNic3 && (
                    <button onClick={() => setShowNic3(true)}
                      style={{ padding:"6px 14px", borderRadius:7, border:"1.5px dashed #cbd5e1",
                        background:"#f8fafc", color:"#6b7280", fontSize:12, cursor:"pointer",
                        fontFamily:"'Inter',sans-serif" }}>
                      + Add NIC 3
                    </button>
                  )}
                </div>

              </Card>

              {/* ⑤ Resources */}
              <Card n="⑤" title="Resources & Role">

                {/* Profile / role */}
                <div style={{ marginBottom:16 }}>
                  <Lbl t="Server Role" />
                  <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                    {availableProfiles.map(id => {
                      const p = PROFILES[id];
                      const a = form.profile === id;
                      return (
                        <button key={id} onClick={() => onProfile(id)} style={{
                          flex:"1 1 200px", textAlign:"left", padding:"12px 14px",
                          borderRadius:10, cursor:"pointer", transition:"all 0.15s",
                          fontFamily:"'Inter',sans-serif",
                          background: a ? "#eff6ff" : "#f9fafb",
                          border:     a ? "2px solid #93c5fd" : "2px solid #e5e7eb",
                          color:      a ? "#1d4ed8" : "#6b7280",
                          boxShadow:  a ? "0 0 0 3px rgba(147,197,253,0.35)" : "none",
                        }}>
                          <div style={{ fontSize:13, fontWeight:700 }}>{p.label}</div>
                          <div style={{ fontSize:11, marginTop:3, color: a ? "#3b82f6" : "#9ca3af" }}>
                            {p.hint}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {availableProfiles.length < PROFILE_IDS.length && (
                    <p style={{ margin:"6px 0 0", fontSize:11, color:"#9ca3af" }}>
                      Some roles are hidden — they are not available for this OS template.
                    </p>
                  )}
                </div>

                {/* PostgreSQL version */}
                {form.profile === "postgresql" && (
                  <div style={{ background:"#f8fafc", border:"1.5px solid #e2e8f0",
                    borderRadius:9, padding:"14px 16px", marginBottom:16 }}>
                    <div style={{ display:"grid", gridTemplateColumns:"200px 1fr", gap:14, alignItems:"start" }}>
                      <Pick label="PostgreSQL Version" value={form.pgVersion}
                        onChange={sf("pgVersion")} options={PG_VERSIONS} error={errors.pgVersion} />
                      <div style={{ fontSize:12, color:"#64748b", paddingTop:22 }}>
                        {pgOk ? (
                          <>
                            Installs{" "}
                            <code style={{ background:"#eff6ff", color:"#2563eb",
                              padding:"1px 6px", borderRadius:4, fontFamily:"monospace" }}>
                              postgresql{form.pgVersion}-server
                            </code>{" "}
                            from the Satellite repos for el{elMajorOf(form.os)}.
                          </>
                        ) : (
                          <span style={{ color:"#b91c1c" }}>
                            No verified Satellite repo labels for PostgreSQL {form.pgVersion} on
                            el{elMajorOf(form.os) ?? "?"}. Add them to <code>PG_REPOS</code> in{" "}
                            <code>src/templates/profiles.js</code> — the install block is commented
                            out until then.
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <PickOrType label="CPU (vCores)" value={form.cpu} onChange={v => sf("cpu")(v)} options={[1,2,4,6,8,12,16,24,32]} />
                <PickOrType label="RAM (GB)"     value={form.ram} onChange={v => sf("ram")(v)} options={[1,2,4,8,16,32,48,64,96,128]} unit="GB" />

                <DiskRows disks={form.disks} onChange={sf("disks")} error={errors.disks} />

                <div style={{ padding:"10px 14px", background:"#f8fafc", border:"1px solid #e2e8f0",
                  borderRadius:8, fontSize:12, fontFamily:"monospace", color:"#64748b",
                  display:"flex", gap:16, flexWrap:"wrap", marginTop:4 }}>
                  <span style={{ color:"#2563eb", fontWeight:600 }}>⚙ {form.cpu} vCPU</span>
                  <span style={{ color:"#2563eb", fontWeight:600 }}>▣ {form.ram} GB RAM</span>
                  <span style={{ color:"#2563eb", fontWeight:600 }}>⬡ [{disksToTfvars(form.disks)}] GB</span>
                  <span style={{ marginLeft:"auto", color:"#cbd5e1" }}>→ parameters.auto.tfvars</span>
                </div>
              </Card>

              {/* ⑥ cloud-init */}
              <Card n="⑥" title="cloud-init / user-data.tpl">
                <p style={{ fontSize:12, color:"#9ca3af", fontFamily:"monospace", marginBottom:10 }}>
                  Written to{" "}
                  <code style={{ background:"#eff6ff", color:"#2563eb", padding:"1px 6px", borderRadius:4 }}>
                    servers/{form.vmName||"vm-name"}/user-data.tpl
                  </code>
                </p>
                <div style={{ marginBottom:14, padding:"9px 12px", borderRadius:7,
                  background:"#fffbeb", border:"1px solid #fde68a", color:"#92400e", fontSize:12 }}>
                  ⚠ cloud-init runs on <b>first boot only</b>. Editing this file after the VM
                  exists does nothing — Terraform deliberately ignores user-data changes
                  (<code>ignore_changes</code>) so the VM is not recreated. Get it right
                  before submitting, or configure the running VM by hand/ansible afterwards.
                </div>

                {/* User manager */}
                <div style={{ marginBottom:18 }}>
                  <Lbl t="Users" />
                  {ciUsers.length > 0 && (
                    <div style={{ marginBottom:10, display:"flex", flexDirection:"column", gap:6 }}>
                      {ciUsers.map(u => (
                        <div key={u.id} style={{ display:"flex", alignItems:"center", gap:10,
                          padding:"8px 12px", background:"#f8fafc", borderRadius:8,
                          border:"1px solid #e2e8f0" }}>
                          <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:600,
                            color:"#1e40af", minWidth:100 }}>{u.name}</span>
                          <span style={{ fontSize:11, padding:"2px 7px", borderRadius:5,
                            background: u.sudo==="NOPASSWD"?"#f0fdf4":u.sudo==="PASSWD"?"#fffbeb":"#f9fafb",
                            color:      u.sudo==="NOPASSWD"?"#15803d":u.sudo==="PASSWD"?"#b45309":"#6b7280",
                            border:     `1px solid ${u.sudo==="NOPASSWD"?"#86efac":u.sudo==="PASSWD"?"#fcd34d":"#e5e7eb"}`,
                            fontFamily:"monospace" }}>
                            {u.sudo==="NOPASSWD"?"sudo NOPASSWD":u.sudo==="PASSWD"?"sudo":"no sudo"}
                          </span>
                          <span style={{ fontSize:11, color:"#9ca3af", fontFamily:"monospace" }}>{u.shell}</span>
                          {u.sshKey.trim() && (
                            <span style={{ fontSize:11, color:"#2563eb", background:"#eff6ff",
                              padding:"2px 7px", borderRadius:5, border:"1px solid #bfdbfe",
                              fontFamily:"monospace" }}>🔑 key set</span>
                          )}
                          <button onClick={() => {
                            setCiUsers(ciUsers.filter(x => x.id !== u.id));
                          }} style={{ marginLeft:"auto", width:24, height:24, borderRadius:5,
                            background:"#fef2f2", border:"1px solid #fca5a5", color:"#b91c1c",
                            cursor:"pointer", fontSize:13, display:"flex",
                            alignItems:"center", justifyContent:"center" }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add user form */}
                  <div style={{ background:"#f8fafc", border:"1.5px dashed #cbd5e1",
                    borderRadius:9, padding:14 }}>
                    <div style={{ fontSize:11, color:"#6b7280", fontFamily:"monospace",
                      textTransform:"uppercase", letterSpacing:0.7, marginBottom:10 }}>
                      Add User
                    </div>

                    {/* SSH directory quick-fill */}
                    <div style={{ marginBottom:12, position:"relative" }}>
                      <Lbl t="Pick from SSH directory files.example.internal/ssh/" />
                      <input
                        value={sshQuery}
                        onChange={e => setSshQuery(e.target.value)}
                        placeholder={
                          sshDir.loading ? "Loading directory…" :
                          sshDir.error   ? "SSH directory unavailable" :
                          "Type name to search…"
                        }
                        disabled={sshDir.loading || !!sshDir.error}
                        style={{ width:"100%", background:"#fff", color:"#111827", fontSize:13,
                          border:"1.5px solid #e5e7eb", borderRadius:7, padding:"8px 12px",
                          fontFamily:"'Inter',sans-serif", outline:"none", boxSizing:"border-box",
                          opacity: (sshDir.loading || sshDir.error) ? 0.6 : 1 }} />
                      {sshQuery.trim() && sshDir.users.length > 0 && (() => {
                        const q = sshQuery.toLowerCase();
                        const hits = sshDir.users.filter(u => u.name.toLowerCase().includes(q));
                        return (
                          <div style={{ position:"absolute", top:"100%", left:0, right:0, zIndex:60,
                            background:"#fff", border:"1.5px solid #e5e7eb", borderRadius:7,
                            boxShadow:"0 4px 16px rgba(0,0,0,0.12)", maxHeight:220,
                            overflowY:"auto", marginTop:2 }}>
                            {hits.length === 0 ? (
                              <div style={{ padding:"10px 14px", fontSize:12, color:"#9ca3af" }}>No matches</div>
                            ) : hits.map(u => (
                              <div key={u.name}
                                onClick={async () => {
                                  setSshQuery("");
                                  setNewUser(nu => ({ ...nu, name: u.name }));
                                  setSshKeyBusy(true);
                                  try {
                                    const key = await fetchSshKey(u.file);
                                    setNewUser(nu => ({ ...nu, sshKey: key }));
                                  } catch { /* leave key blank */ }
                                  setSshKeyBusy(false);
                                }}
                                style={{ padding:"8px 14px", fontSize:13, cursor:"pointer",
                                  fontFamily:"'JetBrains Mono',monospace", color:"#1e40af" }}
                                onMouseEnter={e => e.currentTarget.style.background="#eff6ff"}
                                onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                                {u.name}
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>

                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                      <div>
                        <Lbl t="Username" />
                        <input value={newUser.name}
                          onChange={e => setNewUser(u => ({ ...u, name: e.target.value }))}
                          placeholder="e.g. john.doe"
                          style={{ width:"100%", background:"#ffffff", color:"#111827", fontSize:13,
                            border:"1.5px solid #e5e7eb", borderRadius:7, padding:"8px 12px",
                            fontFamily:"'JetBrains Mono',monospace", outline:"none", boxSizing:"border-box" }} />
                      </div>
                      <div>
                        <Lbl t="Sudo" />
                        <div style={{ position:"relative" }}>
                          <select value={newUser.sudo}
                            onChange={e => setNewUser(u => ({ ...u, sudo: e.target.value }))}
                            style={{ width:"100%", background:"#ffffff", color:"#111827", fontSize:13,
                              border:"1.5px solid #e5e7eb", borderRadius:7, padding:"8px 28px 8px 12px",
                              appearance:"none", cursor:"pointer", fontFamily:"'Inter',sans-serif", outline:"none" }}>
                            <option value="NOPASSWD">sudo — no password</option>
                            <option value="PASSWD">sudo — password required</option>
                            <option value="NONE">no sudo</option>
                          </select>
                          <span style={{ position:"absolute", right:10, top:"50%",
                            transform:"translateY(-50%)", pointerEvents:"none",
                            color:"#9ca3af", fontSize:11 }}>▾</span>
                        </div>
                      </div>
                    </div>
                    <div style={{ marginBottom:10 }}>
                      <Lbl t="SSH Public Key (optional)" />
                      <input value={sshKeyBusy ? "" : newUser.sshKey}
                        onChange={e => setNewUser(u => ({ ...u, sshKey: e.target.value }))}
                        placeholder={sshKeyBusy ? "Fetching key…" : "ssh-rsa AAAA…"}
                        disabled={sshKeyBusy}
                        style={{ width:"100%", background:"#ffffff", color:"#111827", fontSize:12,
                          border:"1.5px solid #e5e7eb", borderRadius:7, padding:"8px 12px",
                          fontFamily:"'JetBrains Mono',monospace", outline:"none", boxSizing:"border-box",
                          opacity: sshKeyBusy ? 0.6 : 1 }} />
                    </div>
                    <button onClick={() => {
                      if (!newUser.name.trim()) return;
                      const user = { ...newUser, name: newUser.name.trim(), id: Date.now() };
                      setCiUsers([...ciUsers, user]);
                      setNewUser({ name:"", sudo:"NOPASSWD", shell:"/bin/bash", sshKey:"" });
                    }} style={{ padding:"7px 16px", borderRadius:7, border:"none",
                      background:"#2563eb", color:"#fff", fontSize:12, fontWeight:600,
                      cursor:"pointer", fontFamily:"'Inter',sans-serif" }}>
                      + Add User
                    </button>
                  </div>
                </div>

                <div style={{ marginBottom:6 }}>
                  <Lbl t="user-data.tpl — edit freely, user manager updates this automatically" />
                </div>
                <textarea value={form.userData} onChange={e=>sf("userData")(e.target.value)}
                  rows={18} style={{ width:"100%", background:"#f8fafc",
                    border:"1.5px solid #e2e8f0", borderRadius:8, padding:"12px",
                    color:"#1e40af", fontSize:12, lineHeight:1.7, resize:"vertical",
                    fontFamily:"'JetBrains Mono',monospace", outline:"none" }} />
              </Card>

              {/* submit row */}
              <div style={{ display:"flex", gap:10, alignItems:"center", marginTop:4 }}>
                <button onClick={submit} disabled={submitting} style={{
                  padding:"12px 28px", borderRadius:9, border:"none",
                  background: submitting ? "#93c5fd" : "#2563eb",
                  color:"#ffffff", fontSize:14, fontWeight:600,
                  fontFamily:"'Inter',sans-serif", cursor: submitting?"not-allowed":"pointer",
                  display:"flex", alignItems:"center", gap:8,
                  boxShadow: submitting?"none":"0 2px 8px rgba(37,99,235,0.4)",
                  transition:"all 0.2s",
                }}>
                  {submitting
                    ? <><span style={{ display:"inline-block", animation:"spin 1s linear infinite" }}>⟳</span> Committing…</>
                    : "⬡  Trigger Pipeline"}
                </button>
                <button onClick={()=>setView("list")} style={{
                  padding:"12px 20px", borderRadius:9, fontSize:14, fontWeight:500,
                  background:"#ffffff", border:"1px solid #e5e7eb", color:"#6b7280",
                  cursor:"pointer", fontFamily:"'Inter',sans-serif",
                  boxShadow:"0 1px 2px rgba(0,0,0,0.05)",
                }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── SERVERS (modify / delete existing VMs) ── */}
          {view==="servers" && (() => {
            const q = srvQuery.trim().toLowerCase();
            const items = srvList.items.filter(n => !q || n.toLowerCase().includes(q));
            const parsed = srvDetail?.parsed;
            const inp = extra => ({ width:"100%", background:"#ffffff", color:"#111827", fontSize:13,
              border:"1.5px solid #e5e7eb", borderRadius:7, padding:"8px 12px", outline:"none",
              boxSizing:"border-box", fontFamily:"'JetBrains Mono',monospace", ...extra });
            return (
              <div style={{ animation:"fadeUp 0.2s ease" }}>
                <div style={{ display:"grid", gridTemplateColumns:"330px 1fr", gap:14, alignItems:"start" }}>

                  {/* left: searchable folder list */}
                  <div style={{ background:"#ffffff", border:"1px solid #e5e7eb", borderRadius:12,
                    boxShadow:"0 1px 4px rgba(0,0,0,0.06)", overflow:"hidden" }}>
                    <div style={{ padding:"12px 14px", borderBottom:"1px solid #f3f4f6" }}>
                      <input value={srvQuery} onChange={e=>setSrvQuery(e.target.value)}
                        placeholder={srvList.loading ? "Loading servers…" : "Search VM…"}
                        style={inp({})} />
                      <div style={{ marginTop:6, fontSize:11, color:"#9ca3af", display:"flex", justifyContent:"space-between" }}>
                        <span>{srvList.loading ? "loading…" : `${items.length} / ${srvList.items.length} servers`}</span>
                        <span onClick={reloadServers} style={{ cursor:"pointer", color:"#2563eb" }}>⟳ reload</span>
                      </div>
                    </div>
                    {srvList.error && (
                      <div style={{ padding:"12px 14px", fontSize:12, color:"#b91c1c" }}>Error: {srvList.error}</div>
                    )}
                    <div style={{ maxHeight:560, overflowY:"auto" }}>
                      {items.map(n => (
                        <div key={n} onClick={() => selectServer(n)}
                          style={{ padding:"9px 14px", fontSize:12.5, cursor:"pointer",
                            fontFamily:"'JetBrains Mono',monospace",
                            color: n===srvSel ? "#1d4ed8" : "#374151",
                            background: n===srvSel ? "#eff6ff" : "transparent",
                            borderBottom:"1px solid #f9fafb" }}
                          onMouseEnter={e => { if (n!==srvSel) e.currentTarget.style.background="#f9fafb"; }}
                          onMouseLeave={e => { if (n!==srvSel) e.currentTarget.style.background= n===srvSel?"#eff6ff":"transparent"; }}>
                          {n}
                        </div>
                      ))}
                      {!srvList.loading && !items.length && !srvList.error && (
                        <div style={{ padding:"16px 14px", fontSize:12, color:"#9ca3af" }}>No matches</div>
                      )}
                    </div>
                  </div>

                  {/* right: detail / edit */}
                  <div style={{ background:"#ffffff", border:"1px solid #e5e7eb", borderRadius:12,
                    boxShadow:"0 1px 4px rgba(0,0,0,0.06)", padding:22, minHeight:300 }}>
                    {!srvSel ? (
                      <div style={{ color:"#9ca3af", fontSize:13, paddingTop:40, textAlign:"center" }}>
                        Select a VM on the left to change its resources or delete it.
                      </div>
                    ) : srvDetail?.loading ? (
                      <div style={{ color:"#9ca3af", fontSize:13, paddingTop:40, textAlign:"center" }}>
                        <span style={{ display:"inline-block", animation:"spin 1s linear infinite", marginRight:8 }}>⟳</span>
                        Loading {srvSel}…
                      </div>
                    ) : (
                      <>
                        {/* header */}
                        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4, flexWrap:"wrap" }}>
                          <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:16, fontWeight:700, color:"#111827" }}>{srvSel}</span>
                          {parsed && <DcTag dc={dcOfParsed(parsed)} />}
                          <a href={`${GITLAB_URL}/${YOUR_REPO_PATH}/-/tree/${REPO_BRANCH}/${SERVERS_DIR}/${srvSel}`}
                            target="_blank" rel="noreferrer"
                            style={{ marginLeft:"auto", fontSize:12, color:"#2563eb", textDecoration:"none",
                              padding:"4px 10px", borderRadius:6, background:"#eff6ff", border:"1px solid #bfdbfe" }}>
                            → folder in GitLab
                          </a>
                        </div>

                        {srvDetail?.error ? (
                          <div style={{ margin:"12px 0", padding:"10px 14px", borderRadius:8, fontSize:12.5,
                            background:"#fef2f2", border:"1px solid #fca5a5", color:"#b91c1c" }}>
                            Could not read parameters.auto.tfvars: {srvDetail.error}. Resource editing is
                            unavailable — deleting the VM is still possible below.
                          </div>
                        ) : (
                          <>
                            {/* facts */}
                            <div style={{ display:"flex", gap:18, flexWrap:"wrap", margin:"10px 0 18px",
                              fontSize:12, color:"#6b7280", fontFamily:"'JetBrains Mono',monospace" }}>
                              {[["template", parsed.template],
                                [parsed.isPve ? "node" : "cluster", parsed.isPve ? parsed.nodeName : parsed.cluster],
                                ["network", parsed.network1], ["cidr", parsed.cidr],
                                ["tags", parsed.tagsRaw]]
                                .filter(([,v]) => v)
                                .map(([k,v]) => (
                                  <span key={k}><span style={{ color:"#d1d5db" }}>{k}:</span> {v}</span>
                                ))}
                            </div>

                            {/* resources */}
                            <Lbl t="Resources" />
                            <div style={{ display:"grid", gridTemplateColumns:"140px 140px", gap:12, marginBottom:12 }}>
                              <div>
                                <Lbl t="CPU (vCores)" />
                                <input value={String(srvEdit?.cpu ?? "")} inputMode="numeric"
                                  onChange={e => { const v=e.target.value; if (v===""||/^\d+$/.test(v)) setSrvEdit(s=>({...s, cpu: v===""?"":+v})); }}
                                  style={inp({})} />
                              </div>
                              <div>
                                <Lbl t="RAM (GB)" />
                                <input value={String(srvEdit?.mem ?? "")} inputMode="numeric"
                                  onChange={e => { const v=e.target.value; if (v===""||/^\d+$/.test(v)) setSrvEdit(s=>({...s, mem: v===""?"":+v})); }}
                                  style={inp({})} />
                              </div>
                            </div>

                            <Lbl t="Disks (GB)" />
                            {srvEdit?.disks ? (
                              <div style={{ marginBottom:10 }}>
                                {srvEdit.disks.map((d, i) => (
                                  <div key={i} style={{ display:"flex", gap:8, alignItems:"center", marginBottom:6 }}>
                                    <span style={{ fontSize:11, fontFamily:"'JetBrains Mono',monospace", color:"#64748b",
                                      background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:5,
                                      padding:"5px 8px", minWidth:64, textAlign:"center" }}>
                                      {i === 0 ? "sda · OS" : `sd${String.fromCharCode(97+i)}`}
                                    </span>
                                    <input value={String(d)} inputMode="numeric"
                                      onChange={e => { const v=e.target.value; if (v===""||/^\d+$/.test(v))
                                        setSrvEdit(s=>({ ...s, disks: s.disks.map((x,idx)=> idx===i ? (v===""?0:+v) : x) })); }}
                                      style={inp({ width:110, textAlign:"right" })} />
                                    {i > 0 && i === srvEdit.disks.length-1 && i >= (parsed.disksNumeric?.length ?? 1) && (
                                      <button onClick={() => setSrvEdit(s=>({ ...s, disks: s.disks.slice(0,-1) }))}
                                        title="Remove this (newly added) disk"
                                        style={{ width:26, height:26, borderRadius:5, background:"#fef2f2",
                                          border:"1px solid #fca5a5", color:"#b91c1c", cursor:"pointer", fontSize:12, padding:0 }}>✕</button>
                                    )}
                                  </div>
                                ))}
                                <button onClick={() => setSrvEdit(s=>({ ...s, disks:[...s.disks, 50] }))}
                                  style={{ padding:"6px 14px", borderRadius:7, border:"1.5px dashed #cbd5e1",
                                    background:"#f8fafc", color:"#6b7280", fontSize:12, cursor:"pointer" }}>
                                  + Add disk
                                </button>
                              </div>
                            ) : (
                              <div style={{ marginBottom:10 }}>
                                <textarea value={srvEdit?.disksRaw ?? ""} rows={5}
                                  onChange={e => setSrvEdit(s=>({ ...s, disksRaw: e.target.value }))}
                                  style={inp({ fontSize:12, lineHeight:1.6, resize:"vertical" })} />
                                <p style={{ margin:"4px 0 0", fontSize:11, color:"#9ca3af" }}>
                                  Proxmox disk list ({`{ size, datastore_id }`} objects) — edited as text.
                                </p>
                              </div>
                            )}

                            <div style={{ margin:"4px 0 14px", padding:"9px 12px", borderRadius:7, fontSize:12,
                              background:"#fffbeb", border:"1px solid #fde68a", color:"#92400e" }}>
                              ⚠ Growing a disk does <b>not</b> grow the filesystem — run growpart/xfs_growfs in the
                              guest afterwards. A <b>new</b> disk arrives raw: create the filesystem and mount it by
                              hand (cloud-init only runs on first boot). Never shrink or remove an existing disk.
                            </div>

                            <button onClick={saveResize}
                              disabled={srvBusy || !srvDetail?.raw || srvEdit?.cpu==="" || srvEdit?.mem===""}
                              style={{ padding:"10px 22px", borderRadius:8, border:"none", fontSize:13, fontWeight:600,
                                background: srvBusy ? "#93c5fd" : "#2563eb", color:"#ffffff",
                                cursor: srvBusy ? "not-allowed" : "pointer",
                                boxShadow: srvBusy ? "none" : "0 2px 8px rgba(37,99,235,0.4)" }}>
                              {srvBusy ? "Working…" : "Commit resize → pipeline"}
                            </button>
                          </>
                        )}

                        {/* danger zone */}
                        <div style={{ marginTop:24, padding:"14px 16px", borderRadius:10,
                          background:"#fef2f2", border:"1.5px solid #fca5a5" }}>
                          <div style={{ fontSize:12, fontWeight:700, color:"#b91c1c", textTransform:"uppercase",
                            letterSpacing:0.8, marginBottom:6 }}>Delete this VM</div>
                          <p style={{ fontSize:12, color:"#7f1d1d", margin:"0 0 10px", lineHeight:1.6 }}>
                            Moves <code>servers/{srvSel}/</code> to <code>deleted/</code> (kept as a permanent record)
                            and starts the destroy pipeline. The VM is only removed after a human approves the
                            <b> destroy</b> step in GitLab. Type the VM name to confirm:
                          </p>
                          <div style={{ display:"flex", gap:8 }}>
                            <input value={srvConfirm} onChange={e=>setSrvConfirm(e.target.value)}
                              placeholder={srvSel}
                              style={inp({ flex:1, borderColor:"#fca5a5", background:"#fff" })} />
                            <button onClick={deleteServer} disabled={srvBusy || srvConfirm !== srvSel}
                              style={{ padding:"8px 18px", borderRadius:7, border:"none", fontSize:13, fontWeight:700,
                                background: (srvBusy || srvConfirm !== srvSel) ? "#fca5a5" : "#dc2626",
                                color:"#ffffff", cursor:(srvBusy || srvConfirm !== srvSel) ? "not-allowed" : "pointer" }}>
                              {srvBusy ? "Working…" : "Delete VM"}
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
        </main>
      </div>

      <Toasts list={toasts} del={delToast} />
    </>
  );
}