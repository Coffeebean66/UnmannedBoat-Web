#!/usr/bin/env bash
# 独立安装 SRT/UDP → WebRTC 视频网关；不使用 Docker，不修改船端或 MQTT 凭据。
set -euo pipefail
umask 077
die() { echo "Video media installation: $*" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || die 'run with sudo.'
[[ $# -ge 1 && $# -le 2 ]] || die 'usage: sudo bash maintenance/install-video-media.sh <public-host-or-ipv4> [internal-web-port=7890]'
public_host="$1"
web_port="${2:-7890}"
[[ "$web_port" =~ ^[0-9]{1,5}$ ]] && ((10#$web_port >= 1 && 10#$web_port <= 65535 && 10#$web_port != 8889)) || die 'invalid internal web port (8889 is reserved for the local media gateway).'
web_port="$((10#$web_port))"

# 官方固定发布：同时固定压缩包内容的 SHA-256，下载内容在校验前不会执行。
media_version=v1.21.3
case "$(uname -m)" in
  x86_64|amd64) media_arch=amd64; media_sha256=0a2ea7eba96023631efa1bea7804823a9145b043b6646a8a05798d4ac24ed635 ;;
  aarch64|arm64) media_arch=arm64; media_sha256=27f038237cb5f77a724f6afc58eca2798f2bc4edf9989895631a80eeb41a4fe2 ;;
  *) die 'only Linux x86_64/amd64 and aarch64/arm64 are supported.' ;;
esac
[[ "$(uname -s)" == Linux ]] || die 'Linux with systemd is required.'
for name in node curl systemctl stat install readlink ss tar sha256sum mktemp grep cp rm rmdir cat chmod dirname uname; do
  command -v "$name" >/dev/null || die "missing prerequisite: $name"
done
read -r _ systemd_version _ < <(systemctl --version)
[[ "$systemd_version" =~ ^[0-9]+$ ]] && ((systemd_version >= 247)) || die 'systemd 247+ is required for private service credentials.'

app=/opt/unmanned-boat-web
config=/etc/unmanned-boat-video
program=/usr/local/lib/unmanned-boat-video
units=/etc/systemd/system
unit="$units/unmanned-boat-video.service"
dropin="$units/unmanned-boat-web.service.d/45-video-media.conf"
socket=/run/unmanned-boat-mqtt-admin/control.sock
marker=unmanned-boat-video-media-v1

trusted_path() {
  local current="$1" permissions
  while [[ "$current" != / ]]; do
    [[ ! -L "$current" ]] || die 'linked installation paths are not supported.'
    if [[ -e "$current" ]]; then
      permissions="$(stat -c %a "$current")"
      [[ "$permissions" =~ ^[0-7]{3,4}$ && "$(stat -c %u "$current")" == 0 ]] &&
        (( (8#$permissions & 8#022) == 0 )) || die 'installation paths must be root-owned and not group/world-writable.'
    fi
    current="$(dirname -- "$current")"
  done
}
node_path="$(readlink -f -- "$(command -v node)")"
[[ "$node_path" =~ ^/[A-Za-z0-9_./-]+$ && -f "$node_path" && -x "$node_path" ]] || die 'use a trusted system Node.js executable.'
trusted_path "$node_path"
"$node_path" - "$public_host" <<'HOST_CHECK'
const net=require('node:net'),host=process.argv[2];
const domain=typeof host==='string'&&host.length<=253&&host.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
if(!host||!(net.isIP(host)===4||domain&&!/^[0-9.]+$/.test(host)))process.exit(1);
HOST_CHECK
for entry in "$app" "$config" "$program" "$units" "$units/unmanned-boat-web.service.d"; do trusted_path "$entry"; done
[[ -f "$app/.boat-web-deployment" && "$(cat "$app/.boat-web-deployment")" == unmanned-boat-web-v1 ]] || die 'install the managed web application first.'
[[ -f "$app/server/video-media-api.js" ]] || die 'update the web application to a version supporting SRT/WebRTC first.'
for entry in "$app/.boat-web-deployment" "$app/server/video-media-api.js" "$units/unmanned-boat-web.service"; do trusted_path "$entry"; done
grep -qx '# Owned by unmanned-boat-web-v1' "$units/unmanned-boat-web.service" || die 'refusing an unmanaged web service.'
for directory in "$program" "$config"; do
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && -f "$directory/.boat-video-media-deployment" && ! -L "$directory/.boat-video-media-deployment" && "$(cat "$directory/.boat-video-media-deployment")" == "$marker" ]] || die 'refusing an unrelated video installation directory.'
    trusted_path "$directory/.boat-video-media-deployment"
  fi
done
for entry in "$unit" "$dropin"; do
  trusted_path "$entry"
  if [[ -e "$entry" ]]; then
    [[ -f "$entry" && "$(stat -c %h "$entry")" == 1 ]] && grep -qx '# Owned by unmanned-boat-video-media-v1' "$entry" || die 'refusing an unrelated service or web drop-in.'
  fi
done
for entry in "$program/mediamtx" "$config/runtime.env" "$config/mediamtx.yml"; do
  trusted_path "$entry"
  [[ ! -e "$entry" || -f "$entry" && "$(stat -c %h "$entry")" == 1 ]] || die 'unexpected video media installation file.'
done
[[ ! -e "$config/runtime.env" || "$(stat -c %a "$config/runtime.env")" == 600 ]] || die 'video runtime.env must be private (mode 600).'
[[ ! -e "$config/mediamtx.yml" || "$(stat -c %a "$config/mediamtx.yml")" == 600 ]] || die 'video configuration must be private (mode 600).'
video_was_active=0
video_was_enabled=0
web_was_active=0
systemctl is-active --quiet unmanned-boat-video.service && video_was_active=1
systemctl is-enabled --quiet unmanned-boat-video.service && video_was_enabled=1
systemctl is-active --quiet unmanned-boat-web.service && web_was_active=1
new_directories=()
for directory in "$program" "$config" "$units/unmanned-boat-web.service.d"; do
  [[ -d "$directory" ]] || new_directories+=("$directory")
done
for video_udp_port in 8890 8189; do
  if [[ -n "$(ss -H -lun "sport = :$video_udp_port")" && "$video_was_active" == 0 ]]; then die "UDP port $video_udp_port is already used; existing listeners were not changed."; fi
done
if [[ -n "$(ss -H -ltn 'sport = :8889')" && "$video_was_active" == 0 ]]; then die 'local TCP port 8889 is already used.'; fi
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$web_port/healthz" |
  "$node_path" -e 'let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{try{const v=JSON.parse(s);if(v.ok!==true||v.app!=="unmanned-boat-web"||v.readiness?.accountsEnabled!==true)throw Error();}catch(_){console.error("Managed website readiness failed; enable platform accounts first.");process.exitCode=1;}});'
[[ -S "$socket" ]] || die 'install/update maintenance/install-mqtt-device-admin.sh first.'
curl --fail --silent --show-error --max-time 10 --unix-socket "$socket" http://localhost/devices |
  "$node_path" -e 'let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{try{const v=JSON.parse(s);if(v.canAuthenticateVideo!==true)throw Error();}catch(_){console.error("Update the MQTT management component before installing video media: sudo bash maintenance/install-mqtt-device-admin.sh");process.exitCode=1;}});'

stage="$(mktemp -d /tmp/boat-video-media.XXXXXXXX)"
committing=0
completed=0
destinations=("$program/mediamtx" "$config/runtime.env" "$config/mediamtx.yml" "$unit" "$dropin" "$program/.boat-video-media-deployment" "$config/.boat-video-media-deployment")
existed=()
previous_modes=()
finish() {
  local status=$? index
  trap - EXIT
  if [[ "$committing" == 1 && "$completed" == 0 ]]; then
    set +e
    systemctl stop unmanned-boat-video.service >/dev/null 2>&1
    [[ "$video_was_enabled" == 1 ]] || systemctl disable unmanned-boat-video.service >/dev/null 2>&1
    for index in "${!destinations[@]}"; do
      if [[ "${existed[$index]}" == 1 ]]; then install -o root -g root -m "${previous_modes[$index]}" "$stage/previous-$index" "${destinations[$index]}"
      else rm -f -- "${destinations[$index]}"; fi
    done
    # rmdir 只处理本次新建且已恢复为空的固定目录；不递归删除未知文件。
    for directory in "${new_directories[@]}"; do rmdir -- "$directory" 2>/dev/null; done
    systemctl daemon-reload
    [[ "$video_was_active" == 0 ]] || systemctl start unmanned-boat-video.service
    [[ "$web_was_active" == 0 ]] || systemctl restart unmanned-boat-web.service
    echo 'Video media installation did not complete; previous managed files were restored. Inspect the service journal.' >&2
  fi
  # 只删除本次 mktemp 创建的固定前缀目录，不接受用户提供的清理路径。
  if [[ "$stage" == /tmp/boat-video-media.* && -d "$stage" && ! -L "$stage" ]]; then rm -rf -- "$stage"; fi
  exit "$status"
}
trap finish EXIT
archive="mediamtx_${media_version}_linux_${media_arch}.tar.gz"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --max-time 180 \
  "https://github.com/bluenviron/mediamtx/releases/download/$media_version/$archive" -o "$stage/$archive"
printf '%s  %s\n' "$media_sha256" "$stage/$archive" | sha256sum --check --status || die 'MediaMTX SHA-256 mismatch; nothing was installed.'
# 只将已校验压缩包中的固定普通文件写到 staging，避免把归档路径当作系统路径。
[[ "$(tar -tzf "$stage/$archive" mediamtx)" == mediamtx ]] || die 'unexpected MediaMTX archive layout.'
[[ "$(tar -tvzf "$stage/$archive" mediamtx)" == -* ]] || die 'MediaMTX archive binary is not a regular file.'
tar -xOzf "$stage/$archive" mediamtx > "$stage/mediamtx"
chmod 755 "$stage/mediamtx"
[[ "$("$stage/mediamtx" --version)" == "$media_version" ]] || die 'downloaded binary version mismatch.'

# 配置生成器不打印密钥，重复安装保留已有回调和内部读取凭据。
"$node_path" - "$config/runtime.env" "$stage/runtime.env" "$stage/mediamtx.yml" "$public_host" "$web_port" <<'MEDIA_CONFIG'
const fs=require('node:fs'),crypto=require('node:crypto'),net=require('node:net');
const [previous,runtime,configuration,host,rawPort]=process.argv.slice(2),port=Number(rawPort);
const domain=typeof host==='string'&&host.length<=253&&host.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
if(!(net.isIP(host)===4||domain&&!/^[0-9.]+$/.test(host))||!Number.isInteger(port)||port<1||port>65535||port===8889)throw Error('Invalid video media host or port');
const old={};
if(fs.existsSync(previous)){
  for(const line of fs.readFileSync(previous,'utf8').split(/\r?\n/)){
    if(!line)continue;
    const match=line.match(/^([A-Z_]+)=(.*)$/);
    if(!match||Object.hasOwn(old,match[1]))throw Error('Existing video runtime configuration is invalid');
    old[match[1]]=match[2];
  }
  for(const name of ['BOAT_VIDEO_MEDIA_AUTH_TOKEN','BOAT_VIDEO_MEDIA_READER_PASSWORD'])if(!/^[a-f0-9]{64}$/.test(old[name]||''))throw Error('Existing video secrets are invalid; configuration was not replaced');
}
const token=old.BOAT_VIDEO_MEDIA_AUTH_TOKEN||crypto.randomBytes(32).toString('hex');
const reader=old.BOAT_VIDEO_MEDIA_READER_PASSWORD||crypto.randomBytes(32).toString('hex');
const env={BOAT_VIDEO_MEDIA_ENABLED:'1',BOAT_VIDEO_MEDIA_AUTH_TOKEN:token,BOAT_VIDEO_MEDIA_READER_PASSWORD:reader,BOAT_VIDEO_MEDIA_PUBLIC_HOST:host,BOAT_VIDEO_SRT_PORT:'8890',BOAT_VIDEO_WEBRTC_PORT:'8189'};
fs.writeFileSync(runtime,Object.entries(env).map(([key,value])=>key+'='+value).join('\n')+'\n',{mode:0o600,flag:'wx'});
const lines=['# Owned by unmanned-boat-video-media-v1','logLevel: warn','logDestinations: [stdout]','readTimeout: 10s','writeTimeout: 10s','writeQueueSize: 256','udpMaxPayloadSize: 1200','authMethod: http',
  'authHTTPAddress: '+JSON.stringify('http://127.0.0.1:'+port+'/api/video/media/auth?token='+token),'authHTTPExclude: []','api: false','metrics: false','pprof: false','playback: false','rtsp: false','rtmp: false','hls: false','moq: false','webrtc: true','webrtcAddress: 127.0.0.1:8889','webrtcEncryption: false','webrtcAllowOrigins: []','webrtcTrustedProxies: []','webrtcLocalUDPAddress: :8189','webrtcLocalTCPAddress: ""','webrtcIPsFromInterfaces: false','webrtcAdditionalHosts: ['+JSON.stringify(host)+']','webrtcICEServers2: []','webrtcHandshakeTimeout: 10s','webrtcTrackGatherTimeout: 2s','srt: true','srtAddress: :8890','pathDefaults:','  source: publisher','  overridePublisher: false','  maxReaders: 16','  record: false','paths:',"  '~^[A-Za-z0-9_-]{1,64}$': {}"];
fs.writeFileSync(configuration,lines.join('\n')+'\n',{mode:0o600,flag:'wx'});
MEDIA_CONFIG

for index in "${!destinations[@]}"; do
  if [[ -f "${destinations[$index]}" ]]; then
    existed[$index]=1
    previous_modes[$index]="$(stat -c %a "${destinations[$index]}")"
    cp -- "${destinations[$index]}" "$stage/previous-$index"
  else existed[$index]=0; previous_modes[$index]=600; fi
done
committing=1
install -d -o root -g root -m 755 "$program" "$config" "$units/unmanned-boat-web.service.d"
install -o root -g root -m 755 "$stage/mediamtx" "$program/mediamtx"
install -o root -g root -m 600 "$stage/runtime.env" "$config/runtime.env"
install -o root -g root -m 600 "$stage/mediamtx.yml" "$config/mediamtx.yml"
for directory in "$program" "$config"; do printf '%s\n' "$marker" > "$directory/.boat-video-media-deployment"; chmod 644 "$directory/.boat-video-media-deployment"; done
cat > "$unit" <<'SERVICE'
# Owned by unmanned-boat-video-media-v1
[Unit]
Description=Unmanned Boat SRT UDP to WebRTC media gateway
After=network-online.target unmanned-boat-web.service
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
User=boat-video-media
LoadCredential=mediamtx.yml:/etc/unmanned-boat-video/mediamtx.yml
ExecStart=/usr/local/lib/unmanned-boat-video/mediamtx %d/mediamtx.yml
WorkingDirectory=/usr/local/lib/unmanned-boat-video
UMask=0077
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitNOFILE=4096
TasksMax=64
MemoryMax=256M
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
SERVICE
cat > "$dropin" <<'DROPIN'
# Owned by unmanned-boat-video-media-v1
[Service]
EnvironmentFile=/etc/unmanned-boat-video/runtime.env
DROPIN
chmod 644 "$unit" "$dropin"
systemctl daemon-reload
systemctl restart unmanned-boat-web.service
web_ready=0
for attempt in {1..20}; do
  if systemctl is-active --quiet unmanned-boat-web.service && curl --fail --silent --max-time 2 "http://127.0.0.1:$web_port/healthz" |
    "$node_path" -e 'let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{try{const v=JSON.parse(s);if(v.ok!==true||v.app!=="unmanned-boat-web"||v.readiness?.accountsEnabled!==true)throw Error();}catch(_){process.exitCode=1;}});'; then web_ready=1; break; fi
  sleep 0.5
done
[[ "$web_ready" == 1 ]] || die 'web service readiness failed; the installation will roll back.'
systemctl enable unmanned-boat-video.service
systemctl restart unmanned-boat-video.service
ready=0
for attempt in {1..20}; do
  if systemctl is-active --quiet unmanned-boat-video.service && curl --silent --output /dev/null --max-time 2 http://127.0.0.1:8889/; then ready=1; break; fi
  sleep 0.5
done
[[ "$ready" == 1 ]] || die 'media gateway readiness failed; the installation will roll back.'
completed=1
echo "MediaMTX $media_version installed: SRT UDP 8890, WebRTC UDP 8189, public host $public_host."
echo 'Open inbound UDP 8890 and UDP 8189 in the cloud security group and firewall. This script did not change firewall rules.'
echo 'Internal TCP 8889 stays on loopback; video signaling goes through the authenticated website.'
echo 'Configure each boat video account in Platform Settings; sender instructions are in VIDEO_UDP_SETUP.md.'
echo 'Private service settings: /etc/unmanned-boat-video/runtime.env (root only; do not publish).'
