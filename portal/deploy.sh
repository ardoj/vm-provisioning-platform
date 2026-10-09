#!/bin/bash
set -e

IMAGE_NAME="vm-portal"
NR_FILE=".build-number"

# One container engine for every step — mixing podman and docker commands
# breaks on hosts where they are separate daemons with separate image stores.
if command -v podman >/dev/null 2>&1; then
    ENGINE=podman
elif command -v docker >/dev/null 2>&1; then
    ENGINE=docker
else
    echo "ERROR: neither podman nor docker found" >&2
    exit 1
fi
echo "Using container engine: $ENGINE"

echo "=== Stopping and removing all vm-portal containers ==="
# Remove all containers named vm-portal (any ID)
$ENGINE ps -a --filter "name=vm-portal" -q | xargs -r $ENGINE rm -f

echo "=== Reading and incrementing build number from $NR_FILE ==="
if [[ ! -f "$NR_FILE" ]]; then
    echo "0" > "$NR_FILE"
fi

CURRENT_NR=$(cat "$NR_FILE")
NEW_NR=$((CURRENT_NR + 1))

echo "$NEW_NR" > "$NR_FILE"

echo "New tag: $NEW_NR"

echo "=== Building new image vm-portal:$NEW_NR ==="
$ENGINE build -t ${IMAGE_NAME}:${NEW_NR} .

echo "=== Running new container ==="
$ENGINE run -d \
  -p 3000:3000 \
  --env-file portal.env \
  --name vm-portal \
  --restart unless-stopped \
  ${IMAGE_NAME}:${NEW_NR}

echo "=== Deployment complete ==="
$ENGINE ps | grep vm-portal

echo ""
echo "Running version tag: $NEW_NR"
