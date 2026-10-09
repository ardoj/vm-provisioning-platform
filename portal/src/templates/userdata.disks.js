// Structured disk model.
//
// This is the single source of truth for BOTH the Terraform `disks` list in
// parameters.auto.tfvars AND the cloud-init fs_setup/mounts blocks, so the two
// can no longer disagree (previously the tfvars disk count was typed in one
// field and the /dev/sdX device list was hand-edited in the cloud-init text).
//
// A disk row is: { size, mount, label, fs }
//
//   disks[0] is always the OS/root disk. It is sized only — never formatted or
//   mounted by cloud-init, because the template already owns / and growpart
//   resizes it on first boot.
//
//   disks[1..] are data disks. Each one produces exactly one fs_setup entry and
//   one mounts entry, in order.

export const DEFAULT_FS = "xfs";
export const FS_CHOICES = ["xfs", "ext4"];

// Guest device naming. virtio-scsi (the vSphere templates, and Proxmox when the
// disk interface is scsiN) presents disks as /dev/sdX. If a platform is ever
// switched to virtio-blk the disks become /dev/vdX — change this per call via
// the devicePrefix option rather than editing every template.
export const DEFAULT_DEVICE_PREFIX = "/dev/sd";

// disks[1] -> /dev/sdb, disks[2] -> /dev/sdc, ...
export function deviceFor(index, prefix = DEFAULT_DEVICE_PREFIX) {
  return `${prefix}${String.fromCharCode(97 + index)}`;
}

// Data disks only (everything after root), each tagged with its position in the
// full list so the device letter stays correct even if a row has no mountpoint.
export function dataDisks(disks = []) {
  return disks
    .map((d, index) => ({ ...d, index }))
    .slice(1)
    .filter((d) => d.mount && d.mount.trim() && d.label && d.label.trim());
}

export function fsSetupLines(disks, prefix = DEFAULT_DEVICE_PREFIX) {
  const data = dataDisks(disks);
  if (!data.length) return [];
  const out = ["fs_setup:"];
  data.forEach((d, i) => {
    if (i) out.push("");
    out.push(
      `  - label: ${d.label.trim()}`,
      `    filesystem: '${d.fs || DEFAULT_FS}'`,
      `    device: '${deviceFor(d.index, prefix)}'`,
      "    overwrite: false",
    );
  });
  return out;
}

export function mountsLines(disks) {
  const data = dataDisks(disks);
  if (!data.length) return [];
  return [
    "mounts:",
    ...data.map(
      (d) =>
        `  - [ 'LABEL=${d.label.trim()}', '${d.mount.trim()}', '${d.fs || DEFAULT_FS}', 'defaults', '0', '0' ]`,
    ),
  ];
}

// Shown when a VM has no data disks. Kept as the commented-out example the RHEL
// templates have always carried, so the file shape stays familiar and is easy
// to fill in by hand.
const COMMENTED_PLACEHOLDER = [
  "# No extra disks requested. Example of what a data disk looks like:",
  "#fs_setup:",
  "#  - label: data",
  "#    filesystem: 'xfs'",
  "#    device: '/dev/sdb'",
  "#    overwrite: false",
  "#",
  "#mounts:",
  "#  - [ 'LABEL=data', '/storage/disk01', 'xfs', 'defaults', '0', '0' ]",
];

// The full fs_setup + mounts section for a template to spread in.
export function diskBlocks(disks, prefix = DEFAULT_DEVICE_PREFIX) {
  const fs = fsSetupLines(disks, prefix);
  if (!fs.length) return COMMENTED_PLACEHOLDER;
  return [...fs, "", ...mountsLines(disks)];
}

// `mkdir -p` for every data mountpoint, as a runcmd line. cloud-init creates
// mountpoints itself, but Ubuntu needs the docker directory to exist before the
// docker package is configured, so that template asks for this explicitly.
export function mountpointMkdirLines(disks) {
  const data = dataDisks(disks);
  if (!data.length) return [];
  return [`  - mkdir -p ${data.map((d) => d.mount.trim()).join(" ")}`];
}

// The Terraform side: disks = [20, 300, 300]
export function disksToTfvars(disks = []) {
  return disks.map((d) => Number(d.size) || 0).join(", ");
}

// Returns an error string, or null when the list is usable.
export function validateDisks(disks = []) {
  if (!disks.length) return "At least a root disk is required";
  if (disks.some((d) => !(Number(d.size) > 0))) return "Every disk needs a size greater than 0";

  const data = disks.slice(1);
  if (data.some((d) => !d.label || !d.label.trim())) return "Every data disk needs a filesystem label";
  if (data.some((d) => !d.mount || !d.mount.trim())) return "Every data disk needs a mountpoint";
  if (data.some((d) => !d.mount.trim().startsWith("/"))) return "Mountpoints must be absolute paths";
  if (data.some((d) => d.mount.trim() === "/")) return "A data disk cannot be mounted on /";

  const labels = data.map((d) => d.label.trim());
  if (new Set(labels).size !== labels.length) return "Filesystem labels must be unique";
  // XFS labels are capped at 12 characters; ext4 allows 16.
  const tooLong = labels.find((l) => l.length > 12);
  if (tooLong) return `Label "${tooLong}" is longer than 12 characters`;

  const mounts = data.map((d) => d.mount.trim());
  if (new Set(mounts).size !== mounts.length) return "Mountpoints must be unique";

  return null;
}
