// Shared cloud-init user block renderer.
// sudo === "NOPASSWD" → added to "admins" group (group handles passwordless sudo)
// sudo === "PASSWD"   → explicit sudo line with password required
// sudo === "NONE"     → no sudo, no group
export function renderUsers(users) {
  return users.map(u => {
    const lines = [`  - name: ${u.name}`];

    // optional UID
    if (u.uid !== undefined && u.uid !== null) {
      lines.push(`    uid: ${u.uid}`);
    }

    if (u.sudo === "NOPASSWD") {
      lines.push(`    groups: admins`);
    } else if (u.sudo === "PASSWD") {
      lines.push(`    sudo: ALL=(ALL) ALL`);
    }

    lines.push(`    shell: ${u.shell || "/bin/bash"}`);

    // One list item per key. sshKey is free text pasted into the form, so it
    // may hold several keys separated by newlines — emitting it as a single
    // item put the 2nd key at column 1 and made the WHOLE user-data invalid
    // YAML. cloud-init then loaded an empty config and the VM booted with the
    // template's identity and none of its configuration, while the pipeline
    // reported success. Single-quote each key: an SSH comment containing
    // ": " would otherwise be parsed as a YAML mapping.
    const keys = (u.sshKey || "")
      .split("\n")
      .map(k => k.trim())
      .filter(Boolean);
    if (keys.length) {
      lines.push(`    ssh_authorized_keys:`);
      for (const k of keys) lines.push(`      - '${k.replace(/'/g, "''")}'`);
    }

    return lines.join("\n");
  }).join("\n");
}
