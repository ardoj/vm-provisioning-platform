// ─────────────────────────────────────────────────────────────
//  DEFAULT USERS
//  These users are added to every VM regardless of what is
//  selected in the GUI. Edit this list to manage defaults.
//  sudo options: "NOPASSWD" | "PASSWD" | "NONE"
//
//  NOTE: sshKey here is only a FALLBACK. At load the portal
//  fetches <name>.pub live from the SSH key directory (SSH_KEY_DIR_URL)
//  and uses that instead — rotate/revoke keys there, not here.
//  Removing a leaver still requires removing their entry below.
// ─────────────────────────────────────────────────────────────
export const DEFAULT_CI_USERS = [
  { id: "default-1", name: "alice.admin", uid: 2001, sudo: "NOPASSWD", shell: "/bin/bash", sshKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYEXAMPLEKEYEXAMPLEKEYEXAMPLEaa alice@example.com" },
  { id: "default-2", name: "bob.admin", uid: 2002, sudo: "NOPASSWD", shell: "/bin/bash", sshKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYEXAMPLEKEYEXAMPLEKEYEXAMPLEbb bob@example.com" },
];
