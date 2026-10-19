#!/usr/bin/env bash
# Default uninstall keeps a dated recovery copy. --purge deletes the marked app.
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ $# -eq 0 || ( $# -eq 1 && "$1" == --purge ) ]] || { echo "Usage: sudo bash remove.sh [--purge]"; exit 1; }
target=/opt/unmanned-boat-web
unit=/etc/systemd/system/unmanned-boat-web.service
[[ ! -L /opt && ! -L "$target" && ! -L "$unit" ]] || { echo "Refusing linked paths."; exit 1; }
if [[ ! -e "$target" ]]; then echo "Deployment does not exist."; exit 0; fi
[[ -f "$target/.boat-web-deployment" && "$(cat "$target/.boat-web-deployment")" == unmanned-boat-web-v1 ]] || { echo "Ownership marker missing; refusing."; exit 1; }
[[ -z "$(find "$target" -type l -print -quit)" ]] || { echo "Deployment contains symlinks; refusing."; exit 1; }
if [[ -e "$unit" ]]; then
  grep -qx '# Owned by unmanned-boat-web-v1' "$unit" || { echo "Unmanaged service; refusing."; exit 1; }
  systemctl disable --now unmanned-boat-web.service
  rm -- "$unit"
  systemctl daemon-reload
fi
if [[ "${1:-}" == --purge ]]; then
  rm -rf -- /opt/unmanned-boat-web
  echo "Permanently removed /opt/unmanned-boat-web."
else
  backup="/opt/unmanned-boat-web.removed-$(date -u +%Y%m%d%H%M%S)"
  [[ ! -e "$backup" ]] || { echo "Recovery path already exists."; exit 1; }
  mv -- /opt/unmanned-boat-web "$backup"
  echo "Removed service and deployment. Recovery copy: $backup"
fi
