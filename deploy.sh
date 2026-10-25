#!/usr/bin/env bash
# Stage locked dependencies before stopping the current systemd site.
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo."; exit 1; }
command -v node >/dev/null || { echo "Install Node.js18+ first."; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required."; exit 1; }
[[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 18')" == true ]] || { echo "Node.js18+ required."; exit 1; }
[[ $# -le 2 ]] || { echo "Usage: sudo bash deploy.sh [port] [bind address]"; exit 1; }
port="${1:-8080}"
address="${2:-127.0.0.1}"
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || { echo "Invalid port."; exit 1; }
[[ "$address" == "127.0.0.1" || "$address" == "0.0.0.0" ]] || { echo "Invalid bind address."; exit 1; }
source_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
target=/opt/unmanned-boat-web
unit=/etc/systemd/system/unmanned-boat-web.service
config=/etc/unmanned-boat-web
marker=unmanned-boat-web-v1
[[ "$source_dir" != "$target" && "$source_dir" != "$target/"* ]] || { echo "Run from a separate source folder."; exit 1; }
for path in /opt /etc /etc/systemd /etc/systemd/system "$target" "$unit" "$config"; do
  [[ ! -L "$path" ]] || { echo "Refusing linked deployment paths."; exit 1; }
done
if [[ -e "$target" ]]; then
  [[ -f "$target/.boat-web-deployment" && ! -L "$target/.boat-web-deployment" && "$(cat "$target/.boat-web-deployment")" == "$marker" ]] || { echo "Unmanaged target; refusing overwrite."; exit 1; }
  [[ -z "$(find "$target" -type l -print -quit)" ]] || { echo "Deployment contains symlinks; refusing."; exit 1; }
fi
if [[ -e "$unit" ]]; then grep -qx '# Owned by unmanned-boat-web-v1' "$unit" || { echo "Unmanaged service; refusing overwrite."; exit 1; }; fi
if [[ -e "$config/runtime.env" ]]; then
  [[ -f "$config/.boat-cloud-deployment" && "$(cat "$config/.boat-cloud-deployment")" == unmanned-boat-cloud-v1 ]] || { echo "Unmanaged cloud environment; refusing."; exit 1; }
  [[ -z "$(find "$config" -type l -print -quit)" ]] || { echo "Cloud configuration contains symlinks; refusing."; exit 1; }
fi
if [[ -e "$config/update.env" ]]; then
  [[ -f "$config/.boat-update-deployment" && "$(cat "$config/.boat-update-deployment")" == unmanned-boat-update-v1 && ! -L "$config/update.env" ]] || { echo "Unmanaged updater configuration; refusing."; exit 1; }
fi
if [[ -e "$config/accounts.env" ]]; then
  [[ -f "$config/accounts.env" && ! -L "$config/accounts.env" ]] || { echo "Linked or invalid account configuration; refusing."; exit 1; }
fi
node_path="$(command -v node)"
[[ "$node_path" =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo "Use a system Node installation with a simple absolute path."; exit 1; }
stage="$(mktemp -d /opt/.boat-web-stage.XXXXXX)"
backup=''
committed=0
old_moved=0
new_moved=0
mutated=0
had_unit=0
was_active=0
was_enabled=0
systemctl is-active --quiet unmanned-boat-web.service && was_active=1
systemctl is-enabled --quiet unmanned-boat-web.service && was_enabled=1
cleanup() {
  result=$?
  trap - EXIT
  set +e
  if [[ "$committed" != 1 && "$mutated" == 1 ]]; then
    systemctl stop unmanned-boat-web.service >/dev/null 2>&1
    if [[ "$new_moved" == 1 ]]; then mv -- "$target" "$backup/failed-app"; fi
    if [[ "$old_moved" == 1 ]]; then mv -- "$backup/app" "$target"; fi
    if [[ "$had_unit" == 1 ]]; then
      install -m 644 "$backup/service.conf" "$unit"
    elif [[ -f "$unit" ]] && grep -qx '# Owned by unmanned-boat-web-v1' "$unit"; then
      rm -- "$unit"
    fi
    systemctl daemon-reload
    if [[ "$was_enabled" == 1 ]]; then systemctl enable unmanned-boat-web.service >/dev/null 2>&1; else systemctl disable unmanned-boat-web.service >/dev/null 2>&1; fi
    if [[ "$was_active" == 1 ]]; then systemctl start unmanned-boat-web.service; fi
    echo "Deployment failed; restored the previous site. Review files: $backup"
  fi
  if [[ -n "$stage" && "$stage" == /opt/.boat-web-stage.* && -d "$stage" && ! -L "$stage" ]]; then rm -rf -- "$stage"; fi
  exit "$result"
}
trap cleanup EXIT
install -d -m 755 "$stage/public"
cp -R "$source_dir/public/." "$stage/public/"
install -m 644 "$source_dir/server.js" "$source_dir/package.json" "$stage/"
if [[ -d "$source_dir/server" ]]; then cp -R "$source_dir/server" "$stage/"; fi
if [[ -d "$source_dir/maintenance" ]]; then cp -R "$source_dir/maintenance" "$stage/"; fi
# Preserve provenance only when the source supplies valid release metadata.
if [[ -f "$source_dir/.boat-web-release.json" && ! -L "$source_dir/.boat-web-release.json" ]]; then
  node - "$source_dir/.boat-web-release.json" "$stage/.boat-web-release.json" <<'NODE'
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!/^[0-9a-f]{40}$/.test(value.commit||'')||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version||''))process.exit(1);
fs.writeFileSync(process.argv[3],JSON.stringify(value)+'\n',{mode:0o644});
NODE
fi
if [[ -f "$source_dir/package-lock.json" ]]; then
  command -v npm >/dev/null || { echo "npm is required for locked runtime dependencies."; exit 1; }
  install -m 644 "$source_dir/package-lock.json" "$stage/"
  npm ci --prefix "$stage" --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund
else
  node -e 'const p=require(process.argv[1]); if(Object.keys(p.dependencies||{}).length) process.exit(1)' "$stage/package.json" || { echo "Runtime dependencies require package-lock.json."; exit 1; }
fi
node --check "$stage/server.js"
[[ -z "$(find "$stage" -type l -print -quit)" ]] || { echo "Staged deployment contains symlinks; refusing."; exit 1; }
printf '%s\n' "$marker" > "$stage/.boat-web-deployment"
chmod -R u=rwX,go=rX "$stage"
cat > "$stage/.service.conf" <<EOF
# Owned by unmanned-boat-web-v1
[Unit]
Description=Unmanned Boat Monitor Web
After=network.target

[Service]
Type=simple
DynamicUser=yes
StateDirectory=unmanned-boat-web
StateDirectoryMode=0750
WorkingDirectory=$target
ExecStart=$node_path $target/server.js
Environment=HOST=$address
Environment=PORT=$port
EnvironmentFile=-$config/runtime.env
EnvironmentFile=-$config/accounts.env
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF
backup="$(mktemp -d /opt/unmanned-boat-web.backup-XXXXXX)"
if [[ -e "$unit" ]]; then cp -p -- "$unit" "$backup/service.conf"; had_unit=1; fi
mutated=1
if [[ "$was_active" == 1 ]]; then systemctl stop unmanned-boat-web.service; fi
if [[ -e "$target" ]]; then mv -- "$target" "$backup/app"; old_moved=1; fi
mv -- "$stage" "$target"
stage=''
new_moved=1
install -m 644 "$target/.service.conf" "$unit"
rm -- "$target/.service.conf"
systemctl daemon-reload
systemctl enable --now unmanned-boat-web.service
ready=0
for attempt in 1 2 3 4 5 6 7 8; do
  if node - "$port" "$config/runtime.env" "$config/accounts.env" <<'NODE'
const fs=require('node:fs');
(async()=>{
  const base='http://127.0.0.1:'+process.argv[2];
  const request=(route,options={})=>fetch(base+route,{...options,signal:AbortSignal.timeout(1500)});
  const health=await request('/healthz');
  const data=await health.json();
  if(!health.ok||data.app!=='unmanned-boat-web')throw Error('health');
  const env={};
  for(const file of process.argv.slice(3)){
    if(!fs.existsSync(file))continue;
    Object.assign(env,Object.fromEntries(fs.readFileSync(file,'utf8').split(/\r?\n/).filter(x=>/^[A-Z_]+=.*/.test(x)).map(x=>{const n=x.indexOf('=');return[x.slice(0,n),x.slice(n+1)];})));
  }
  if(Object.hasOwn(data,'readiness')){
    const r=data.readiness;
    if(!r||Array.isArray(r)||typeof r!=='object'||typeof r.cloudEnabled!=='boolean'||typeof r.brokerConnected!=='boolean'||typeof r.accountsEnabled!=='boolean'||r.accountManagement!==1||r.cloudEnabled!==(env.BOAT_CLOUD_ENABLED==='1')||r.accountsEnabled!==(env.BOAT_ACCOUNTS_ENABLED==='1')||(r.cloudEnabled&&!r.brokerConnected))throw Error('readiness');
    return;
  }
  const accountFiles=env.BOAT_ACCOUNTS_FILE?[env.BOAT_ACCOUNTS_FILE]:['/var/lib/unmanned-boat-web/accounts.json','/var/lib/unmanned-boat-web-update/requests/accounts.json'];
  for(const file of accountFiles){try{fs.lstatSync(file);throw Error('managed account readiness is unsupported');}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(env.BOAT_CLOUD_ENABLED!=='1')return;
  const accounts=env.BOAT_ACCOUNTS_ENABLED==='1';
  const login=await request(accounts?'/api/auth/login':'/api/cloud/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:env.BOAT_ACCOUNTS_ORIGIN||env.BOAT_CLOUD_ORIGIN||env.BOAT_UPDATE_ORIGIN},body:JSON.stringify(accounts?{username:env.BOAT_ADMIN_USERNAME,password:env.BOAT_ADMIN_PASSWORD}:{password:env.BOAT_CLOUD_PASSWORD})});
  const cookie=(login.headers.get('set-cookie')||'').split(';')[0];
  if(!login.ok||!cookie)throw Error('login');
  const devices=await request('/api/cloud/devices',{headers:{Cookie:cookie}});
  if(!devices.ok||(await devices.json()).brokerConnected!==true)throw Error('broker');
})().catch(()=>process.exit(1));
NODE
  then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]] || ! systemctl is-active --quiet unmanned-boat-web.service; then
  echo "Startup check failed. Check: journalctl -u unmanned-boat-web.service -n 50"
  exit 1
fi
committed=1
echo "Deployed to $target; listening on http://$address:$port"
echo "Previous deployment recovery files: $backup"
echo "Cloud credentials, when configured, are kept separately under /etc/unmanned-boat-web."
if [[ -f "$config/update.env" ]]; then
  echo "Existing updater helper, systemd drop-in and update credentials were preserved."
elif [[ -f "$target/maintenance/install-update.sh" ]]; then
  echo "Optional one-time web update setup: sudo bash $target/maintenance/install-update.sh https://your-domain.example $port"
fi
