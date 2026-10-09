// src/templates/main.tf.js
// Generates main.tf with the correct vsphere provider alias baked in.
// This is necessary because Terraform provider aliases are meta-arguments
// and cannot be set via variables.

// Fallback when MODULE_VERSION is not set in the container env (gitlab.env).
// Prefer setting it there — upgrading the module then needs no rebuild.
// Registry prefix the generated main.tf pulls modules from (MODULE_REGISTRY env).
const MODULE_REGISTRY = (typeof window !== "undefined" && window.ENV && window.ENV.MODULE_REGISTRY)
  || "gitlab.example.internal/infra";

export const DEFAULT_MODULE_VERSION = "1.0.0";

export function generateMainTf(datacenter, moduleVersion = "") {
  const providerAlias = datacenter === "DC2" ? "vsphere.dc2" : "vsphere.dc1";
  const moduleName    = datacenter === "DC2" ? "dc2-server"  : "dc1-server";
  const version       = moduleVersion || DEFAULT_MODULE_VERSION;

  return `module "${moduleName}" {
  source  = "${MODULE_REGISTRY}/vsphere-clone-vm/main"
  version = "${version}"
  providers = {
    vsphere = ${providerAlias}
  }
  virtual_machines = {
    vm01 = {
      vm_parameters = {
        name              = var.vm_name
        vm_domain         = var.vm_domain
        datacenter        = var.datacenter
        cluster           = var.cluster
        folder            = var.folder
        datastore_cluster = var.datastore_cluster
        cpu               = var.cpu
        mem               = var.mem
        vm_template       = var.vm_template
        vm_network1       = var.vm_network1
        vm_network2       = var.vm_network2
        vm_network3       = var.vm_network3
        gateway           = var.gateway
        dns_server_list   = var.dns_server_list
        dns_suffix_list   = ["\${var.vm_domain}"]
        disks             = var.disks
        tags              = var.tags
      }
      ddi_host_records = [
        {
          fqdn      = "\${var.vm_name}.\${var.vm_domain}"
          ipv4_cidr = var.nic1_ipv4_cidr
        },
        {
          fqdn      = "\${var.dns_name_nic2}"
          ipv4_cidr = var.nic2_ipv4_cidr
        },
        {
          fqdn      = "\${var.dns_name_nic3}"
          ipv4_cidr = var.nic3_ipv4_cidr
        }
      ]
    }
  }
}
`;
}
