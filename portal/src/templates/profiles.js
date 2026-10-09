// Server role profiles.
//
// A profile bundles three things that always travel together:
//   - a default disk layout (see userdata.disks.js)
//   - extra runcmd lines appended to the cloud-init (software install)
//   - tags that the VM should always carry
//
// Add a new role here (docker, weblogic, …) rather than hand-editing
// user-data.tpl after the fact.

import { DEFAULT_FS } from "./userdata.disks.js";

// ---------------------------------------------------------------------------
// OS detection — templates are named like "dc2_rhel9_template".
// ---------------------------------------------------------------------------
export function osFamilyOf(os = "") {
  return os.toLowerCase().includes("ubuntu") ? "ubuntu" : "rhel";
}

// RHEL major version, used to pick the right Satellite repo labels.
// Tolerant of naming variants: rhel10, redhat10, rhel_10, rhel-10, "rhel 10".
export function elMajorOf(os = "") {
  const m = os.toLowerCase().match(/(?:rhel|redhat)[-_ ]?(\d+)/);
  return m ? Number(m[1]) : null;
}

// Which cloud-init template a given OS/template name gets. Single source of
// truth for the dispatch — PVE template names are free-form, so anything with
// a rhel/redhat+version token is RHEL; explicit "ubuntu" is Ubuntu; anything
// unrecognized falls back to Ubuntu (the form surfaces the detection so a
// wrong fallback is visible before submit).
export function osFlavorOf(os = "") {
  const el = elMajorOf(os);
  if (el !== null) return el >= 10 ? "rhel10" : "rhel9";
  return "ubuntu";
}

// ---------------------------------------------------------------------------
// PostgreSQL — Satellite repository labels.
//
// These labels are NOT derivable by rule. PG 16 and PG 17 use different naming
// conventions on the very same el9:
//
//   16 -> Example_Postgresql_16_el9_Postgresql_16_el9_repo   (doubled)
//   17 -> Example_Postgresql_17_el9_repo                     (short)
//
// Every entry below was copied verbatim from a working server in
// vm-deploy/servers. When a new PostgreSQL version is published to Satellite,
// add a row here with the real label — do not guess it. An unknown
// version/el combination renders as a commented-out block with a warning
// instead of a wrong repo name, so it fails at review time rather than
// silently at first boot.
// ---------------------------------------------------------------------------
export const PG_REPOS = {
  "16-el9": {
    version: "Example_Postgresql_16_el9_Postgresql_16_el9_repo",
    common: "Example_Postgresql_Common_el9_Postgresql_Common_el9_repo",
    extras: "Example_Postgresql_Extras_el9_Postgresql_Extras_el9_repo",
  },
  "17-el9": {
    version: "Example_Postgresql_17_el9_repo",
    common: "Example_Postgresql_Common_el9_Postgresql_Common_el9_repo",
    extras: "Example_Postgresql_Extras_el9_Postgresql_Extras_el9_repo",
  },
};

// Versions offered in the form, newest first.
export const PG_VERSIONS = [
  ...new Set(Object.keys(PG_REPOS).map((k) => k.split("-")[0])),
].sort((a, b) => Number(b) - Number(a));

export const PG_DEFAULT_VERSION = PG_VERSIONS[0];

export function pgRepos(pgVersion, elMajor) {
  return PG_REPOS[`${pgVersion}-el${elMajor}`] || null;
}

// False when we have no verified repo labels for this combination — the form
// shows a warning and the generated block is commented out.
export function pgSupported(pgVersion, elMajor) {
  return !!pgRepos(pgVersion, elMajor);
}

