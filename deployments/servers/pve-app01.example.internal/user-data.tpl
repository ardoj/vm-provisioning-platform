#cloud-config

growpart:
  mode: auto
  devices: ['/']

resize_rootfs: true

manage_etc_hosts: false

# Set the hostname in the early init stage. PVE's NoCloud meta-data carries
# no local-hostname (VMware customization does), so without this the
# template's leftover hostname survives into modules-config — and Satellite
# (rh_subscription) registers the host under the WRONG name, breaking the
# postconfig host-group step and the delete pipeline's Satellite removal.
hostname: ${server_name}
fqdn: ${server_name}.${server_domain}
prefer_fqdn_over_hostname: true

rh_subscription:
  activation-key: ak-rhel10
  org: EXAMPLE_ORG
#  auto-attach: true
  rhsm-baseurl: https://satellite.example.internal/pulp/content
  server-hostname: satellite.example.internal

package_reboot_if_required: true
package_update: true
package_upgrade: true

ntp:
  enabled: true
  ntp_client: chrony
  servers:
    - ntp.example.internal

# No extra disks requested. Example of what a data disk looks like:
#fs_setup:
#  - label: data
#    filesystem: 'xfs'
#    device: '/dev/sdb'
#    overwrite: false
#
#mounts:
#  - [ 'LABEL=data', '/storage/disk01', 'xfs', 'defaults', '0', '0' ]

timezone: "UTC"

# admins group (provides passwordless sudo)
groups:
  - admins

# default admin users
users:
  - name: alice.admin
    uid: 2001
    groups: admins
    shell: /bin/bash
    ssh_authorized_keys:
      - 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYEXAMPLEKEYEXAMPLEKEYEXAMPLEaa alice@example.com'
  - name: bob.admin
    uid: 2002
    groups: admins
    shell: /bin/bash
    ssh_authorized_keys:
      - 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYEXAMPLEKEYEXAMPLEKEYEXAMPLEbb bob@example.com'

packages:
  - mc
  - vim
  - nano
  - bash-completion
  - htop
  - tmux
  - net-tools
  - git
  - curl
  - wget
  - katello-host-tools-tracer
  - lsof
  - cloud-utils-growpart
# mail
  - postfix
  - s-nail
# dns cache
  - systemd-resolved
# get needs-restarting bin
  - yum-utils
# monitoring agent
  - alloy


