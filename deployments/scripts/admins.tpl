# default admin users — rendered into every VM's cloud-init as ${admins}
  - name: alice.admin
    uid: 2001
    groups: ["admins", "users"]
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYEXAMPLEKEYEXAMPLEKEYEXAMPLEaa alice@example.com
  - name: bob.admin
    uid: 2002
    groups: ["admins", "users"]
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYEXAMPLEKEYEXAMPLEKEYEXAMPLEbb bob@example.com