// runcmd lines for the PostgreSQL install. Mirrors what the existing psql
// servers do: enable the version/common/extras repos, disable the RHEL
// postgresql module so it cannot win, then install the server package.
// Note this installs only — it deliberately does not run initdb, matching
// current practice on dc2-db01, dc2-db02 and friends.
export function postgresRuncmd({ pgVersion, elMajor }) {
  const repos = pgRepos(pgVersion, elMajor);

  const repoLines = repos
    ? [repos.version, repos.common, repos.extras].map(
        (r) => `  - subscription-manager repos --enable=${r}`,
      )
    : [
        "  - subscription-manager repos --enable=<VERSION_REPO_LABEL>",
        "  - subscription-manager repos --enable=<COMMON_REPO_LABEL>",
        "  - subscription-manager repos --enable=<EXTRAS_REPO_LABEL>",
      ];

  const install = [
    "  - dnf clean all",
    "  - dnf -qy module disable postgresql",
    ...repoLines,
    `  - dnf install postgresql${pgVersion}-server -y`,
  ];

  if (repos) {
    return ["", `## postgresql ${pgVersion} install`, ...install];
  }

  return [
    "",
    `## postgresql ${pgVersion} install — DISABLED, NO VERIFIED REPO LABELS`,
    `## There are no known Satellite repo labels for PostgreSQL ${pgVersion} on el${elMajor ?? "?"}.`,
    "## Add them to PG_REPOS in src/templates/profiles.js and regenerate,",
    "## or fill in the labels below and uncomment.",
    ...install.map((l) => `#${l}`),
  ];
}

// ---------------------------------------------------------------------------
// Docker — shared settings and Satellite repo labels.
//
// Like PG_REPOS: labels copied verbatim, never guessed. An el version without
// an entry renders a commented-out block instead of a wrong repo name.
// ---------------------------------------------------------------------------
export const DOCKER_REPOS = {
  "el10": "Example_Docker_el10_docker_el10_repo",
};

const DOCKER_PROXY    = "http://proxy.example.internal:3128";
const DOCKER_NO_PROXY = "localhost,127.0.0.0/8,*.example.internal,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

export const DOCKER_PACKAGES = [
  "docker-ce",
  "docker-ce-cli",
  "containerd.io",
  "docker-compose-plugin",
  "docker-buildx-plugin",
];

// daemon proxy drop-in + daemon.json — identical on Ubuntu and RHEL.
const dockerCommonWriteFiles = [
  "  - path: /etc/systemd/system/docker.service.d/http-proxy.conf",
  "    content: |",
  "      [Service]",
  `      Environment="HTTP_PROXY=${DOCKER_PROXY}"`,
  `      Environment="HTTPS_PROXY=${DOCKER_PROXY}"`,
  `      Environment="NO_PROXY=${DOCKER_NO_PROXY}"`,
  "",
  "  - path: /etc/docker/daemon.json",
  "    content: |",
  "      {",
  '        "bip": "172.31.0.1/16",',
  '        "default-address-pools": [',
  "          {",
  '            "base": "172.30.0.0/16",',
  '            "size": 24',
  "          }",
  "        ],",
  '        "log-driver": "json-file",',
  '        "log-opts": {',
  '          "max-size": "500m",',
  '          "max-file": "3"',
  "        }",
  "      }",
];

function dockerWriteFiles({ osFamily }) {
  if (osFamily === "ubuntu") {
    return [
      "",
      "  - path: /etc/apt/sources.list.d/docker.list",
      "    content: |",
      "      deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu  noble  stable",
      "",
      ...dockerCommonWriteFiles,
    ];
  }
  return ["", ...dockerCommonWriteFiles];
}

function dockerRuncmd({ osFamily, elMajor }) {
  if (osFamily === "ubuntu") {
    // NOTE ordering quirk, kept on purpose: the apt keyring is fetched here in
    // runcmd, AFTER the packages phase already tried to install docker-ce. On
    // a truly fresh boot that install fails, the final health check runs
    // `cloud-init clean && reboot`, and the second boot installs docker with
    // the (persisted) keyring in place. This retry loop is how the Ubuntu
    // template has always worked — do not "fix" the order without testing.
    return [
      "# docker",
      "  - mkdir -p /etc/apt/keyrings",
      "  - /usr/bin/curl -fsSL https://satellite.example.internal/pub/ubuntu_gpg -o /etc/apt/keyrings/docker.asc",
      "  - chmod a+r /etc/apt/keyrings/docker.asc",
      "  - systemctl daemon-reload",
      "  - systemctl restart docker",
      "  - systemctl enable docker",
    ];
  }

  const repo = DOCKER_REPOS[`el${elMajor}`];
  const install = [
    "  - dnf clean all",
    `  - subscription-manager repos --enable=${repo || "<DOCKER_REPO_LABEL>"}`,
    `  - dnf install ${DOCKER_PACKAGES.join(" ")} -y`,
    "  - systemctl daemon-reload",
    "  - systemctl enable --now docker",
  ];
  if (repo) return ["", "## docker install", ...install];
  return [
    "",
    `## docker install — DISABLED, NO VERIFIED REPO LABEL for el${elMajor ?? "?"}`,
    "## Add it to DOCKER_REPOS in src/templates/profiles.js and regenerate.",
    ...install.map((l) => `#${l}`),
  ];
}

