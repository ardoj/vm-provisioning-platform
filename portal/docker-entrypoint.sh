#!/bin/sh

# Frontend config. Everything here is readable by any browser that loads the
# portal: put NO secrets here except where noted. The GitLab token is injected
# server-side by the /glproxy/ location below and never reaches the browser.
cat > /usr/share/nginx/html/config.js <<EOF
window.ENV = {
  GITLAB_URL:    "${GITLAB_URL}",
  PROJECT_ID:    "${PROJECT_ID}",
  REPO_BRANCH:   "${REPO_BRANCH}",
  SERVERS_DIR:   "${SERVERS_DIR}",
  REPO_PATH:     "${REPO_PATH}",
  MODULE_REGISTRY: "${MODULE_REGISTRY}",
  MODULE_VERSION: "${MODULE_VERSION}",
  MODULE_VERSION_PVE: "${MODULE_VERSION_PVE}",
  PVE_ENDPOINTS: "${PVE_ENDPOINTS}",
  # KNOWN LIMITATION: the vSphere SOAP login sends credentials in the request
  # body, which nginx cannot inject — so these two ARE exposed to the browser.
  # Use a read-only vCenter account. See README "Security".
  VCENTER_USER:  "${VCENTER_USER}",
  VCENTER_PASS:  "${VCENTER_PASS}",
};
EOF

# Hosts for proxy Host headers, derived from the configured URLs
GITLAB_HOST=$(printf '%s' "${GITLAB_URL}" | sed -E 's#^https?://##; s#/.*##')
SSH_KEY_DIR_URL="${SSH_KEY_DIR_URL:-http://files.example.internal/ssh}"
SSH_KEY_DIR_HOST=$(printf '%s' "${SSH_KEY_DIR_URL}" | sed -E 's#^https?://##; s#/.*##')

# Base64-encode vCenter credentials for nginx proxy_set_header
VCENTER_B64=$(printf '%s:%s' "${VCENTER_USER}" "${VCENTER_PASS}" | base64 | tr -d '\n')

# Proxmox proxy blocks — one location per endpoint from PVE_ENDPOINTS
# ("key=host:port,key2=host:port"). Tokens: PVE_API_TOKEN_<key>, falling back
# to the shared PVE_API_TOKEN. Use READ-ONLY tokens here (Sys.Audit /
# VM.Audit / Datastore.Audit / SDN.Audit): this proxy is unauthenticated like
# /vcproxy/, and the form only reads inventory. Legacy single PVE_ENDPOINT is
# treated as "test=<endpoint>".
ENDPOINTS_LIST="${PVE_ENDPOINTS}"
if [ -z "${ENDPOINTS_LIST}" ] && [ -n "${PVE_ENDPOINT}" ]; then
    ENDPOINTS_LIST="test=${PVE_ENDPOINT}"
fi
PVE_PROXY_BLOCK=""
OLDIFS="$IFS"; IFS=','
for entry in ${ENDPOINTS_LIST}; do
    IFS="$OLDIFS"
    key="${entry%%=*}"
    host="${entry#*=}"
    [ -z "${key}" ] || [ "${key}" = "${host}" ] && continue
    tok=$(eval "printf '%s' \"\${PVE_API_TOKEN_${key}:-\${PVE_API_TOKEN}}\"")
    PVE_PROXY_BLOCK="${PVE_PROXY_BLOCK}
    # Proxmox API proxy: ${key}
    location /pveproxy/${key}/ {
        proxy_pass          https://${host}/;
        proxy_http_version  1.1;
        proxy_ssl_verify    off;
        proxy_set_header    Authorization \"PVEAPIToken=${tok}\";
        proxy_hide_header   Access-Control-Allow-Origin;
    }
"
    IFS=','
done
IFS="$OLDIFS"

