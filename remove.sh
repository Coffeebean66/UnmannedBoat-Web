#!/usr/bin/env bash
# Default uninstall keeps recovery copies. --purge removes only marked app/config.
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ $# -eq 0 || ( $# -eq 1 && "$1" == --purge ) ]] || { echo "Usage: sudo bash remove.sh [--purge]"; exit 1; }
target=/opt/unmanned-boat-web
unit=/etc/systemd/system/unmanned-boat-web.service
config=/etc/unmanned-boat-web
broker_unit=/etc/systemd/system/unmanned-boat-mqtt.service
update_helper=/usr/local/lib/unmanned-boat-web-update
update_state=/var/lib/unmanned-boat-web-update
update_unit=/etc/systemd/system/unmanned-boat-web-update.service
update_path=/etc/systemd/system/unmanned-boat-web-update.path
update_dropin=/etc/systemd/system/unmanned-boat-web.service.d/30-update.conf
for path in /opt /etc /etc/systemd /etc/systemd/system /usr /usr/local /usr/local/lib /var /var/lib "$target" "$unit" "$config" "$broker_unit" "$update_helper" "$update_state" "$update_unit" "$update_path" "$update_dropin"; do
  [[ ! -L "$path" ]] || { echo "Refusing linked paths."; exit 1; }
done
if [[ ! -e "$target" && ! -e "$config" && ! -e "$unit" && ! -e "$broker_unit" && ! -e "$update_helper" && ! -e "$update_state" && ! -e "$update_unit" && ! -e "$update_path" && ! -e "$update_dropin" ]]; then echo "Deployment does not exist."; exit 0; fi
# Validate all existing targets before changing any service.
if [[ -e "$target" ]]; then
  [[ -f "$target/.boat-web-deployment" && "$(cat "$target/.boat-web-deployment")" == unmanned-boat-web-v1 ]] || { echo "App ownership marker missing; refusing."; exit 1; }
  [[ -z "$(find "$target" -type l -print -quit)" ]] || { echo "Deployment contains symlinks; refusing."; exit 1; }
fi
if [[ -e "$config" ]]; then
  [[ ( -f "$config/.boat-cloud-deployment" && "$(cat "$config/.boat-cloud-deployment")" == unmanned-boat-cloud-v1 ) || ( -f "$config/.boat-update-deployment" && "$(cat "$config/.boat-update-deployment")" == unmanned-boat-update-v1 ) ]] || { echo "Cloud ownership marker missing; refusing."; exit 1; }
  [[ -z "$(find "$config" -type l -print -quit)" ]] || { echo "Cloud configuration contains symlinks; refusing."; exit 1; }
fi
if [[ -e "$unit" ]]; then grep -qx '# Owned by unmanned-boat-web-v1' "$unit" || { echo "Unmanaged web service; refusing."; exit 1; }; fi
if [[ -e "$broker_unit" ]]; then grep -qx '# Owned by unmanned-boat-cloud-v1' "$broker_unit" || { echo "Unmanaged MQTT service; refusing."; exit 1; }; fi
for directory in "$update_helper" "$update_state"; do
  if [[ -e "$directory" ]]; then
    [[ -f "$directory/.boat-update-deployment" && ! -L "$directory/.boat-update-deployment" && "$(cat "$directory/.boat-update-deployment")" == unmanned-boat-update-v1 ]] || { echo "Updater ownership marker missing; refusing."; exit 1; }
  fi
done
for file in "$update_unit" "$update_path" "$update_dropin"; do
  if [[ -e "$file" ]]; then grep -qx '# Owned by unmanned-boat-update-v1' "$file" || { echo "Unmanaged updater service; refusing."; exit 1; }; fi
done
backup="$(mktemp -d /opt/unmanned-boat-web.removed-XXXXXX)"
chmod 700 "$backup"
# Stop the queue before the independent worker, then preserve all trusted bootstrap
# and administrator recovery files even for --purge. Do not touch other services.
if [[ -e "$update_path" ]]; then systemctl disable --now unmanned-boat-web-update.path; fi
if [[ -e "$update_unit" ]]; then systemctl stop unmanned-boat-web-update.service; fi
for file in "$update_unit" "$update_path" "$update_dropin"; do
  [[ ! -e "$file" ]] || mv -- "$file" "$backup/$(basename -- "$file")"
done
[[ ! -e "$update_helper" ]] || mv -- "$update_helper" "$backup/update-helper"
[[ ! -e "$update_state" ]] || mv -- "$update_state" "$backup/update-state"
if [[ -f "$config/update.env" ]]; then
  install -d -m 700 "$backup/update-credentials"
  cp -p -- "$config/update.env" "$backup/update-credentials/"
  [[ ! -f "$config/update-access.txt" ]] || cp -p -- "$config/update-access.txt" "$backup/update-credentials/"
fi
if [[ -e "$unit" ]]; then
  systemctl disable --now unmanned-boat-web.service
  mv -- "$unit" "$backup/unmanned-boat-web.service"
fi
if [[ -e "$broker_unit" ]]; then
  systemctl disable --now unmanned-boat-mqtt.service
  mv -- "$broker_unit" "$backup/unmanned-boat-mqtt.service"
fi
systemctl daemon-reload
if [[ "${1:-}" == --purge ]]; then
  [[ ! -e "$target" ]] || rm -rf -- /opt/unmanned-boat-web
  [[ ! -e "$config" ]] || rm -rf -- /etc/unmanned-boat-web
  echo "Permanently removed marked app and cloud configuration. Unit recovery files: $backup"
else
  [[ ! -e "$target" ]] || mv -- "$target" "$backup/app"
  [[ ! -e "$config" ]] || mv -- "$config" "$backup/cloud-config"
  echo "Removed only the managed services. Recovery copy (root only): $backup"
  echo "To recover, restore app to /opt/unmanned-boat-web, cloud-config to /etc/unmanned-boat-web and saved units to /etc/systemd/system; then daemon-reload and enable --now the services."
fi
echo "Node.js, Mosquitto packages, /var/lib/unmanned-boat-mqtt, Nginx and other sites were kept."
echo "Persistent map/account settings under /var/lib/unmanned-boat-web, when present, were kept."
echo "Updater helper, state and administrator credentials (when present) were saved under $backup; its dedicated account/group were kept for recovery."
