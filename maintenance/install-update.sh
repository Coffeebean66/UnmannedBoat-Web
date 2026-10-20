#!/usr/bin/env bash
# One-time administrator bootstrap. GitHub application updates cannot replace this helper.
# sudo env PATH="/opt/unmanned-boat-node24/bin:$PATH" bash maintenance/install-update.sh https://boat.coffeebean66.tech 7890
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ $# -le 2 ]] || { echo "Usage: sudo bash maintenance/install-update.sh [https-origin] [port]"; exit 1; }
origin="${1:-https://boat.coffeebean66.tech}"
port="${2:-7890}"
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || { echo "Invalid port."; exit 1; }
source_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
target=/opt/unmanned-boat-web
config=/etc/unmanned-boat-web
helper=/usr/local/lib/unmanned-boat-web-update
state=/var/lib/unmanned-boat-web-update
unit_dir=/etc/systemd/system
dropin="$unit_dir/unmanned-boat-web.service.d/30-update.conf"
marker=unmanned-boat-update-v1
for name in node npm git runuser systemctl useradd groupadd getent pkill pgrep chown id install; do
  command -v "$name" >/dev/null || { echo "Missing prerequisite: $name"; exit 1; }
done
node_path="$(command -v node)"
npm_path="$(command -v npm)"
git_path="$(command -v git)"
runuser_path="$(command -v runuser)"
systemctl_path="$(command -v systemctl)"
for executable in "$node_path" "$npm_path" "$git_path" "$runuser_path" "$systemctl_path"; do
  [[ "$executable" =~ ^/[A-Za-z0-9_./-]+$ && -f "$executable" && -x "$executable" ]] || { echo "Use trusted system tools with simple absolute paths."; exit 1; }
