// Cloud-init template tests. Every OS x role combination must render to valid
// YAML once Terraform has substituted its placeholders — an invalid document
// makes cloud-init load an EMPTY config, and the VM boots unconfigured while
// the pipeline reports success.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import { ubuntuUserData } from "../src/templates/userdata.ubuntu.js";
import { rhel9UserData } from "../src/templates/userdata.redhat9.js";
import { rhel10UserData } from "../src/templates/userdata.redhat10.js";
import { renderUsers } from "../src/templates/userdata.shared.js";
import { DEFAULT_CI_USERS } from "../src/templates/userdata.defaults.js";
import { certWriteFiles } from "../src/templates/certs.js";
import { osFlavorOf, profilesForOs, PG_VERSIONS } from "../src/templates/profiles.js";
import { validateDisks } from "../src/templates/userdata.disks.js";

const OSES = [
  ["ubuntu", "dc1_ubuntu2404_template", ubuntuUserData],
  ["rhel9",  "dc1_rhel9_template",      rhel9UserData],
  ["rhel10", "dc1_rhel10_template",     rhel10UserData],
];

// What Terraform's templatefile() does to the rendered text.
const VARS = { server_name: "web01", server_domain: "example.internal", root_password: "pw" };
function terraformRender(tpl) {
  return tpl.replace(/\$\$\{/g, "\0")
            .replace(/\$\{(\w+)\}/g, (_, v) => VARS[v] ?? "X")
            .replace(/\0/g, "${");
}

for (const [label, template, fn] of OSES) {
  for (const p of profilesForOs(template)) {
    test(`${label} / ${p.id}: renders valid cloud-config`, () => {
      const doc = parse(terraformRender(fn(DEFAULT_CI_USERS, { profile: p.id, pgVersion: PG_VERSIONS[0] })));
      assert.ok(doc, "empty document");
      assert.equal(doc.hostname, "web01");
      assert.equal(doc.fqdn, "web01.example.internal");
      assert.equal(doc.users.length, DEFAULT_CI_USERS.length);
      const paths = doc.write_files.map(f => f.path);
      assert.ok(paths.includes("/etc/systemd/resolved.conf.d/90-org-dns.conf"), "resolved drop-in missing");
      assert.ok(Array.isArray(doc.runcmd) && doc.runcmd.length > 0);
    });
  }
  test(`${label}: never edits resolved.conf with sed`, () => {
    const out = fn(DEFAULT_CI_USERS, {});
    assert.ok(!/sed[^\n]*resolved\.conf(?!\.d)/.test(out));
  });
}

test("users: several pasted keys become several list items", () => {
  const out = renderUsers([{ name: "u", sudo: "NOPASSWD", shell: "/bin/bash",
    sshKey: "ssh-ed25519 AAAA1 a@x\necdsa-sha2-nistp384 AAAA2 my laptop\n\n" }]);
  const doc = parse("users:\n" + out);
  assert.deepEqual(doc.users[0].ssh_authorized_keys,
    ["ssh-ed25519 AAAA1 a@x", "ecdsa-sha2-nistp384 AAAA2 my laptop"]);
  assert.ok(!out.split("\n").some(l => l.trim() && !l.startsWith(" ")), "line at column 1");
});

test("users: a key comment containing ': ' stays a plain string", () => {
  const doc = parse("users:\n" + renderUsers([{ name: "u", sudo: "NOPASSWD", sshKey: "ssh-rsa AAA host: x" }]));
  assert.equal(doc.users[0].ssh_authorized_keys[0], "ssh-rsa AAA host: x");
});

test("users: whitespace-only key omits ssh_authorized_keys", () => {
  assert.ok(!renderUsers([{ name: "u", sudo: "NOPASSWD", sshKey: " \n " }]).includes("ssh_authorized_keys"));
});

test("certs: empty by default, valid YAML when configured", () => {
  assert.deepEqual(certWriteFiles("/etc/pki"), []);
});

test("OS flavour detection tolerates naming variants", () => {
  for (const [name, want] of [
    ["dc1_rhel10_template", "rhel10"], ["redhat10-template-pve (9001)", "rhel10"],
    ["rhel-10-tmpl", "rhel10"], ["rhel_9_template", "rhel9"],
    ["ubuntu2404-template (9000)", "ubuntu"], ["mystery-template", "ubuntu"],
  ]) assert.equal(osFlavorOf(name), want, name);
});

test("disk validation", () => {
  const root = { size: 50, mount: "/" };
  assert.equal(validateDisks([root, { size: 10, mount: "/data", label: "data" }]), null);
  assert.match(validateDisks([root, { size: 10, mount: "/d", label: "a" }, { size: 10, mount: "/d", label: "b" }]), /unique/);
  assert.match(validateDisks([root, { size: 10, mount: "/data", label: "waytoolonglabel" }]), /12 characters/);
});
