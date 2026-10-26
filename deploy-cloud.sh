#!/usr/bin/env bash
# Dedicated authenticated MQTT + web bridge; never changes Docker/DNS/Nginx.
# Run: sudo env PATH="$PATH" bash deploy-cloud.sh [port] [bind] [https-origin]
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ $# -le 3 ]] || { echo "Usage: sudo bash deploy-cloud.sh [port] [bind] [https-origin]"; exit 1; }
port="${1:-7890}"
address="${2:-127.0.0.1}"
origin="${3:-https://boat.coffeebean66.tech}"
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || { echo "Invalid port."; exit 1; }
[[ "$address" == "127.0.0.1" || "$address" == "0.0.0.0" ]] || { echo "Invalid bind address."; exit 1; }
for command in node npm systemctl ss; do command -v "$command" >/dev/null || { echo "Missing prerequisite: $command"; exit 1; }; done
[[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 18')" == true ]] || { echo "Node.js18+ required."; exit 1; }
node - "$origin" <<'NODE'
try{const input=process.argv[2],url=new URL(input);if(url.protocol!=='https:'||url.origin!==input||url.username||url.password||!/^[A-Za-z0-9.:/-]+$/.test(input))process.exit(1);}catch(_){process.exit(1);}
NODE
source_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
config=/etc/unmanned-boat-web
broker_unit=/etc/systemd/system/unmanned-boat-mqtt.service
marker=unmanned-boat-cloud-v1
for path in /etc /etc/systemd /etc/systemd/system "$config" "$broker_unit"; do [[ ! -L "$path" ]] || { echo "Refusing linked cloud paths."; exit 1; }; done
existing=0
if [[ -e "$config" ]]; then
  [[ -f "$config/.boat-cloud-deployment" && "$(cat "$config/.boat-cloud-deployment")" == "$marker" ]] || { echo "Unmanaged configuration directory; refusing overwrite."; exit 1; }
  [[ -z "$(find "$config" -type l -print -quit)" ]] || { echo "Cloud configuration contains symlinks; refusing."; exit 1; }
  for name in runtime.env access.txt passwd acl mosquitto.conf; do [[ -f "$config/$name" ]] || { echo "Managed cloud configuration is incomplete: $name"; exit 1; }; done
  existing=1
fi
if [[ -e "$broker_unit" ]]; then grep -qx '# Owned by unmanned-boat-cloud-v1' "$broker_unit" || { echo "Unmanaged MQTT unit; refusing."; exit 1; }; fi
if systemctl is-active --quiet mosquitto.service || systemctl is-enabled --quiet mosquitto.service; then
  echo "An existing system Mosquitto service is active/enabled; configure integration manually. Nothing was changed."
  exit 1
fi
if ss -H -ltn 'sport = :1883' | grep -q .; then
  [[ "$existing" == 1 && -f "$broker_unit" ]] && systemctl is-active --quiet unmanned-boat-mqtt.service || { echo "Port1883 is already used by another service; refusing."; exit 1; }
fi
if ! command -v mosquitto >/dev/null || ! command -v mosquitto_passwd >/dev/null; then
  if systemctl cat mosquitto.service >/dev/null 2>&1; then echo "Existing Mosquitto installation is incomplete; repair it manually."; exit 1; fi
  command -v apt-get >/dev/null || { echo "Install Mosquitto2 and mosquitto-clients first."; exit 1; }
  apt-get update
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y --no-install-recommends mosquitto mosquitto-clients
  # Only disable the default unit that this invocation just installed.
  systemctl disable --now mosquitto.service
fi
# Mosquitto2 may return status3 for -h; validate its banner independently.
mosquitto_help="$(mosquitto -h 2>&1 || true)"
grep -Eq '^mosquitto version 2\.' <<< "$mosquitto_help" || { echo "Mosquitto2 is required."; exit 1; }
getent passwd mosquitto >/dev/null || { echo "The mosquitto service account is missing."; exit 1; }
stage=''
broker_started=0
broker_was_active=0
systemctl is-active --quiet unmanned-boat-mqtt.service && broker_was_active=1
cleanup() {
  result=$?
  trap - EXIT
  set +e
  if [[ "$result" != 0 && "$broker_started" == 1 && "$broker_was_active" == 0 ]]; then systemctl disable --now unmanned-boat-mqtt.service; fi
  if [[ -n "$stage" && "$stage" == /etc/.boat-cloud-stage.* && -d "$stage" && ! -L "$stage" ]]; then rm -rf -- "$stage"; fi
  if [[ "$result" != 0 ]]; then echo "Cloud setup failed. Existing site is preserved/restored; generated credentials, if any, remain root-only in $config/access.txt."; fi
  exit "$result"
}
trap cleanup EXIT
if [[ "$existing" == 0 ]]; then
  stage="$(mktemp -d /etc/.boat-cloud-stage.XXXXXX)"
  node - "$stage" "$origin" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const directory=process.argv[2],origin=process.argv[3],password=()=>crypto.randomBytes(24).toString('base64url');
const viewer=password(),device=password(),bridge=password();
const write=(name,text)=>fs.writeFileSync(path.join(directory,name),text,{mode:0o600});
write('runtime.env',`BOAT_CLOUD_ENABLED=1\nBOAT_CLOUD_PASSWORD=${viewer}\nBOAT_CLOUD_ORIGIN=${origin}\nBOAT_MQTT_URL=mqtt://127.0.0.1:1883\nBOAT_MQTT_USERNAME=boat-web-bridge\nBOAT_MQTT_PASSWORD=${bridge}\nBOAT_MQTT_TOPIC_PREFIX=boats\n`);
write('passwd',`boat-01:${device}\nboat-web-bridge:${bridge}\n`);
write('access.txt',`Unmanned boat cloud access (private; do not commit or share)\nWebsite: ${origin}\nCloud viewer password: ${viewer}\nMQTT host: ${new URL(origin).hostname}\nMQTT port: 1883 (plain TCP; no TLS)\nDevice ID / username: boat-01\nDevice password: ${device}\n\nFirmware boat_network_local.h:\n#define BOAT_MQTT_DEVICE_ID "boat-01"\n#define BOAT_MQTT_USERNAME "boat-01"\n#define BOAT_MQTT_PASSWORD "${device}"\n\nBridge username: boat-web-bridge\nBridge password: ${bridge}\n`);
NODE
  mosquitto_passwd -U "$stage/passwd"
  cat > "$stage/acl" <<'EOF'
user boat-01
topic write boats/boat-01/telemetry
topic write boats/boat-01/status
topic read boats/boat-01/parameter-command
topic write boats/boat-01/parameter-response
topic write boats/boat-01/parameter-capability

user boat-web-bridge
topic read boats/+/telemetry
topic read boats/+/status
topic read boats/+/video
topic write boats/+/parameter-command
topic read boats/+/parameter-response
topic read boats/+/parameter-capability
EOF
  cat > "$stage/mosquitto.conf" <<'EOF'
# Owned by unmanned-boat-cloud-v1
per_listener_settings true
listener 1883 0.0.0.0
protocol mqtt
allow_anonymous false
password_file /etc/unmanned-boat-web/passwd
acl_file /etc/unmanned-boat-web/acl
max_connections 32
max_packet_size 8192
message_size_limit 4096
max_inflight_messages 10
max_queued_messages 20
max_queued_bytes 65536
queue_qos0_messages false
persistence true
persistence_location /var/lib/unmanned-boat-mqtt/
autosave_interval 1800
log_dest stderr
log_type error
log_type warning
connection_messages false
EOF
  printf '%s\n' "$marker" > "$stage/.boat-cloud-deployment"
  chown -R root:mosquitto "$stage"
  chmod 750 "$stage"
  chmod 640 "$stage/passwd" "$stage/acl" "$stage/mosquitto.conf" "$stage/.boat-cloud-deployment"
  chmod 600 "$stage/runtime.env" "$stage/access.txt"
  mv -- "$stage" "$config"
  stage=''
else
  node - "$config/runtime.env" "$origin" <<'NODE'
const fs=require('node:fs');
const line=fs.readFileSync(process.argv[2],'utf8').split(/\r?\n/).find(x=>x.startsWith('BOAT_CLOUD_ORIGIN='));
if(line!=='BOAT_CLOUD_ORIGIN='+process.argv[3]){console.error('Requested origin differs from preserved runtime.env; edit that file explicitly or pass its existing origin.');process.exit(1);}
NODE
fi
# Existing deployments keep all passwords. Extend only the two existing account
# types: a device may read its own commands and publish its own replies; the web
# bridge may send parameter commands. Never grant driving or arbitrary topics.
acl_changed="$(node "$source_dir/maintenance/configure-parameter-acl.cjs" "$config/acl" "$config/runtime.env")"
if [[ ! -e "$broker_unit" ]]; then
  cat > "$broker_unit" <<'EOF'
# Owned by unmanned-boat-cloud-v1
[Unit]
Description=Unmanned Boat Dedicated MQTT Broker
After=network.target

[Service]
Type=simple
User=mosquitto
Group=mosquitto
ExecStart=/usr/sbin/mosquitto -c /etc/unmanned-boat-web/mosquitto.conf
StateDirectory=unmanned-boat-mqtt
StateDirectoryMode=0750
UMask=0077
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
LimitNOFILE=1024
MemoryMax=64M

[Install]
WantedBy=multi-user.target
EOF
fi
systemctl daemon-reload
broker_started=1
systemctl enable --now unmanned-boat-mqtt.service
if [[ "$acl_changed" == 1 && "$broker_was_active" == 1 ]]; then
  systemctl kill --kill-whom=main --signal=HUP unmanned-boat-mqtt.service
fi
ready=0
for attempt in 1 2 3 4 5; do
  if systemctl is-active --quiet unmanned-boat-mqtt.service && ss -H -ltn 'sport = :1883' | grep -q .; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "Broker startup failed; check journalctl -u unmanned-boat-mqtt.service."; exit 1; }
bash "$source_dir/deploy.sh" "$port" "$address"
echo "Cloud service deployed. Private credentials: $config/access.txt (root only; never printed)."
echo "Allow TCP1883 in the server/cloud firewall as needed. This script did not change firewalls, Nginx or DNS."
echo "MQTT1883 is unencrypted; use these dedicated device credentials only."
echo "Web update administration is separate. Existing update.env/helper are preserved; install with maintenance/install-update.sh if not yet enabled."
echo "Existing accounts.env is preserved and used by the web deployment readiness check when account mode is enabled."
