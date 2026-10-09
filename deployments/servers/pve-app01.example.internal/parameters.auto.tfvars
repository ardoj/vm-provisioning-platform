vm_name               = "pve-app01"
vm_domain             = "example.internal"
# pve_cluster selects the PVE_CI_TOKEN_<key> / PVE_CI_SSH_KEY_<key> CI variables
pve_cluster           = "test"
CI_TF_PVE_ENDPOINT    = "https://pve-test01.example.internal:8006/"
node_name             = "pve-node01"
clone_vm_id           = 9002
cpu                   = 2
mem                   = 4
# SDN vnets carry the VLAN tag themselves — NIC vlan stays null
vm_network1           = "vnet100"
vm_network1_vlan      = null
vm_network2           = ""
vm_network2_vlan      = null
vm_network3           = ""
vm_network3_vlan      = null
gateway               = "203.0.113.1"
dns_server_list       = ["192.0.2.53", "198.51.100.53"]
disks = [
  { size = 50, datastore_id = "local-lvm" },
]
tags                  = ["Platform","Test"]
snippets_datastore_id = "local"
nic1_ipv4_cidr        = "203.0.113.0/25"
nic2_ipv4_cidr        = ""
nic3_ipv4_cidr        = ""
dns_name_nic2         = ""
dns_name_nic3         = ""
satellite_hostgroup   = "Linux/Prod"
satellite_host_collection = "patch-window-1"