done
[[ "$("$node_path" -p 'Number(process.versions.node.split(".")[0]) >= 18')" == true ]] || { echo "Node.js18+ is required."; exit 1; }
"$node_path" - "$origin" <<'NODE'
try{const value=process.argv[2],url=new URL(value);if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||!/^[A-Za-z0-9.:/-]+$/.test(value))process.exit(1);}catch(_){process.exit(1);}
NODE
for item in "$target" "$config" "$helper" "$state" "$unit_dir" "$unit_dir/unmanned-boat-web.service.d"; do
  current="$item"
  while [[ "$current" != / ]]; do
    [[ ! -L "$current" ]] || { echo "Refusing linked updater paths."; exit 1; }
    if [[ -e "$current" ]]; then
      permissions="$(stat -c %a "$current")"
      [[ "$permissions" =~ ^[0-7]{3,4}$ && "$(stat -c %u "$current")" == 0 ]] && (( (8#$permissions & 8#022) == 0 )) || { echo "Updater paths must be root-owned and not group/world-writable."; exit 1; }
    fi
    current="$(dirname -- "$current")"
  done
done
[[ -f "$target/.boat-web-deployment" && "$(cat "$target/.boat-web-deployment")" == unmanned-boat-web-v1 ]] || { echo "Deploy the managed application first."; exit 1; }
[[ -f "$target/server/update-api.js" ]] || { echo "Deploy a version supporting the update API first."; exit 1; }
grep -qx '# Owned by unmanned-boat-web-v1' "$unit_dir/unmanned-boat-web.service" || { echo "Unmanaged web service; refusing."; exit 1; }
for directory in "$helper" "$state"; do
  if [[ -e "$directory" ]]; then
    [[ -f "$directory/.boat-update-deployment" && "$(cat "$directory/.boat-update-deployment")" == "$marker" ]] || { echo "Unmanaged updater directory; refusing overwrite."; exit 1; }
    [[ -z "$(find "$directory" -maxdepth 1 -type l -print -quit)" ]] || { echo "Updater contains linked paths; refusing."; exit 1; }
  fi
done
for file in "$dropin" "$unit_dir/unmanned-boat-web-update.service" "$unit_dir/unmanned-boat-web-update.path"; do
  if [[ -e "$file" ]]; then grep -qx '# Owned by unmanned-boat-update-v1' "$file" || { echo "Unmanaged updater unit; refusing."; exit 1; }; fi
done
if [[ -e "$config/update.env" || -e "$config/update-access.txt" ]]; then
  [[ -f "$config/.boat-update-deployment" && "$(cat "$config/.boat-update-deployment")" == "$marker" && -f "$config/update.env" && -f "$config/update-access.txt" ]] || { echo "Incomplete or unmanaged updater credentials; refusing."; exit 1; }
  [[ ! -L "$config/update.env" && ! -L "$config/update-access.txt" ]] || { echo "Linked updater credentials; refusing."; exit 1; }
  "$node_path" - "$config/update.env" "$origin" <<'NODE'
const fs=require('node:fs');const lines=fs.readFileSync(process.argv[2],'utf8').split(/\r?\n/);
if(!lines.includes('BOAT_UPDATE_ORIGIN='+process.argv[3])){console.error('Requested origin differs from existing update.env; credentials were not changed.');process.exit(1);}
const password=lines.find(x=>x.startsWith('BOAT_UPDATE_PASSWORD='));if(!password||password.slice(21).length<16)process.exit(1);
NODE
fi
for file in update-worker.cjs validate-release.cjs; do
  [[ -f "$source_dir/$file" && ! -L "$source_dir/$file" ]] || { echo "Missing trusted bootstrap file: $file"; exit 1; }
  "$node_path" --check "$source_dir/$file"
done
# Account/group are dedicated; never add the build user to the web queue group.
getent group boat-web-update >/dev/null || groupadd --system boat-web-update
if ! getent passwd boat-web-build >/dev/null; then
  useradd --system --user-group --home-dir "$state/build-home" --shell /usr/sbin/nologin boat-web-build
fi
[[ "$(id -u boat-web-build)" != 0 && "$(id -Gn boat-web-build)" == boat-web-build ]] || { echo "Build account must be a dedicated unprivileged account."; exit 1; }
[[ -d "$config" ]] || install -d -m 755 "$config"
install -d -m 755 "$helper" "$state" "$state/state" "$unit_dir/unmanned-boat-web.service.d"
install -d -o root -g boat-web-update -m 2770 "$state/requests"
install -d -o boat-web-build -g boat-web-build -m 700 "$state/build-home"
install -d -o root -g root -m 700 "$state/history"
printf '%s\n' "$marker" > "$helper/.boat-update-deployment"
printf '%s\n' "$marker" > "$state/.boat-update-deployment"
printf '%s\n' "$marker" > "$config/.boat-update-deployment"
chmod 644 "$helper/.boat-update-deployment" "$state/.boat-update-deployment"
chmod 600 "$config/.boat-update-deployment"
install -o root -g root -m 644 "$source_dir/update-worker.cjs" "$source_dir/validate-release.cjs" "$helper/"
"$node_path" - "$helper/worker-config.json" "$node_path" "$npm_path" "$git_path" "$runuser_path" "$systemctl_path" "$port" "$state" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [file,node,npm,git,runuser,systemctl,port,state]=process.argv.slice(2);
fs.writeFileSync(file,JSON.stringify({node,npm,git,runuser,systemctl,port:Number(port)},null,2)+'\n',{mode:0o600});
fs.chmodSync(file,0o600);
fs.writeFileSync(path.join(state,'config.json'),JSON.stringify({apiVersion:1,repository:'https://github.com/Coffeebean66/UnmannedBoat-Web',branch:'main'})+'\n',{mode:0o644});
if(!fs.existsSync(path.join(state,'state/status.json')))fs.writeFileSync(path.join(state,'state/status.json'),JSON.stringify({status:'idle'})+'\n',{mode:0o644});
NODE
chmod 644 "$state/config.json" "$state/state/status.json"
if [[ ! -f "$config/update.env" ]]; then
  "$node_path" - "$config" "$origin" "$state" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [directory,origin,state]=process.argv.slice(2),password=crypto.randomBytes(24).toString('base64url');
fs.writeFileSync(path.join(directory,'update.env'),`BOAT_UPDATE_ENABLED=1\nBOAT_UPDATE_PASSWORD=${password}\nBOAT_UPDATE_ORIGIN=${origin}\nBOAT_UPDATE_STATE_DIR=${state}\n`,{mode:0o600,flag:'wx'});
fs.writeFileSync(path.join(directory,'update-access.txt'),`Unmanned Boat Web update administration (private; never commit)\nWebsite: ${origin}\nUpdate administrator password: ${password}\nRepository: https://github.com/Coffeebean66/UnmannedBoat-Web\nBranch: main\nThis password is separate from cloud viewing and MQTT credentials.\n`,{mode:0o600,flag:'wx'});
NODE
fi
chmod 600 "$config/update.env" "$config/update-access.txt"
cat > "$dropin" <<EOF
# Owned by unmanned-boat-update-v1
[Service]
EnvironmentFile=$config/update.env
SupplementaryGroups=boat-web-update
ReadWritePaths=$state/requests
EOF
cat > "$unit_dir/unmanned-boat-web-update.service" <<EOF
# Owned by unmanned-boat-update-v1
[Unit]
Description=Unmanned Boat Web trusted update worker
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=$node_path $helper/update-worker.cjs
WorkingDirectory=$helper
Environment=PATH=$(dirname -- "$node_path"):/usr/sbin:/usr/bin:/sbin:/bin
UMask=0022
TimeoutStartSec=900
KillMode=control-group
PrivateTmp=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt $state
LimitNOFILE=4096
MemoryMax=768M
TasksMax=128
EOF
cat > "$unit_dir/unmanned-boat-web-update.path" <<EOF
# Owned by unmanned-boat-update-v1
[Unit]
Description=Unmanned Boat Web update request queue

[Path]
PathExists=$state/requests/update.json
PathExists=$state/inflight.json
PathExists=$state/transaction.json
Unit=unmanned-boat-web-update.service
TriggerLimitIntervalSec=60
TriggerLimitBurst=3

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$dropin" "$unit_dir/unmanned-boat-web-update.service" "$unit_dir/unmanned-boat-web-update.path"
systemctl daemon-reload
systemctl enable --now unmanned-boat-web-update.path
systemctl restart unmanned-boat-web.service
ready=0
for attempt in 1 2 3 4 5 6 7 8; do
  if "$node_path" - "$port" <<'NODE'
(async()=>{const base='http://127.0.0.1:'+process.argv[2];const get=route=>fetch(base+route,{signal:AbortSignal.timeout(1500)});const health=await get('/healthz');if(!health.ok||(await health.json()).app!=='unmanned-boat-web')throw Error('health');const update=await get('/api/update/config');if(!update.ok||(await update.json()).enabled!==true)throw Error('updater');})().catch(()=>process.exit(1));
NODE
  then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] && systemctl is-active --quiet unmanned-boat-web.service || { echo "Web restart/update API check failed. Review journalctl -u unmanned-boat-web.service; existing credentials were preserved."; exit 1; }
echo "Web update installed. Private administrator credentials: $config/update-access.txt"
echo "GitHub application updates never replace the root-owned helper, runtime.env, Nginx or MQTT configuration."