# passwordless admins group
write_files:
  - path: /etc/sudoers.d/admins
    content: |
      %admins ALL=(ALL) NOPASSWD:ALL
    permissions: '0440'
    owner: root:root

  - path: /etc/profile.d/custom_bash_prompt.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # Customize the Bash prompt to display the full hostname
      export PS1="[\u@\H \w]\\$ "

  - path: /etc/profile.d/custom_bash_history.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # Set the maximum number of lines in the history file
      export HISTSIZE=20000
      # Set the format of the timestamp to be included in the history
      export HISTTIMEFORMAT="%F %T "
      # Ensure that the history file is appended with each new session
      shopt -s histappend


  - path: /etc/alloy/config.alloy
    content: |
      prometheus.exporter.unix "host" { }

      prometheus.scrape "host" {
        targets         = prometheus.exporter.unix.host.targets
        forward_to      = [prometheus.relabel.host.receiver]
        scrape_interval = "60s"
      }

      prometheus.relabel "host" {
        forward_to = [prometheus.remote_write.default.receiver]

        rule {
          target_label = "instance"
          replacement  = "${server_name}.${server_domain}"
        }
      }

      prometheus.remote_write "default" {
        endpoint {
          url = "https://metrics.example.internal/api/v1/write"
        }
      }
    owner: root:root
    permissions: '0644'

  - path: /etc/pki/rpm-gpg/RPM-GPG-KEY-grafana
    permissions: '0644'
    owner: root:root
    content: |
      -----BEGIN PGP PUBLIC KEY BLOCK-----

      mQGNBGTnhmkBDADUE+SzjRRyitIm1siGxiHlIlnn6KO4C4GfEuV+PNzqxvwYO+1r
      mcKlGDU0ugo8ohXruAOC77Kwc4keVGNU89BeHvrYbIftz/yxEneuPsCbGnbDMIyC
      k44UOetRtV9/59Gj5YjNqnsZCr+e5D/JfrHUJTTwKLv88A9eHKxskrlZr7Un7j3i
      Ef3NChlOh2Zk9Wfk8IhAqMMTferU4iTIhQk+5fanShtXIuzBaxU3lkzFSG7VuAH4
      CBLPWitKRMn5oqXUE0FZbRYL/6Qz0Gt6YCJsZbaQ3Am7FCwWCp9+ZHbR9yU+bkK0
      Dts4PNx4Wr9CktHIvbypT4Lk2oJEPWjcCJQHqpPQZXbnclXRlK5Ea0NVpaQdGK+v
      JS4HGxFFjSkvTKAZYgwOk93qlpFeDML3TuSgWxuw4NIDitvewudnaWzfl9tDIoVS
      Bb16nwJ8bMDzovC/RBE14rRKYtMLmBsRzGYHWd0NnX+FitAS9uURHuFxghv9GFPh
      eTaXvc4glM94HBUAEQEAAbQmR3JhZmFuYSBMYWJzIDxlbmdpbmVlcmluZ0BncmFm
      YW5hLmNvbT6JAdQEEwEKAD4CGwMFCwkIBwIGFQoJCAsCBBYCAwECHgECF4AWIQS1
      Oud7rbYwpoMEYAWWP6J3EEWFRQUCaKhvPQUJB4NP1AAKCRCWP6J3EEWFRUjOC/9Y
      dWOWJLJVKzLx8uv5YVzebyw15HevhKahbznJX5fHnE8irjkiPFltVEZ4T37s5afR
      GBEJnR1UFd80s7jzwbuoZh/zEB3jN8q50g64AznuzDa0PWKzaY7Tgkssx3+hs6TS
      vIwV4z8T7f56lDudeHxHXx+htRnZ3ebKNPCJS7+G12GF6W3C3znpdjgvhVUB0uxd
      +42V0fRqk2GLNZeKS9988fi5dYRAy9Ozwced7ByCFjde9FBgUtrH3mG1/ibzLEh0
      4k02nYjc8mrH32t4UCWpxQEJ1vZA2vT2HN3/cH/4uyFdyU6OHkMyMbz6lmeXe71d
      F5hOB4+/RP6Ndyj7ViRNDbm70NRBaFne/+YOJvmMfJTCh7YbF5qEn1ihGkJJ0ohE
      u2IB+EGEhyiDm8SIsj1uMw7n17iIPNtbsU5GgnmLtfguP/WbwKV2UeuxTpiOeYb6
      blDwRlh48uHMlA5HBW+487Jktw3iPj1IKhdtAC9CU3xAvzDcseMbgmM6Xj2bSQG5
      AY0EZOeGaQEMALNIFUricEIwtZiX7vSDjwxobbqPKqzdek8x3ud0CyYlrbGHy0k+
      FDEXstjJQQ1s9rjJSu3sv5wyg9GDAUH3nzO976n/ZZvKPti3p2XU2UFx5gYkaaFV
      D56yYxqGY0YU5ft6BG+RUz3iEPg3UBUzt0sCIYnG9+CsDqGOnRYIIa46fu2/H9Vu
      8JvvSq9xbsK9CfoQDkIcoQOixPuI4P7eHtswCeYR/1LUTWEnYQWsBCf57cEpzR6t
      7mlQnzQo9z4i/kp4S0ybDB77wnn+isMADOS+/VpXO+M7Zj5tpfJ6PkKch3SGXdUy
      3zht8luFOYpJr2lVzp7n3NwB4zW08RptTzTgFAaW/NH2JjYI+rDvQm4jNs08Dtsp
      nm4OQvBA9Df/6qwMEOZ9i10ixqk+55UpQFJ3nf4uKlSUM7bKXXVcD/odq804Y/K4
      y3csE059YVIyaPexEvYSYlHE2odJWRg2Q1VehmrOSC8Qps3xpU7dTHXD74ZpaYbr
      haViRS5v/lCsiwARAQABiQG8BBgBCgAmAhsMFiEEtTrne622MKaDBGAFlj+idxBF
      hUUFAmiobzkFCQeDT9AACgkQlj+idxBFhUVsmQwA0PA/zd7NqtnZ/Z8857gp2Wq2
      /e4EX8nRjsW2ZlrZfbU5oMQv9OZZ4z1UjIKEUV+TnCwXEKXTMJomdekQSSayVVx/
      u5w+0YM8gRuQGrG8hW0GRR8sHIeuwBFlyQrlwxUwXvDOPDYyieETjaQqMucupIKo
      IPm3CjFySvfizvSWUVSWBnGmQfpv6OiGYawvwfewcQHUdLMgWN3lYlzGQJL4+OMm
      7XcB8VNTa586Q00fmjDfktHYvGpmhqr3gsd4gS3AjTk0zI65qXBRJkdqVnwUrMUD
      8TcxXYNXf90mhR0NWkLmp6kBYiW8+QY6ndMmRVpodg1A87qgMYaZUAAlxCS4XKTU
      r+/YMDYOWgLN6i4UeYG/3/hsnAEHm5ITojfh6cLfdlhjohFTnD0IYw3AsNJXRzKB
      1g5FTBKLLLIdXgS/3rWV1qjAd3drQVIMCku6HKl/vT4ftrBHeSyV7eLwOYbe3/bw
      8VMx+lmMheD8/qJMia1om0iBBRSXRjY//f+Lllqm
      =TH3J
      -----END PGP PUBLIC KEY BLOCK-----

  - path: /etc/yum.repos.d/grafana.repo
    content: |
      [grafana]
      name=grafana
      baseurl=https://rpm.grafana.com
      enabled=1
      gpgcheck=1
      repo_gpgcheck=1
      gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-grafana
      sslverify=1

  - path: /etc/systemd/resolved.conf.d/90-org-dns.conf
    content: |
      [Resolve]
      DNS=192.0.2.53 198.51.100.53
      Domains=~.
      DNSSEC=no
      Cache=yes
    owner: root:root
    permissions: '0644'

