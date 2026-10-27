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
mqtt_admin_helper=/usr/local/lib/unmanned-boat-mqtt-admin
mqtt_admin_unit=/etc/systemd/system/unmanned-boat-mqtt-admin.service
mqtt_admin_socket=/etc/systemd/system/unmanned-boat-mqtt-admin.socket
mqtt_admin_dropin=/etc/systemd/system/unmanned-boat-web.service.d/40-mqtt-device-admin.conf
video_program=/usr/local/lib/unmanned-boat-video
video_config=/etc/unmanned-boat-video
video_unit=/etc/systemd/system/unmanned-boat-video.service
video_dropin=/etc/systemd/system/unmanned-boat-web.service.d/45-video-media.conf
video_present=0
for path in /opt /etc /etc/systemd /etc/systemd/system /etc/systemd/system/unmanned-boat-web.service.d /usr /usr/local /usr/local/lib /var /var/lib "$target" "$unit" "$config" "$broker_unit" "$update_helper" "$update_state" "$update_unit" "$update_path" "$update_dropin" "$mqtt_admin_helper" "$mqtt_admin_unit" "$mqtt_admin_socket" "$mqtt_admin_dropin" "$video_program" "$video_config" "$video_unit" "$video_dropin"; do
  [[ ! -L "$path" ]] || { echo "Refusing linked paths."; exit 1; }
done
if [[ ! -e "$target" && ! -e "$config" && ! -e "$unit" && ! -e "$broker_unit" && ! -e "$update_helper" && ! -e "$update_state" && ! -e "$update_unit" && ! -e "$update_path" && ! -e "$update_dropin" && ! -e "$mqtt_admin_helper" && ! -e "$mqtt_admin_unit" && ! -e "$mqtt_admin_socket" && ! -e "$mqtt_admin_dropin" && ! -e "$video_program" && ! -e "$video_config" && ! -e "$video_unit" && ! -e "$video_dropin" ]]; then echo "Deployment does not exist."; exit 0; fi
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
if [[ -e "$mqtt_admin_helper" ]]; then
  [[ -f "$mqtt_admin_helper/.boat-mqtt-admin-deployment" && ! -L "$mqtt_admin_helper/.boat-mqtt-admin-deployment" && "$(cat "$mqtt_admin_helper/.boat-mqtt-admin-deployment")" == unmanned-boat-mqtt-admin-v1 ]] || { echo "MQTT administration ownership marker missing; refusing."; exit 1; }
  [[ -z "$(find "$mqtt_admin_helper" -type l -print -quit)" ]] || { echo "MQTT administration helper contains symlinks; refusing."; exit 1; }
fi
for file in "$mqtt_admin_unit" "$mqtt_admin_socket" "$mqtt_admin_dropin"; do
  if [[ -e "$file" ]]; then grep -qx '# Owned by unmanned-boat-mqtt-admin-v1' "$file" || { echo "Unmanaged MQTT administration service; refusing."; exit 1; }; fi
done
# 先完成独立视频网关的所有权预检，避免停止网页后遗留开放的 UDP 上传服务。
if [[ -e "$video_program" || -e "$video_config" || -e "$video_unit" || -e "$video_dropin" ]]; then
  video_present=1
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  video_remover="$script_dir/maintenance/remove-video-media.sh"
  [[ -f "$video_remover" && ! -L "$video_remover" ]] || { echo "Use the complete source with maintenance/remove-video-media.sh to remove the video gateway safely."; exit 1; }
  bash "$video_remover" --check-only
fi
backup="$(mktemp -d /opt/unmanned-boat-web.removed-XXXXXX)"
chmod 700 "$backup"
if [[ "$video_present" == 1 ]]; then
  [[ ! -f "$video_dropin" ]] || cp -p -- "$video_dropin" "$backup/45-video-media.conf"
  bash "$video_remover"
fi
# Stop the queue before the independent worker, then preserve all trusted bootstrap
# and administrator recovery files even for --purge. Do not touch other services.
if [[ -e "$update_path" ]]; then systemctl disable --now unmanned-boat-web-update.path; fi
if [[ -e "$update_unit" ]]; then systemctl stop unmanned-boat-web-update.service; fi
for file in "$update_unit" "$update_path" "$update_dropin"; do
  [[ ! -e "$file" ]] || mv -- "$file" "$backup/$(basename -- "$file")"
done
[[ ! -e "$update_helper" ]] || mv -- "$update_helper" "$backup/update-helper"
[[ ! -e "$update_state" ]] || mv -- "$update_state" "$backup/update-state"
# 先关闭本机入口，再停止凭据管理进程；配置事务和 helper 随恢复副本保留。
if [[ -e "$mqtt_admin_socket" ]]; then systemctl disable --now unmanned-boat-mqtt-admin.socket; fi
if [[ -e "$mqtt_admin_unit" ]]; then systemctl stop unmanned-boat-mqtt-admin.service; fi
for file in "$mqtt_admin_unit" "$mqtt_admin_socket" "$mqtt_admin_dropin"; do
  [[ ! -e "$file" ]] || mv -- "$file" "$backup/$(basename -- "$file")"
done
[[ ! -e "$mqtt_admin_helper" ]] || mv -- "$mqtt_admin_helper" "$backup/mqtt-admin-helper"
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
echo "MQTT administration helper and units (when present) were saved under $backup; its dedicated group was kept for recovery."
if [[ "$video_present" == 1 ]]; then echo "Video gateway disabled; /etc/unmanned-boat-video, /usr/local/lib/unmanned-boat-video and its disabled unit were kept for recovery (also with --purge)."; fi
