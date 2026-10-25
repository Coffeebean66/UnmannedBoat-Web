#!/usr/bin/env bash
# 一次性安装受信任的 MQTT 凭据管理组件；网页应用更新不能替换此 root helper。
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ $# -eq 0 ]] || { echo "Usage: sudo bash maintenance/install-mqtt-device-admin.sh"; exit 1; }

source_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
target=/opt/unmanned-boat-web
config=/etc/unmanned-boat-web
helper=/usr/local/lib/unmanned-boat-mqtt-admin
unit_dir=/etc/systemd/system
service="$unit_dir/unmanned-boat-mqtt-admin.service"
socket_unit="$unit_dir/unmanned-boat-mqtt-admin.socket"
dropin="$unit_dir/unmanned-boat-web.service.d/40-mqtt-device-admin.conf"
socket=/run/unmanned-boat-mqtt-admin/control.sock
marker=unmanned-boat-mqtt-admin-v1

for name in node systemctl mosquitto_passwd groupadd getent stat install find readlink; do
  command -v "$name" >/dev/null || { echo "Missing prerequisite: $name"; exit 1; }
done
# 不允许把可由普通用户改写的命令路径固化进 root 服务。
trusted_path() {
  local current="$1" permissions
  while [[ "$current" != / ]]; do
    [[ ! -L "$current" ]] || { echo "Refusing linked MQTT administration paths."; exit 1; }
    if [[ -e "$current" ]]; then
      permissions="$(stat -c %a "$current")"
      [[ "$permissions" =~ ^[0-7]{3,4}$ && "$(stat -c %u "$current")" == 0 ]] &&
        (( (8#$permissions & 8#022) == 0 )) || { echo "MQTT administration paths must be root-owned and not group/world-writable."; exit 1; }
    fi
    current="$(dirname -- "$current")"
  done
}
node_path="$(readlink -f -- "$(command -v node)")"
systemctl_path="$(readlink -f -- "$(command -v systemctl)")"
passwd_path="$(readlink -f -- "$(command -v mosquitto_passwd)")"
for executable in "$node_path" "$systemctl_path" "$passwd_path"; do
  [[ "$executable" =~ ^/[A-Za-z0-9_./-]+$ && -f "$executable" && -x "$executable" ]] || { echo "Use trusted system tools with simple absolute paths."; exit 1; }
  trusted_path "$executable"
done
[[ "$("$node_path" -p 'Number(process.versions.node.split(".")[0]) >= 18')" == true ]] || { echo "Node.js18+ is required."; exit 1; }
for item in "$target" "$config" "$helper" "$unit_dir" "$unit_dir/unmanned-boat-web.service.d" /run/unmanned-boat-mqtt-admin; do trusted_path "$item"; done
[[ -f "$target/.boat-web-deployment" && ! -L "$target/.boat-web-deployment" && "$(cat "$target/.boat-web-deployment")" == unmanned-boat-web-v1 ]] || { echo "Deploy the managed application first."; exit 1; }
[[ -f "$target/server/mqtt-device-api.js" && ! -L "$target/server/mqtt-device-api.js" ]] || { echo "Deploy a version supporting MQTT device administration first."; exit 1; }
[[ -f "$config/.boat-cloud-deployment" && ! -L "$config/.boat-cloud-deployment" && "$(cat "$config/.boat-cloud-deployment")" == unmanned-boat-cloud-v1 ]] || { echo "Only the dedicated managed MQTT broker is supported."; exit 1; }
for item in "$target/.boat-web-deployment" "$target/server/mqtt-device-api.js" "$config/.boat-cloud-deployment"; do trusted_path "$item"; done
for name in passwd acl runtime.env mosquitto.conf access.txt; do
  [[ -f "$config/$name" ]] || { echo "Managed MQTT configuration is incomplete: $name"; exit 1; }
  trusted_path "$config/$name"
done
for entry in "$unit_dir/unmanned-boat-web.service" "$unit_dir/unmanned-boat-mqtt.service"; do trusted_path "$entry"; done
grep -qx '# Owned by unmanned-boat-web-v1' "$unit_dir/unmanned-boat-web.service" || { echo "Unmanaged web service; refusing."; exit 1; }
grep -qx '# Owned by unmanned-boat-cloud-v1' "$unit_dir/unmanned-boat-mqtt.service" || { echo "Unmanaged MQTT service; refusing."; exit 1; }
if [[ -e "$helper" ]]; then
  [[ -f "$helper/.boat-mqtt-admin-deployment" && ! -L "$helper/.boat-mqtt-admin-deployment" && "$(cat "$helper/.boat-mqtt-admin-deployment")" == "$marker" ]] || { echo "Unmanaged MQTT administration helper; refusing overwrite."; exit 1; }
  [[ -z "$(find "$helper" -type l -print -quit)" ]] || { echo "MQTT administration helper contains symlinks; refusing."; exit 1; }
  while IFS= read -r -d '' entry; do trusted_path "$entry"; done < <(find "$helper" -print0)
fi
for file in "$service" "$socket_unit" "$dropin"; do
  trusted_path "$file"
  if [[ -e "$file" ]]; then
    [[ -f "$file" ]] && grep -qx '# Owned by unmanned-boat-mqtt-admin-v1' "$file" || { echo "Unmanaged MQTT administration unit; refusing."; exit 1; }
  fi
done
[[ -f "$source_dir/mqtt-device-worker.cjs" && ! -L "$source_dir/mqtt-device-worker.cjs" ]] || { echo "Missing trusted mqtt-device-worker.cjs source."; exit 1; }
"$node_path" --check "$source_dir/mqtt-device-worker.cjs"

# 从这里开始仅管理本组件的文件和服务，不读取或改写设备密码。
getent group boat-mqtt-admin >/dev/null || groupadd --system boat-mqtt-admin
if [[ -e "$socket_unit" || -e "$service" ]]; then
  systemctl stop unmanned-boat-mqtt-admin.socket unmanned-boat-mqtt-admin.service
fi
install -d -o root -g root -m 755 "$helper" "$unit_dir/unmanned-boat-web.service.d"
install -o root -g root -m 644 "$source_dir/mqtt-device-worker.cjs" "$helper/mqtt-device-worker.cjs"
printf '%s\n' "$marker" > "$helper/.boat-mqtt-admin-deployment"
chmod 644 "$helper/.boat-mqtt-admin-deployment"
"$node_path" - "$helper/mqtt-device-worker-config.json" "$passwd_path" "$systemctl_path" <<'NODE'
const fs=require('node:fs');
const [file,mosquittoPasswd,systemctl]=process.argv.slice(2);
fs.writeFileSync(file,JSON.stringify({mosquittoPasswd,systemctl})+'\n',{mode:0o600});
fs.chmodSync(file,0o600);
NODE
cat > "$service" <<EOF
# Owned by unmanned-boat-mqtt-admin-v1
[Unit]
Description=Unmanned Boat trusted MQTT device credential manager
Requires=unmanned-boat-mqtt-admin.socket
After=unmanned-boat-mqtt-admin.socket

[Service]
Type=simple
User=root
Group=root
ExecStart=$node_path $helper/mqtt-device-worker.cjs
WorkingDirectory=$helper
Sockets=unmanned-boat-mqtt-admin.socket
UMask=0077
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$config
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitNOFILE=256
TasksMax=32
MemoryMax=128M
TimeoutStopSec=45
EOF
cat > "$socket_unit" <<EOF
# Owned by unmanned-boat-mqtt-admin-v1
[Unit]
Description=Unmanned Boat MQTT credential management local socket

[Socket]
ListenStream=$socket
SocketMode=0660
SocketUser=root
SocketGroup=boat-mqtt-admin
DirectoryMode=0755
RemoveOnStop=yes
Service=unmanned-boat-mqtt-admin.service

[Install]
WantedBy=sockets.target
EOF
cat > "$dropin" <<'EOF'
# Owned by unmanned-boat-mqtt-admin-v1
[Service]
SupplementaryGroups=boat-mqtt-admin
EOF
chmod 644 "$service" "$socket_unit" "$dropin"
systemctl daemon-reload
systemctl enable --now unmanned-boat-mqtt-admin.socket
# 对固定 Unix socket 的读取会激活 helper，同时验证现有 ACL 可以被安全管理。
"$node_path" - "$socket" <<'NODE'
const http=require('node:http');
const request=http.get({socketPath:process.argv[2],path:'/devices',timeout:10000},response=>{
  let data='';response.on('data',chunk=>{data+=chunk;if(data.length>32768)response.destroy();});
  response.on('error',()=>process.exitCode=1);
  response.on('end',()=>{try{const value=JSON.parse(data);if(response.statusCode!==200||!Array.isArray(value.devices)||typeof value.revision!=='string')throw Error();}catch(_){console.error('MQTT administration readiness failed; existing credentials were not changed.');process.exitCode=1;}});
});
request.on('timeout',()=>request.destroy());
request.on('error',()=>{console.error('MQTT administration socket is unavailable; inspect its service journal.');process.exitCode=1;});
NODE
systemctl restart unmanned-boat-web.service
# systemctl 同时检查多个单元时，只要任意一个 active 就返回成功；两项必须独立检查。
systemctl is-active --quiet unmanned-boat-web.service || { echo "Web service is not active; inspect journalctl -u unmanned-boat-web.service." >&2; exit 1; }
systemctl is-active --quiet unmanned-boat-mqtt-admin.socket || { echo "MQTT administration socket is not active; inspect its service journal." >&2; exit 1; }
echo "MQTT device administration installed. Open administrator Settings > MQTT device accounts."
echo "Existing device and bridge credentials were preserved; no broker restart was requested."
echo "Application updates cannot replace this root-owned helper; rerun this installer explicitly when upgrading it."
