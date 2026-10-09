#!/bin/bash

# Store the generated root password in HashiCorp Vault / OpenBao (KV v2).
#
# The password arrives in the NEW_ROOT_PASSWORD environment variable (never
# argv — argv is visible in `ps` and can leak into logs):
#   NEW_ROOT_PASSWORD=... store_root_password.sh <hostname> <domain>
#
# Written to <VAULT_KV_MOUNT>/<VAULT_KV_PATH_PREFIX>/<hostname>.<domain>.
# KV v2 versions the secret, so re-creating a VM under the same name keeps
# the old password as an earlier version.
#
# The token needs only `create` + `update` on <mount>/data/<prefix>/*.

VAULT_ADDR="${VAULT_ADDR:-https://vault.example.internal:8200}"
VAULT_TOKEN="${TF_VAR_CI_TF_VAULT_TOKEN}"
KV_MOUNT="${VAULT_KV_MOUNT:-secret}"
KV_PATH_PREFIX="${VAULT_KV_PATH_PREFIX:-vms}"
VM_HOSTNAME="${1}"
VM_DOMAIN="${2}"
HOST_NAME="${VM_HOSTNAME}.${VM_DOMAIN}"
RESPONSE="$(mktemp)"
trap 'rm -f "$RESPONSE"' EXIT

fail() {
    echo "##############################################################"
    echo "# ERROR: $1"
    echo "# Root password of ${HOST_NAME} was NOT stored in Vault!"
    echo "##############################################################"
    exit 1
}

[ -z "${VM_HOSTNAME}" ] || [ -z "${VM_DOMAIN}" ] && fail "store_root_password.sh called without <hostname> <domain>"
[ -z "${NEW_ROOT_PASSWORD}" ] && fail "NEW_ROOT_PASSWORD is empty"
[ -z "${VAULT_TOKEN}" ] && fail "TF_VAR_CI_TF_VAULT_TOKEN not set in CI variables"
export NEW_ROOT_PASSWORD

# Neither secret touches argv: jq reads the password from the environment and
# pipes the body to curl's stdin, the token header comes from a config file
# on a file descriptor.
HTTP_CODE=$(jq -n --arg created "$(date +%Y-%m-%d_%H:%M:%S)" \
    '{data: {username: "root", password: env.NEW_ROOT_PASSWORD, created: $created}}' \
  | curl -s -o "$RESPONSE" -w '%{http_code}' \
      --config <(printf 'header = "X-Vault-Token: %s"\n' "$VAULT_TOKEN") \
      ${VAULT_NAMESPACE:+-H "X-Vault-Namespace: ${VAULT_NAMESPACE}"} \
      -H "Content-Type: application/json" \
      -X POST "${VAULT_ADDR}/v1/${KV_MOUNT}/data/${KV_PATH_PREFIX}/${HOST_NAME}" \
      -d @-)

case "${HTTP_CODE}" in
  2*)
    echo "Root password of ${HOST_NAME} stored in Vault at ${KV_MOUNT}/${KV_PATH_PREFIX}/${HOST_NAME} (HTTP ${HTTP_CODE})"
    ;;
  *)
    cat "$RESPONSE" 2>/dev/null
    echo
    fail "Vault rejected the password push (HTTP ${HTTP_CODE})"
    ;;
esac