runcmd:
# cant set gid when creating group, so we do it here
  - [ groupmod, -g, 1200, admins ]
# set hostname
  - [ /usr/bin/hostnamectl, --static, --pretty, --transient, set-hostname, ${server_name}.${server_domain} ]
# rename VMware NetworkManager connections
  - |
    nmcli -t -f NAME connection show | grep '^VMware customization' | while read -r c; do
      iface=$(nmcli -g connection.interface-name connection show "$c")
      nmcli connection modify "$c" connection.id "$iface"
    done
# remove template cleanup script
  - [ rm, -f, /root/clean_vm.sh ]
  - [ /bin/sh, -c, "echo 'root:${root_password}' | chpasswd" ]
  - [ /bin/mkdir, -p, /var/log/journal ]
  - [ /usr/bin/systemd-tmpfiles, --create, --prefix=/var/log/journal ]
  - [ /usr/bin/journalctl, --flush ]
# certs
  - [ /usr/bin/update-ca-trust ]
# mail
  - [ /bin/sed, -i, '/^relayhost/d', /etc/postfix/main.cf ]
  - [ /bin/sed, -i, '/^\#relayhost = \[an./a relayhost = smtp.example.internal', /etc/postfix/main.cf ]
  - [ /bin/sed, -i, '/^\#mydomain = domain.tld/a mydomain = example.internal', /etc/postfix/main.cf ]
  - [ /bin/sed, -i, '/^\#root/a root:    root-alerts@example.com', /etc/aliases ]
  - [ /bin/systemctl, enable, postfix ]
  - [ /bin/systemctl, start, postfix ]
  - [ /bin/systemctl, restart, postfix ]
  - [ /usr/bin/newaliases ]
  - [ /bin/systemctl, enable, --now, chronyd ]
# DNS cache
  - [ /bin/systemctl, enable, --now, systemd-resolved ]
  - /bin/sh -c "if [ -f /run/systemd/resolve/stub-resolv.conf ]; then /usr/bin/mv /etc/resolv.conf /etc/resolv.conf.backup; fi"
  - /bin/sh -c "if [ -f /run/systemd/resolve/stub-resolv.conf ]; then /usr/bin/ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf; fi"
# monitoring agent (grafana alloy)
  - /bin/systemctl enable alloy || true
  - /bin/systemctl restart alloy || true
# reboot checks
  - /bin/sh -c "if ! /usr/sbin/subscription-manager identity > /dev/null 2>&1; then /usr/bin/cloud-init clean && /sbin/reboot; fi"
  - /bin/sh -c "if ! /usr/bin/which postfix ; then /usr/bin/cloud-init clean && /sbin/reboot; fi"
# disable cloud-init if systemd-resolved is running
  - /bin/sh -c "if [ -f /run/systemd/resolve/stub-resolv.conf ]; then /usr/bin/touch /etc/cloud/cloud-init.disabled ; fi"
  - /bin/sh -c "if [ -f /run/systemd/resolve/stub-resolv.conf ]; then /usr/bin/systemctl stop cloud-init ; fi"
  - /bin/sh -c "if [ -f /run/systemd/resolve/stub-resolv.conf ]; then /usr/bin/systemctl disable cloud-init ; fi"
  - /bin/sh -c "if [ -f /run/systemd/resolve/stub-resolv.conf ]; then /usr/bin/dnf remove cloud-init -y; fi"
# restart if needed
  - /bin/sh -c "if /usr/bin/needs-restarting -r; then exit 0; else /sbin/reboot; fi"
