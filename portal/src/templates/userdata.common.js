// Shared cloud-init config used by all OS templates (RHEL 9/10, Ubuntu).
// Change a value here and it updates everywhere that imports it.
//
// NOTE: ${...} placeholders are Terraform/cloud-init variables and must reach
// the rendered output literally. In plain "..." strings they pass through
// unchanged. In the few `...` template literals below they are escaped as
// \${...} on purpose — do not "fix" them.

// ---------------------------------------------------------------------------
// Tunable parameters — edit these to change config across every OS template.
// ---------------------------------------------------------------------------
export const TIMEZONE = "UTC";
export const NTP_SERVER = "ntp.example.internal";

// Packages installed on every OS (OS-specific extras stay in each template).
export const COMMON_PACKAGES = [
  "mc",
  "vim",
  "nano",
  "bash-completion",
  "htop",
  "tmux",
  "net-tools",
  "git",
  "curl",
  "wget",
];

// Grafana Alloy — the monitoring agent on every VM. It PUSHES host metrics to
// a Prometheus remote-write endpoint (Prometheus, Mimir, VictoriaMetrics,
// Grafana Cloud ...), so nothing has to register or deregister the host on
// the monitoring side. Repo URLs: point them at an internal mirror if the VMs
// have no route to grafana.com.
export const ALLOY = {
  remoteWriteUrl: "https://metrics.example.internal/api/v1/write",
  scrapeInterval: "60s",
  aptRepoUrl: "https://apt.grafana.com",
  rpmRepoUrl: "https://rpm.grafana.com",
};

// ---------------------------------------------------------------------------
// Block builders — return arrays of YAML lines to spread into a template.
// ---------------------------------------------------------------------------

// #cloud-config header with disk growth and host file handling.
export const cloudConfigHeader = [
  "#cloud-config",
  "",
  "growpart:",
  "  mode: auto",
  "  devices: ['/']",
  "",
  "resize_rootfs: true",
  "",
  "manage_etc_hosts: false",
  "",
  "# Set the hostname in the early init stage. PVE's NoCloud meta-data carries",
  "# no local-hostname (VMware customization does), so without this the",
  "# template's leftover hostname survives into modules-config — and Satellite",
  "# (rh_subscription) registers the host under the WRONG name, breaking the",
  "# postconfig host-group step and the delete pipeline's Satellite removal.",
  "hostname: ${server_name}",
  "fqdn: ${server_name}.${server_domain}",
  "prefer_fqdn_over_hostname: true",
];

// package_update / package_upgrade (+ optional reboot-if-required).
export function packageUpdateBlock(rebootIfRequired = true) {
  return [
    ...(rebootIfRequired ? ["package_reboot_if_required: true"] : []),
    "package_update: true",
    "package_upgrade: true",
  ];
}

// ntp block. Pass a client (e.g. "chrony", "systemd-timesyncd") or omit it.
export function ntpBlock(client = "") {
  return [
    "ntp:",
    "  enabled: true",
    ...(client ? [`  ntp_client: ${client}`] : []),
    "  servers:",
    `    - ${NTP_SERVER}`,
  ];
}

export const timezoneLine = `timezone: "${TIMEZONE}"`;

// admins group plus the "users:" header (caller appends the rendered users).
export const adminsAndUsersHeader = [
  "# admins group (provides passwordless sudo)",
  "groups:",
  "  - admins",
  "",
  "# default admin users",
  "users:",
];

// COMMON_PACKAGES rendered as cloud-init list items.
export const commonPackageLines = COMMON_PACKAGES.map((p) => `  - ${p}`);

// --- write_files entries ---

export const sudoersWriteFile = [
  "  - path: /etc/sudoers.d/admins",
  "    content: |",
  "      %admins ALL=(ALL) NOPASSWD:ALL",
  "    permissions: '0440'",
  "    owner: root:root",
];

export const bashPromptWriteFile = [
  "  - path: /etc/profile.d/custom_bash_prompt.sh",
  "    permissions: '0755'",
  "    content: |",
  "      #!/bin/bash",
  "      # Customize the Bash prompt to display the full hostname",
  '      export PS1="[\\u@\\H \\w]\\\\$ "',
];

// Pass append=false to leave `shopt -s histappend` commented out.
export function bashHistoryWriteFile(append = true) {
  return [
    "  - path: /etc/profile.d/custom_bash_history.sh",
    "    permissions: '0755'",
    "    content: |",
    "      #!/bin/bash",
    "      # Set the maximum number of lines in the history file",
    "      export HISTSIZE=20000",
    "      # Set the format of the timestamp to be included in the history",
    '      export HISTTIMEFORMAT="%F %T "',
    "      # Ensure that the history file is appended with each new session",
    append ? "      shopt -s histappend" : "      #shopt -s histappend",
  ];
}