# Generate nginx config with vCenter reverse proxy
cat > /etc/nginx/conf.d/default.conf <<EOF
server {
    listen 3000;
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback
    location / {
        try_files \$uri \$uri/ /index.html;
    }

${PVE_PROXY_BLOCK}

    # GitLab API proxy — the access token is added HERE, server-side, and the
    # location is scoped to the ONE project the portal commits to: any other
    # GitLab endpoint 404s, so the proxy cannot be used to reach the rest of
    # GitLab with the token.
    location /glproxy/api/v4/projects/${PROJECT_ID}/ {
        proxy_pass          ${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/;
        proxy_http_version  1.1;
        proxy_set_header    PRIVATE-TOKEN  "${GITLAB_TOKEN}";
        proxy_set_header    Host           ${GITLAB_HOST};
        proxy_hide_header   Access-Control-Allow-Origin;
    }

    # SSH public-key directory proxy (internal server, avoids browser CORS)
    location /sshproxy/ {
        proxy_pass         ${SSH_KEY_DIR_URL}/;
        proxy_http_version 1.1;
        proxy_set_header   Host ${SSH_KEY_DIR_HOST};
    }

    # vCenter proxy — DC1 REST (inject Basic auth)
    location /vcproxy/dc1/api/ {
        proxy_pass          https://${DC1_VCENTER}/api/;
        proxy_http_version  1.1;
        proxy_ssl_verify    off;
        proxy_set_header    Host              ${DC1_VCENTER};
        proxy_set_header    Authorization     "Basic ${VCENTER_B64}";
        proxy_set_header    X-Real-IP         \$remote_addr;
        proxy_hide_header   WWW-Authenticate;
        proxy_hide_header   Access-Control-Allow-Origin;
        proxy_hide_header   Set-Cookie;
    }

    # vCenter proxy — DC1 SOAP
    # Remove Secure flag (app runs over HTTP) and rewrite cookie Path to /vcproxy/dc1/
    # so DC1 and DC2 vmware_soap_session cookies are stored under separate paths in the browser.
    location /vcproxy/dc1/sdk {
        proxy_pass            https://${DC1_VCENTER}/sdk;
        proxy_http_version    1.1;
        proxy_ssl_verify      off;
        proxy_set_header      Host          ${DC1_VCENTER};
        proxy_set_header      X-Real-IP     \$remote_addr;
        proxy_set_header      Cookie        \$http_cookie;
        proxy_cookie_flags    vmware_soap_session nosecure;
        proxy_cookie_path     ~^/           /vcproxy/dc1/;
        proxy_hide_header     WWW-Authenticate;
        proxy_hide_header     Access-Control-Allow-Origin;
    }

    # vCenter proxy — DC2 REST (inject Basic auth)
    location /vcproxy/dc2/api/ {
        proxy_pass          https://${DC2_VCENTER}/api/;
        proxy_http_version  1.1;
        proxy_ssl_verify    off;
        proxy_set_header    Host              ${DC2_VCENTER};
        proxy_set_header    Authorization     "Basic ${VCENTER_B64}";
        proxy_set_header    X-Real-IP         \$remote_addr;
        proxy_hide_header   WWW-Authenticate;
        proxy_hide_header   Access-Control-Allow-Origin;
        proxy_hide_header   Set-Cookie;
    }

    # vCenter proxy — DC2 SOAP
    location /vcproxy/dc2/sdk {
        proxy_pass            https://${DC2_VCENTER}/sdk;
        proxy_http_version    1.1;
        proxy_ssl_verify      off;
        proxy_set_header      Host          ${DC2_VCENTER};
        proxy_set_header      X-Real-IP     \$remote_addr;
        proxy_set_header      Cookie        \$http_cookie;
        proxy_cookie_flags    vmware_soap_session nosecure;
        proxy_cookie_path     ~^/           /vcproxy/dc2/;
        proxy_hide_header     WWW-Authenticate;
        proxy_hide_header     Access-Control-Allow-Origin;
    }
}
EOF

exec nginx -g "daemon off;"
