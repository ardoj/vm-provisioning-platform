#!/bin/bash
#
# Report which vsphere-clone-vm module version every server folder pins.
# Run from anywhere inside the repo:  ./scripts/module_versions.sh [version]
#
# With a version argument, lists only the folders pinned to that version
# (useful when planning upgrades folder by folder).

cd "$(dirname "$0")/.." || exit 1

if [ -n "$1" ]; then
    echo "== folders pinned to version $1 =="
    grep -l "version = \"$1\"" servers/*/main.tf 2>/dev/null | xargs -r -n1 dirname
    exit 0
fi

echo "== module version -> folder count =="
grep -rh 'version = "' servers/*/main.tf 2>/dev/null | sed 's/^ *//' | sort | uniq -c | sort -rn

echo
echo "== module source -> folder count =="
grep -rh 'source  *=' servers/*/main.tf 2>/dev/null | sed 's/^ *//' | sort | uniq -c | sort -rn

echo
echo "== per-folder pins (oldest version first) =="
for f in servers/*/main.tf; do
    v=$(grep -oE 'version = "[^"]+"' "$f" | head -1 | cut -d'"' -f2)
    printf '%-18s %s\n' "${v:-<none>}" "$(dirname "$f")"
done | sort