// Org DNS resolvers, in preference order.
export const DNS_SERVERS = ["192.0.2.53", "198.51.100.53"];

// systemd-resolved config as a DROP-IN — never by editing /etc/systemd/resolved.conf.
// Two reasons the old `sed -i` approach was replaced:
//   * `s/^#DNS=/DNS=.../` matches only a bare `#DNS=` line. If a distro ever
//     ships a different commented default the substitution matches nothing,
//     exits 0, and the VM boots with no org DNS — silently, nothing in the log.
//   * resolved.conf is a package-managed config file, so an upgrade can
//     replace it and drop the edits. Files under resolved.conf.d/ are safe.
// 90- prefix: drop-ins apply in lexical order across /etc, /run and /usr/lib,
// so a high number keeps org policy ahead of anything dropped in later.
export function resolvedDropInWriteFile(servers = DNS_SERVERS) {
  return [
    "  - path: /etc/systemd/resolved.conf.d/90-org-dns.conf",
    "    content: |",
    "      [Resolve]",
    `      DNS=${servers.join(" ")}`,
    "      Domains=~.",
    "      DNSSEC=no",
    "      Cache=yes",
    "    owner: root:root",
    "    permissions: '0644'",
  ];
}

// Alloy pipeline: node_exporter-style host metrics -> remote write. The
// instance label is the FQDN (filled in by Terraform), not host:port.
export const alloyConfWriteFile = [
  "  - path: /etc/alloy/config.alloy",
  "    content: |",
  "      prometheus.exporter.unix \"host\" { }",
  "",
  "      prometheus.scrape \"host\" {",
  "        targets         = prometheus.exporter.unix.host.targets",
  "        forward_to      = [prometheus.relabel.host.receiver]",
  `        scrape_interval = "${ALLOY.scrapeInterval}"`,
  "      }",
  "",
  "      prometheus.relabel \"host\" {",
  "        forward_to = [prometheus.remote_write.default.receiver]",
  "",
  "        rule {",
  "          target_label = \"instance\"",
  "          replacement  = \"${server_name}.${server_domain}\"",
  "        }",
  "      }",
  "",
  "      prometheus.remote_write \"default\" {",
  "        endpoint {",
  `          url = "${ALLOY.remoteWriteUrl}"`,
  "        }",
  "      }",
  "    owner: root:root",
  "    permissions: '0644'",
];

// Grafana repo signing key as a write_files entry. Written to disk before the
// packages phase so the Grafana repo verifies on the FIRST apt/dnf run.
import { GRAFANA_REPO_KEY } from "./grafana.key.js";

function grafanaKeyWriteFile(path) {
  return [
    `  - path: ${path}`,
    "    permissions: '0644'",
    "    owner: root:root",
    "    content: |",
    ...GRAFANA_REPO_KEY.split("\n").map((l) => `      ${l}`.trimEnd()),
  ];
}

// Grafana package repo + key. pkg is "rpm" (RHEL) or "deb" (Ubuntu).
export function alloyRepoWriteFiles(pkg) {
  if (pkg === "deb") {
    return [
      ...grafanaKeyWriteFile("/etc/apt/keyrings/grafana.asc"),
      "",
      "  - path: /etc/apt/sources.list.d/grafana.list",
      "    content: |",
      `      deb [signed-by=/etc/apt/keyrings/grafana.asc] ${ALLOY.aptRepoUrl} stable main`,
    ];
  }
  return [
    ...grafanaKeyWriteFile("/etc/pki/rpm-gpg/RPM-GPG-KEY-grafana"),
    "",
    "  - path: /etc/yum.repos.d/grafana.repo",
    "    content: |",
    "      [grafana]",
    "      name=grafana",
    `      baseurl=${ALLOY.rpmRepoUrl}`,
    "      enabled=1",
    "      gpgcheck=1",
    "      repo_gpgcheck=1",
    "      gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-grafana",
    "      sslverify=1",
  ];
}

// --- runcmd entries ---

export const groupAndHostnameRuncmd = [
  "# cant set gid when creating group, so we do it here",
  "  - [ groupmod, -g, 1200, admins ]",
  "# set hostname",
  "  - [ /usr/bin/hostnamectl, --static, --pretty, --transient, set-hostname, ${server_name}.${server_domain} ]",
];

export const setRootPasswordRuncmd =
  "  - [ /bin/sh, -c, \"echo 'root:${root_password}' | chpasswd\" ]";

// Alloy enable/restart (restart picks up the config written above). sysctl is
// the systemctl path ("/bin/systemctl" on RHEL, "systemctl" on Ubuntu).
export function alloyRuncmd(sysctl = "/bin/systemctl") {
  return [
    "# monitoring agent (grafana alloy)",
    `  - ${sysctl} enable alloy || true`,
    `  - ${sysctl} restart alloy || true`,
  ];
}
