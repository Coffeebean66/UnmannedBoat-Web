#!/usr/bin/env bash
# Linux/systemd installer. Run: sudo bash deploy.sh [port] [bind address]
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo."; exit 1; }
command -v node >/dev/null || { echo "Install Node.js 18+ first, then rerun."; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required."; exit 1; }
[[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 18')" == true ]] || { echo "Node.js 18+ required."; exit 1; }
port="${1:-8080}"
address="${2:-127.0.0.1}"
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || { echo "Invalid port."; exit 1; }
[[ "$address" == "127.0.0.1" || "$address" == "0.0.0.0" ]] || { echo "Bind address must be 127.0.0.1 or 0.0.0.0."; exit 1; }
source_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
target=/opt/unmanned-boat-web
unit=/etc/systemd/system/unmanned-boat-web.service
marker=unmanned-boat-web-v1
[[ "$source_dir" != "$target" && "$source_dir" != "$target/"* ]] || { echo "Run the installer from a separate source folder."; exit 1; }
[[ ! -L /opt && ! -L "$target" && ! -L "$unit" ]] || { echo "Refusing linked deployment paths."; exit 1; }
if [[ -e "$target" ]]; then
  [[ -f "$target/.boat-web-deployment" && "$(cat "$target/.boat-web-deployment")" == "$marker" ]] || { echo "Unmanaged target; refusing overwrite."; exit 1; }
  [[ -z "$(find "$target" -type l -print -quit)" ]] || { echo "Deployment contains symlinks; refusing."; exit 1; }
fi
if [[ -e "$unit" ]]; then
  grep -qx '# Owned by unmanned-boat-web-v1' "$unit" || { echo "Unmanaged service; refusing overwrite."; exit 1; }
  systemctl stop unmanned-boat-web.service
fi
node_path="$(command -v node)"
[[ "$node_path" =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo "Use a system Node installation with a simple absolute path."; exit 1; }
install -d -m 755 "$target/public"
cp -R "$source_dir/public/." "$target/public/"
install -m 644 "$source_dir/server.js" "$source_dir/package.json" "$target/"
printf '%s\n' "$marker" > "$target/.boat-web-deployment"
chmod -R u=rwX,go=rX "$target"
cat > "$unit" <<EOF
# Owned by unmanned-boat-web-v1
[Unit]
Description=Unmanned Boat Monitor Web
After=network.target

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=$target
ExecStart=$node_path $target/server.js
Environment=HOST=$address
Environment=PORT=$port
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now unmanned-boat-web.service
ready=0
for attempt in 1 2 3 4 5; do
  if node -e "fetch('http://127.0.0.1:$port/healthz',{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(x=>{if(x.app!=='unmanned-boat-web')process.exit(1)}).catch(()=>process.exit(1))"; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]] || ! systemctl is-active --quiet unmanned-boat-web.service; then
  systemctl stop unmanned-boat-web.service
  echo "Startup failed. Check: journalctl -u unmanned-boat-web.service -n 50"
  exit 1
fi
echo "Deployed to $target; listening on http://$address:$port"
echo "Use HTTPS reverse proxy before accessing Bluetooth from another computer."
