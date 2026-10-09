#!/bin/bash

# Remove a host from Red Hat Satellite after its VM has been destroyed.
# Usage: satellite_host_delete.sh <hostname> <domain>
#
# RHEL VMs register as <hostname>.<domain> via their activation key; deleting
# the host also frees its subscription. Ubuntu VMs are never registered, so
# the 404 path makes this a silent no-op for them — no OS detection needed.
#
# Credentials: a dedicated Satellite account with only view_hosts +
# destroy_hosts permissions, via CI variables:
#   TF_VAR_CI_TF_SATELLITE_USER / TF_VAR_CI_TF_SATELLITE_PASSWORD

SATELLITE_URL="${SATELLITE_URL:-https://satellite.example.internal}"
SAT_USER="${TF_VAR_CI_TF_SATELLITE_USER}"
SAT_PASS="${TF_VAR_CI_TF_SATELLITE_PASSWORD}"
VM_HOSTNAME="${1}"
VM_DOMAIN="${2}"
HOST_NAME="${VM_HOSTNAME}.${VM_DOMAIN}"

fail() {
    echo "##############################################################"
    echo "# ERROR: $1"
    echo "# Host ${HOST_NAME} was NOT removed from Satellite!"
    echo "# Remove it manually: ${SATELLITE_URL} -> Hosts -> All Hosts"
    echo "##############################################################"
    exit 1
}

if [ -z "${VM_HOSTNAME}" ] || [ -z "${VM_DOMAIN}" ]; then
    fail "called without hostname/domain"
fi
if [ -z "${SAT_USER}" ] || [ -z "${SAT_PASS}" ]; then
    fail "TF_VAR_CI_TF_SATELLITE_USER / TF_VAR_CI_TF_SATELLITE_PASSWORD not set in CI variables"
fi

# Does the host exist?
HTTP=$(curl -k -s -o /tmp/sat_response.$$ -w '%{http_code}' \
  -u "${SAT_USER}:${SAT_PASS}" \
  "${SATELLITE_URL}/api/v2/hosts/${HOST_NAME}" || true)

case "${HTTP}" in
  404)
    echo "Host ${HOST_NAME} is not registered in Satellite (Ubuntu VM or never registered) — nothing to delete."
    rm -f /tmp/sat_response.$$
    exit 0
    ;;
  401|403)
    rm -f /tmp/sat_response.$$
    fail "Satellite authentication failed (HTTP ${HTTP}) — check the CI credentials"
    ;;
  200)
    ;;  # exists — proceed to delete
  *)
    cat /tmp/sat_response.$$ 2>/dev/null
    rm -f /tmp/sat_response.$$
    fail "unexpected response from Satellite host lookup (HTTP ${HTTP})"
    ;;
esac

HTTP=$(curl -k -s -o /tmp/sat_response.$$ -w '%{http_code}' \
  -X DELETE -u "${SAT_USER}:${SAT_PASS}" \
  "${SATELLITE_URL}/api/v2/hosts/${HOST_NAME}" || true)

case "${HTTP}" in
  2*)
    echo "Host ${HOST_NAME} removed from Satellite (HTTP ${HTTP})"
    rm -f /tmp/sat_response.$$
    ;;
  *)
    cat /tmp/sat_response.$$ 2>/dev/null
    rm -f /tmp/sat_response.$$
    fail "Satellite host delete failed (HTTP ${HTTP})"
    ;;
esac
