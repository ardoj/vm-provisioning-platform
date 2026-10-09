// Organisation CA certificates installed into every VM's trust store.
//
// Paste your internal root / intermediate CA certificates (PEM) into
// ORG_CA_CERTS. Each entry becomes one file under the OS trust anchor
// directory; the OS templates then run update-ca-certificates /
// update-ca-trust. Empty = nothing is written and the public CA bundle is used.
export const ORG_CA_CERTS = [
  // { file: "org-root-ca.crt", pem: `-----BEGIN CERTIFICATE-----
  // ...
  // -----END CERTIFICATE-----` },
];

export function certWriteFiles(dir) {
  return ORG_CA_CERTS.flatMap(({ file, pem }) => [
    `  - path: ${dir}/${file}`,
    "    content: |",
    ...pem.trim().split("\n").map(l => `      ${l.trim()}`),
    "    owner: root:root",
    "    permissions: '0644'",
    "",
  ]);
}