// ---------------------------------------------------------------------------
// Profile registry
//
// A profile may contribute:
//   packages(ctx)   — extra entries for the cloud-init packages: list
//   writeFiles(ctx) — extra write_files: entries
//   runcmd(ctx)     — extra runcmd lines (installs, service enables)
//   supported(os)   — finer-grained gate than osFamilies (e.g. version-bound)
// ctx = { osFamily, elMajor, pgVersion }
// ---------------------------------------------------------------------------
export const PROFILES = {
  generic: {
    id: "generic",
    label: "Generic server",
    hint: "No extra software — just the base image configuration.",
    osFamilies: ["rhel", "ubuntu"],
    tags: [],
  },
  postgresql: {
    id: "postgresql",
    label: "PostgreSQL server",
    // FirstDiskOnly is the backup convention every existing psql server uses:
    // back up the root disk, skip the large data/backup volumes.
    hint: "Adds data + backup disks and installs PostgreSQL from Satellite.",
    osFamilies: ["rhel"],
    tags: ["FirstDiskOnly"],
    runcmd: (ctx) => postgresRuncmd(ctx),
  },
  docker: {
    id: "docker",
    label: "Docker host",
    hint: "Installs docker + compose, adds /var/lib/docker and /containerdata disks.",
    // Ubuntu 24.04 and RHEL 10 only (RHEL 10 uses the Satellite docker repo).
    osFamilies: ["rhel", "ubuntu"],
    supported: (os) => {
      const o = os.toLowerCase();
      return osFamilyOf(os) === "ubuntu" ? o.includes("ubuntu24") : elMajorOf(os) === 10;
    },
    tags: [],
    packages:   ({ osFamily }) => osFamily === "ubuntu"
      ? ["gnupg", "lsb-release", ...DOCKER_PACKAGES]
      : [],   // RHEL installs via dnf in runcmd, after the repo is enabled
    writeFiles: (ctx) => dockerWriteFiles(ctx),
    runcmd:     (ctx) => dockerRuncmd(ctx),
  },
};

export const PROFILE_IDS = Object.keys(PROFILES);

export function profilesForOs(os) {
  const family = osFamilyOf(os);
  return PROFILE_IDS.filter((id) => {
    const p = PROFILES[id];
    return p.osFamilies.includes(family) && (!p.supported || p.supported(os));
  });
}

export function profileSupportsOs(profileId, os) {
  return profilesForOs(os).includes(profileId);
}

export function profileTags(profileId) {
  return PROFILES[profileId]?.tags ?? [];
}

// All tags any profile can contribute — needed so switching profiles removes
// the previous profile's tags instead of accumulating them.
export const ALL_PROFILE_TAGS = [
  ...new Set(PROFILE_IDS.flatMap((id) => PROFILES[id].tags)),
];

export function profileRuncmd(profileId, ctx = {}) {
  return PROFILES[profileId]?.runcmd?.(ctx) ?? [];
}

export function profilePackages(profileId, ctx = {}) {
  const pkgs = PROFILES[profileId]?.packages?.(ctx) ?? [];
  return pkgs.map((p) => `  - ${p}`);
}

export function profileWriteFiles(profileId, ctx = {}) {
  return PROFILES[profileId]?.writeFiles?.(ctx) ?? [];
}

// Default disk layout for a profile on a given OS. Row 0 is always root.
// (Generic is a bare root disk on every OS — docker's layout comes from the
// docker role now, not from picking Ubuntu.)
export function defaultDisks(profileId, os) { // eslint-disable-line no-unused-vars
  const root = { size: 20, mount: "/", label: "", fs: "" };

  if (profileId === "postgresql") {
    return [
      root,
      { size: 300, mount: "/storage/disk01", label: "data", fs: DEFAULT_FS },
      { size: 300, mount: "/storage/disk02", label: "backup", fs: DEFAULT_FS },
    ];
  }

  if (profileId === "docker") {
    return [
      root,
      { size: 10, mount: "/var/lib/docker", label: "docker", fs: DEFAULT_FS },
      { size: 5, mount: "/containerdata", label: "data", fs: DEFAULT_FS },
    ];
  }

  return [root];
}
