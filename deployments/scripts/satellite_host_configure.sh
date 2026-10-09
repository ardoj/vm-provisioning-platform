#!/bin/bash

# Assign a Satellite host group and/or host collection to a freshly created
# VM. Runs in the postconfig stage after apply.
#
# Usage: satellite_host_configure.sh <hostname> <domain> <hostgroup> <host_collection>
#   hostgroup        e.g. "Linux/Prod" (nested groups by title) — "" to skip
#   host_collection  e.g. "web servers"                         — "" to skip
#
# The VM registers ITSELF via cloud-init (rh_subscription + activation key)
# a few minutes after the apply finishes, so this script polls until the
# host appears in Satellite before assigning. Ubuntu VMs never register —
# callers skip this script when no values are set in the tfvars.
#
# Uses the same account as satellite_host_delete.sh; it additionally needs:
#   edit_hosts, view_hostgroups, view_host_collections,
#   edit_host_collections, view_organizations

SATELLITE_URL="${SATELLITE_URL:-https://satellite.example.internal}"
SAT_USER="${TF_VAR_CI_TF_SATELLITE_USER}"
SAT_PASS="${TF_VAR_CI_TF_SATELLITE_PASSWORD}"
ORG_NAME="${SATELLITE_ORG:-Example}"
# Overridable for testing; defaults: 20 x 30s = 10 minutes
RETRIES="${SAT_CONFIGURE_RETRIES:-20}"
SLEEP="${SAT_CONFIGURE_SLEEP:-30}"

VM_HOSTNAME="${1}"
VM_DOMAIN="${2}"
HOSTGROUP="${3}"
HOST_COLLECTION="${4}"
HOST_NAME="${VM_HOSTNAME}.${VM_DOMAIN}"
TMP="/tmp/sat_cfg.$$"

fail() {
    rm -f "${TMP}"
    echo "##############################################################"
    echo "# ERROR: $1"
    echo "# Host ${HOST_NAME}: hostgroup/host collection NOT fully assigned!"
    echo "# Assign manually: ${SATELLITE_URL} -> Hosts -> All Hosts -> ${HOST_NAME}"
    echo "##############################################################"
    exit 1
}

sat_get() {
    # sat_get <path> [--data-urlencode search=...]  → HTTP code, body in $TMP
    curl -k -s -G -o "${TMP}" -w '%{http_code}' -u "${SAT_USER}:${SAT_PASS}" "$@" || true
}

if [ -z "${VM_HOSTNAME}" ] || [ -z "${VM_DOMAIN}" ]; then
    fail "called without hostname/domain"
fi
if [ -z "${HOSTGROUP}" ] && [ -z "${HOST_COLLECTION}" ]; then
    echo "No satellite_hostgroup / satellite_host_collection defined — nothing to do."
    exit 0
fi
if [ -z "${SAT_USER}" ] || [ -z "${SAT_PASS}" ]; then
    fail "TF_VAR_CI_TF_SATELLITE_USER / TF_VAR_CI_TF_SATELLITE_PASSWORD not set in CI variables"
fi

# ── wait for the VM to self-register ────────────────────────────────────────
HOST_ID=""
TRY=0
while [ "${TRY}" -lt "${RETRIES}" ]; do
    HTTP=$(sat_get "${SATELLITE_URL}/api/v2/hosts/${HOST_NAME}")
    case "${HTTP}" in
      200)
        HOST_ID=$(jq -r '.id' "${TMP}")
        break
        ;;
      404)
        TRY=$((TRY + 1))
        echo "Waiting for ${HOST_NAME} to register in Satellite... (${TRY}/${RETRIES})"
        sleep "${SLEEP}"
        ;;
      401|403)
        fail "Satellite authentication failed (HTTP ${HTTP}) — check the CI credentials"
        ;;
      *)
        cat "${TMP}" 2>/dev/null
        fail "unexpected response from Satellite host lookup (HTTP ${HTTP})"
        ;;
    esac
done

if [ -z "${HOST_ID}" ] || [ "${HOST_ID}" == "null" ]; then
    fail "host did not register in Satellite within $((RETRIES * SLEEP / 60)) minutes — did cloud-init registration fail?"
fi
echo "Host ${HOST_NAME} registered (id ${HOST_ID})"

# ── host group ──────────────────────────────────────────────────────────────
if [ -n "${HOSTGROUP}" ]; then
    # nested groups are addressed by title ("Parent/Child"); flat ones by name
    HTTP=$(sat_get "${SATELLITE_URL}/api/v2/hostgroups" --data-urlencode "search=title=\"${HOSTGROUP}\"")
    HG_ID=$(jq -r '.results[0].id' "${TMP}" 2>/dev/null)
    if [ -z "${HG_ID}" ] || [ "${HG_ID}" == "null" ]; then
        HTTP=$(sat_get "${SATELLITE_URL}/api/v2/hostgroups" --data-urlencode "search=name=\"${HOSTGROUP}\"")
        HG_ID=$(jq -r '.results[0].id' "${TMP}" 2>/dev/null)
    fi
    if [ -z "${HG_ID}" ] || [ "${HG_ID}" == "null" ]; then
        fail "host group '${HOSTGROUP}' not found in Satellite"
    fi

    HTTP=$(curl -k -s -o "${TMP}" -w '%{http_code}' -u "${SAT_USER}:${SAT_PASS}" \
      -X PUT -H "Content-Type: application/json" \
      -d "{\"host\":{\"hostgroup_id\":${HG_ID}}}" \
      "${SATELLITE_URL}/api/v2/hosts/${HOST_ID}" || true)
    case "${HTTP}" in
      200) echo "Host group '${HOSTGROUP}' assigned to ${HOST_NAME}" ;;
      *)   cat "${TMP}" 2>/dev/null; fail "assigning host group failed (HTTP ${HTTP})" ;;
    esac
fi

# ── host collection ─────────────────────────────────────────────────────────
if [ -n "${HOST_COLLECTION}" ]; then
    HTTP=$(sat_get "${SATELLITE_URL}/katello/api/organizations" --data-urlencode "search=name=\"${ORG_NAME}\"")
    ORG_ID=$(jq -r '.results[0].id' "${TMP}" 2>/dev/null)
    if [ -z "${ORG_ID}" ] || [ "${ORG_ID}" == "null" ]; then
        fail "organization '${ORG_NAME}' not found (missing view_organizations permission?)"
    fi

    HTTP=$(sat_get "${SATELLITE_URL}/katello/api/organizations/${ORG_ID}/host_collections" \
      --data-urlencode "search=name=\"${HOST_COLLECTION}\"")
    HC_ID=$(jq -r '.results[0].id' "${TMP}" 2>/dev/null)
    if [ -z "${HC_ID}" ] || [ "${HC_ID}" == "null" ]; then
        fail "host collection '${HOST_COLLECTION}' not found in Satellite"
    fi

    HTTP=$(curl -k -s -o "${TMP}" -w '%{http_code}' -u "${SAT_USER}:${SAT_PASS}" \
      -X PUT -H "Content-Type: application/json" \
      -d "{\"host_ids\":[${HOST_ID}]}" \
      "${SATELLITE_URL}/katello/api/host_collections/${HC_ID}/add_hosts" || true)
    case "${HTTP}" in
      2*) echo "Host ${HOST_NAME} added to host collection '${HOST_COLLECTION}'" ;;
      *)  cat "${TMP}" 2>/dev/null; fail "adding to host collection failed (HTTP ${HTTP})" ;;
    esac
fi

rm -f "${TMP}"
echo "Satellite postconfig for ${HOST_NAME} done."
