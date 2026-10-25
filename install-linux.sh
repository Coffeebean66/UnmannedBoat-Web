#!/usr/bin/env bash
# First installation on Ubuntu 22.04/24.04 or Debian 12+ with systemd.
# sudo bash install-linux.sh boat.example.com admin@example.com [7890]
set -euo pipefail
umask 077

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $# -ge 2 && $# -le 3 ]] || die "Usage: sudo bash install-linux.sh <domain> <email> [7890]"
domain="${1,,}"
email="$2"
port="${3:-7890}"
[[ ${#domain} -le 253 && "$domain" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$ ]] || die "Use a DNS domain without scheme, path, port or trailing dot."
IFS='.' read -ra labels <<< "$domain"
for label in "${labels[@]}"; do [[ ${#label} -le 63 ]] || die "A domain label exceeds 63 characters."; done
[[ ${#email} -le 254 && "$email" =~ ^[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || die "Invalid certificate contact email."
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || die "Invalid web port."
port="$((10#$port))"
[[ "$port" != 80 && "$port" != 443 && "$port" != 1883 ]] || die "The internal web port cannot be 80, 443 or 1883."
[[ "$EUID" -eq 0 ]] || die "Run with sudo or as root."
[[ -d /run/systemd/system ]] && command -v systemctl >/dev/null || die "A running systemd Linux server is required."
[[ -r /etc/os-release ]] || die "Cannot identify this Linux distribution."
# /etc/os-release is the operating system's trusted identification file.
. /etc/os-release
case "${ID:-}" in
  ubuntu) [[ "${VERSION_ID:-}" == 22.04 || "${VERSION_ID:-}" == 24.04 ]] || die "Supported Ubuntu releases: 22.04 and 24.04." ;;
  debian) [[ "${VERSION_ID:-}" =~ ^[0-9]+(\.[0-9]+)?$ ]] && ((${VERSION_ID%%.*} >= 12)) || die "Debian 12 or newer is required." ;;
  *) die "Supported distributions: Ubuntu 22.04/24.04 and Debian 12+." ;;
esac
command -v apt-get >/dev/null || die "apt-get is required."

origin="https://$domain"
config=/etc/unmanned-boat-web
target=/opt/unmanned-boat-web
runtime=/opt/unmanned-boat-node22
nginx_conf=/etc/nginx/conf.d/unmanned-boat-web.conf
acme=/var/lib/unmanned-boat-acme
renew_hook=/etc/letsencrypt/renewal-hooks/deploy/unmanned-boat-web-reload.sh
repository=https://github.com/Coffeebean66/UnmannedBoat-Web.git
phase=preflight
work_dir=''
finished=0

reject_existing() {
  local item="$1" parent
  [[ ! -e "$item" && ! -L "$item" ]] || die "First installation only: $item already exists. Use the existing installation's update process."
  parent="$(dirname -- "$item")"
  while [[ "$parent" != / ]]; do
    [[ ! -L "$parent" ]] || die "Refusing a symbolic-link installation path: $parent"
    parent="$(dirname -- "$parent")"
  done
}
for item in "$config" "$target" "$nginx_conf" "$acme" "$renew_hook" \
  /etc/systemd/system/unmanned-boat-web.service \
  /etc/systemd/system/unmanned-boat-mqtt.service \
  /etc/systemd/system/unmanned-boat-web.service.d \
  /etc/systemd/system/unmanned-boat-web-update.service \
  /etc/systemd/system/unmanned-boat-web-update.path \
  /usr/local/lib/unmanned-boat-web-update /var/lib/unmanned-boat-web-update \
  /etc/systemd/system/unmanned-boat-mqtt-admin.service \
  /etc/systemd/system/unmanned-boat-mqtt-admin.socket \
  /usr/local/lib/unmanned-boat-mqtt-admin /run/unmanned-boat-mqtt-admin \
  "/etc/letsencrypt/live/$domain" "/etc/letsencrypt/archive/$domain" "/etc/letsencrypt/renewal/$domain.conf"; do
  reject_existing "$item"
done

check_ports() {
  command -v ss >/dev/null || return 0
  [[ -z "$(ss -H -ltn "sport = :$port")" ]] || die "Web port $port is already in use."
  [[ -z "$(ss -H -ltn 'sport = :1883')" ]] || die "MQTT port 1883 is already in use. Existing brokers are not replaced."
  local sockets
  sockets="$(ss -H -ltnp '( sport = :80 or sport = :443 )')"
  if [[ -n "$sockets" ]] && printf '%s\n' "$sockets" | grep -v '"nginx"' >/dev/null; then
    die "Ports 80/443 are used by a service other than Nginx. Configure that proxy manually."
  fi
}
check_ports
if systemctl is-active --quiet mosquitto.service || systemctl is-enabled --quiet mosquitto.service; then
  die "An existing Mosquitto service is active/enabled; integrate it manually."
fi

cleanup() {
  local result=$? resolved
  trap - EXIT
  set +e
  if [[ -n "$work_dir" && "$work_dir" == /tmp/unmanned-boat-install.* && -d "$work_dir" && ! -L "$work_dir" ]]; then
    resolved="$(readlink -f -- "$work_dir")"
    if [[ "$resolved" == "$work_dir" ]]; then rm -rf -- "$work_dir"; fi
  fi
  if [[ "$finished" != 1 ]]; then
    echo "Installation NOT complete (phase: $phase, exit: $result)." >&2
    echo "Already generated application/configuration files are retained for diagnosis; this is not a full rollback." >&2
    echo "Inspect: journalctl -u unmanned-boat-web -u unmanned-boat-mqtt -n 80" >&2
    [[ ! -d "$config" ]] || echo "Private connection/account files, if generated, remain under $config; do not publish them." >&2
  fi
  exit "$result"
}
trap cleanup EXIT
work_dir="$(mktemp -d /tmp/unmanned-boat-install.XXXXXXXX)"

echo "Installing $origin; internal web port $port."
echo "The DNS A record must point to this server's IPv4 address; this installer does not configure IPv6/AAAA."
echo "Allow inbound TCP 80/443 and MQTT TCP 1883 in your firewall/security group."
echo "This installer does not change firewall rules or unrelated Nginx sites."
phase=dependencies
apt-get update
# Let deploy-cloud.sh install Mosquitto and manage only the default unit it creates.
# --no-upgrade avoids upgrading/restarting an already installed Nginx package.
DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y --no-upgrade --no-install-recommends \
  git curl ca-certificates xz-utils libstdc++6 nginx certbot iproute2 procps
check_ports
nginx -t
# Do not create a competing virtual host for an already configured domain.
if nginx -T 2>/dev/null | awk -v wanted="$domain" '
  /^[ \t]*server_name[ \t]/ {
    for (i=2; i<=NF; i++) {
      name=$i; sub(/;.*/, "", name);
      if (name==wanted || (substr(name,1,2)=="*." && length(wanted)>length(name)-1 && substr(wanted,length(wanted)-length(name)+2)==substr(name,2))) found=1;
    }
  }
  END {exit found?0:1}
'; then die "This domain is already configured in Nginx; existing sites were preserved."; fi

phase=node-runtime
node_path="$(command -v node || true)"
npm_path="$(command -v npm || true)"
node_real="$(readlink -f -- "$node_path" 2>/dev/null || true)"
npm_real="$(readlink -f -- "$npm_path" 2>/dev/null || true)"
usable_node=0
if [[ "$node_path" =~ ^/[A-Za-z0-9_./-]+$ && "$npm_path" =~ ^/[A-Za-z0-9_./-]+$ &&
      ( "$node_real" == /usr/* || "$node_real" == /opt/* ) &&
      ( "$npm_real" == /usr/* || "$npm_real" == /opt/* ) ]]; then
  if [[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 18' 2>/dev/null || true)" == true ]] && npm --version >/dev/null 2>&1; then usable_node=1; fi
fi
download() { curl --fail --show-error --location --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 300 "$1" -o "$2"; }
if [[ "$usable_node" != 1 ]]; then
  reject_existing "$runtime"
  case "$(uname -m)" in x86_64) architecture=x64;; aarch64|arm64) architecture=arm64;; *) die "Automatic Node installation supports x86_64 and arm64 only.";; esac
  download https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt "$work_dir/SHASUMS256.txt"
  archive="$(awk -v arch="$architecture" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$work_dir/SHASUMS256.txt")"
  [[ "$archive" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || die "Cannot identify an official Node 22 archive."
  download "https://nodejs.org/dist/latest-v22.x/$archive" "$work_dir/$archive"
  (cd "$work_dir"; awk -v name="$archive" '$2==name {print}' SHASUMS256.txt > selected-shasum.txt; sha256sum -c selected-shasum.txt)
  install -d -m 755 "$runtime"
  tar -xJf "$work_dir/$archive" --strip-components=1 -C "$runtime" --no-same-owner
  chmod -R go+rX "$runtime"
  export PATH="$runtime/bin:$PATH"
fi
node --version
npm --version

phase=download-source
git clone --depth 1 --branch main "$repository" "$work_dir/source"
commit="$(git -C "$work_dir/source" rev-parse HEAD)"
node - "$work_dir/source" "$commit" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [directory,commit]=process.argv.slice(2),{version}=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
if(!/^[0-9a-f]{40}$/.test(commit)||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))throw Error('Invalid release metadata');
fs.writeFileSync(path.join(directory,'.boat-web-release.json'),JSON.stringify({commit,version})+'\n',{mode:0o644,flag:'wx'});
NODE

phase=mqtt-and-web
bash "$work_dir/source/deploy-cloud.sh" "$port" 127.0.0.1 "$origin"
phase=accounts
node - "$config" "$origin" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [directory,origin]=process.argv.slice(2),password=()=>crypto.randomBytes(24).toString('base64url');
if(fs.readFileSync(path.join(directory,'.boat-cloud-deployment'),'utf8').trim()!=='unmanned-boat-cloud-v1')throw Error('Missing cloud ownership marker');
const admin=password(),guest=password();
fs.writeFileSync(path.join(directory,'accounts.env'),`BOAT_ACCOUNTS_ENABLED=1\nBOAT_ACCOUNTS_ORIGIN=${origin}\nBOAT_ADMIN_USERNAME=admin\nBOAT_ADMIN_PASSWORD=${admin}\nBOAT_GUEST_USERNAME=guest\nBOAT_GUEST_PASSWORD=${guest}\n`,{mode:0o600,flag:'wx'});
fs.writeFileSync(path.join(directory,'accounts-access.txt'),`Private platform accounts; never publish or commit.\nWebsite: ${origin}\nAdministrator username: admin\nAdministrator password: ${admin}\nGuest username: guest\nGuest password: ${guest}\n`,{mode:0o600,flag:'wx'});
NODE
systemctl restart unmanned-boat-web.service

phase=https-challenge
install -d -m 755 "$acme/.well-known/acme-challenge" /etc/nginx/conf.d
cat > "$work_dir/nginx-http.conf" <<EOF
# Owned by unmanned-boat-first-install-v1
server {
    listen 80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ {
        root $acme;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 404; }
}
EOF
install -m 644 "$work_dir/nginx-http.conf" "$nginx_conf"
if ! nginx -t; then rm -- "$nginx_conf"; die "Nginx rejected the new HTTP configuration; existing sites were not reloaded."; fi
systemctl enable nginx.service
if systemctl is-active --quiet nginx.service; then systemctl reload nginx.service; else systemctl start nginx.service; fi

phase=certificate
certbot certonly --webroot --webroot-path "$acme" --domain "$domain" --cert-name "$domain" \
  --email "$email" --agree-tos --non-interactive --keep-until-expiring

phase=https-proxy
cat > "$work_dir/nginx-https.conf" <<EOF
# Owned by unmanned-boat-first-install-v1
server {
    listen 80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ { root $acme; try_files \$uri =404; }
    location / { return 301 https://$domain\$request_uri; }
}
server {
    listen 443 ssl;
    server_name $domain;
    ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
EOF
install -m 644 "$work_dir/nginx-https.conf" "$nginx_conf"
if ! nginx -t; then install -m 644 "$work_dir/nginx-http.conf" "$nginx_conf"; die "Nginx rejected HTTPS configuration; the valid challenge-only configuration was restored."; fi
systemctl reload nginx.service
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > "$work_dir/renew-hook.sh" <<'EOF'
#!/usr/bin/env bash
# Owned by unmanned-boat-first-install-v1
set -euo pipefail
/usr/sbin/nginx -t
if systemctl is-active --quiet nginx.service; then systemctl reload nginx.service; fi
EOF
install -m 755 "$work_dir/renew-hook.sh" "$renew_hook"
# Debian/Ubuntu's packaged Certbot normally enables this timer; make it explicit.
systemctl enable --now certbot.timer

phase=web-updater
bash "$work_dir/source/maintenance/install-update.sh" "$origin" "$port"
phase=mqtt-device-administration
bash "$work_dir/source/maintenance/install-mqtt-device-admin.sh"
phase=health-check
curl --fail --show-error --silent --resolve "$domain:443:127.0.0.1" --max-time 15 "$origin/healthz" >/dev/null
systemctl is-active --quiet unmanned-boat-web.service unmanned-boat-mqtt.service nginx.service
finished=1
echo "Installation complete: $origin"
echo "Administrator/guest credentials (root only): $config/accounts-access.txt"
echo "MQTT boat-01 firmware connection settings (root only): $config/access.txt"
echo "Use: sudo cat $config/accounts-access.txt"
echo "Services: systemctl status unmanned-boat-web unmanned-boat-mqtt nginx"
echo "Logs: journalctl -u unmanned-boat-web -u unmanned-boat-mqtt -n 80"
echo "Web updater and administrator MQTT device-account management are enabled. No firewall/security-group rules were changed."
echo "MQTT TCP 1883 is unencrypted; the generated dedicated device credentials are required."
