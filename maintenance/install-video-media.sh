#!/usr/bin/env bash
# 独立安装 SRT/UDP → WebRTC 视频网关和服务器录像；不使用 Docker。
set -euo pipefail
umask 077
die() { echo "Video media installation: $*" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || die 'run with sudo.'
[[ $# -ge 1 && $# -le 2 ]] || die 'usage: sudo bash maintenance/install-video-media.sh <public-host-or-ipv4> [internal-web-port=7890]'
public_host="$1"
web_port="${2:-7890}"
[[ "$web_port" =~ ^[0-9]{1,5}$ ]] && ((10#$web_port >= 1 && 10#$web_port <= 65535 && 10#$web_port != 8889 && 10#$web_port != 9996 && 10#$web_port != 9997)) || die 'invalid internal web port (8889, 9996 and 9997 are reserved for the local media gateway).'
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
[[ -f "$app/server/video-recording-api.js" ]] || die 'update the web application to a version supporting server recordings first.'
for entry in "$app/.boat-web-deployment" "$app/server/video-media-api.js" "$app/server/video-recording-api.js" "$units/unmanned-boat-web.service"; do trusted_path "$entry"; done
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
for video_tcp_port in 8889 9996 9997; do
  if [[ -n "$(ss -H -ltn "sport = :$video_tcp_port")" && "$video_was_active" == 0 ]]; then die "local TCP port $video_tcp_port is already used."; fi
done
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

# 配置生成器不打印密钥；升级保留自定义接收源与其他配置，仅合入录像必需项。
"$node_path" - "$config/runtime.env" "$stage/runtime.env" "$stage/mediamtx.yml" "$public_host" "$web_port" "$config/mediamtx.yml" <<'MEDIA_CONFIG'
const fs=require('node:fs'),crypto=require('node:crypto'),net=require('node:net');
const [previous,runtime,configuration,host,rawPort,previousConfiguration]=process.argv.slice(2),port=Number(rawPort);
const domain=typeof host==='string'&&host.length<=253&&host.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
if(!(net.isIP(host)===4||domain&&!/^[0-9.]+$/.test(host))||!Number.isInteger(port)||port<1||port>65535||[8889,9996,9997].includes(port))throw Error('Invalid video media host or port');
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
const udpDevice=process.env.BOAT_VIDEO_UDP_DEVICE||'',udpRawPort=process.env.BOAT_VIDEO_UDP_PORT||'',udpPort=Number(udpRawPort);
if(!!udpDevice!==!!udpRawPort || udpDevice&&(!/^[A-Za-z0-9_-]{1,64}$/.test(udpDevice)||!/^\d{1,5}$/.test(udpRawPort)||!Number.isInteger(udpPort)||udpPort<1024||udpPort>65535||[port,8189,8889,8890,9996,9997].includes(udpPort)))throw Error('UDP video requires a valid device ID and an unused port in 1024..65535');
const udpFormat=process.env.BOAT_VIDEO_UDP_FORMAT||'rtp',udpPayload=process.env.BOAT_VIDEO_UDP_PAYLOAD_TYPE||'96';
if(udpDevice&&(!['rtp','mpegts'].includes(udpFormat)||!/^(?:9[6-9]|1[01][0-9]|12[0-7])$/.test(udpPayload)))throw Error('UDP format must be rtp or mpegts; RTP payload type must be 96..127');
const env={...old,BOAT_VIDEO_MEDIA_ENABLED:'1',BOAT_VIDEO_MEDIA_AUTH_TOKEN:token,BOAT_VIDEO_MEDIA_READER_PASSWORD:reader,BOAT_VIDEO_MEDIA_PUBLIC_HOST:host,BOAT_VIDEO_SRT_PORT:old.BOAT_VIDEO_SRT_PORT||'8890',BOAT_VIDEO_WEBRTC_PORT:old.BOAT_VIDEO_WEBRTC_PORT||'8189',BOAT_VIDEO_RECORDING_ENABLED:'1',BOAT_VIDEO_RECORDING_ROOT:old.BOAT_VIDEO_RECORDING_ROOT||'/var/lib/unmanned-boat-video'};
if(udpDevice){env.BOAT_VIDEO_UDP_DEVICE=udpDevice;env.BOAT_VIDEO_UDP_PORT=String(udpPort);env.BOAT_VIDEO_UDP_FORMAT=udpFormat;env.BOAT_VIDEO_UDP_PAYLOAD_TYPE=udpPayload;}
const lines=['# Owned by unmanned-boat-video-media-v1','logLevel: warn','logDestinations: [stdout]','readTimeout: 10s','writeTimeout: 10s','writeQueueSize: 256','udpMaxPayloadSize: 1200','authMethod: http',
  'authHTTPAddress: '+JSON.stringify('http://127.0.0.1:'+port+'/api/video/media/auth?token='+token),'authHTTPExclude: []',
  'api: true','apiAddress: 127.0.0.1:9997','apiAllowOrigins: []','apiTrustedProxies: []','metrics: false','pprof: false',
  'playback: true','playbackAddress: 127.0.0.1:9996','playbackAllowOrigins: []','playbackTrustedProxies: []',
  'rtsp: false','rtmp: false','hls: false','moq: false','webrtc: true','webrtcAddress: 127.0.0.1:8889','webrtcEncryption: false','webrtcAllowOrigins: []','webrtcTrustedProxies: []','webrtcLocalUDPAddress: :8189','webrtcLocalTCPAddress: ""','webrtcIPsFromInterfaces: false','webrtcAdditionalHosts: ['+JSON.stringify(host)+']','webrtcICEServers2: []','webrtcHandshakeTimeout: 10s','webrtcTrackGatherTimeout: 2s','srt: true','srtAddress: :8890',
  'pathDefaults:','  source: publisher','  overridePublisher: false','  maxReaders: 16','  record: false',
  '  recordPath: /var/lib/unmanned-boat-video/recordings/%path/%Y-%m-%d_%H-%M-%S-%f_%z','  recordFormat: fmp4','  recordPartDuration: 1s','  recordSegmentDuration: 60s','  recordDeleteAfter: 7d',
  'paths:',"  '~^[A-Za-z0-9_-]{1,64}$': {}"];
let output=lines;
// 保持原始 YAML 文本和路径块；不重新序列化未知字段，不将私密值打印到日志。
const scalar=(list,key,value,indent='',onlyMissing=false)=>{
 const expression=new RegExp('^'+indent+key+':(?:\\s|$)'),matches=list.map((line,index)=>expression.test(line)?index:-1).filter(index=>index>=0);
 if(matches.length>1)throw Error('Duplicate managed media configuration field');
 if(matches.length){if(!onlyMissing)list[matches[0]]=indent+key+': '+value;return;}
 list.push(indent+key+': '+value);
};
if(previousConfiguration&&fs.existsSync(previousConfiguration)){
 const text=fs.readFileSync(previousConfiguration,'utf8');
 if(text.length>1024*1024||text.includes('\t')||text.includes('\0'))throw Error('Existing media configuration needs manual review');
 const oldLines=text.replace(/\r\n/g,'\n').split('\n'),blocks=new Map(),preamble=[];let block=preamble;
 for(const line of oldLines){const match=line.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s|$)/);if(match){if(blocks.has(match[1]))throw Error('Duplicate media configuration key');block=[];blocks.set(match[1],block);}block.push(line);}
 if(!blocks.has('paths')||!blocks.has('pathDefaults')||!/^authMethod:\s*http\s*(?:#.*)?$/.test(blocks.get('authMethod')?.[0]||''))throw Error('Existing media configuration must use managed HTTP authentication and block paths');
 const setGlobal=(key,value)=>{const existing=blocks.get(key);if(existing)existing[0]=key+': '+value;else blocks.set(key,[key+': '+value]);};
 for(const [key,value]of Object.entries({authHTTPAddress:JSON.stringify('http://127.0.0.1:'+port+'/api/video/media/auth?token='+token),authHTTPExclude:'[]',api:'true',apiAddress:'127.0.0.1:9997',apiEncryption:'false',apiAllowOrigins:'[]',apiTrustedProxies:'[]',playback:'true',playbackAddress:'127.0.0.1:9996',playbackEncryption:'false',playbackAllowOrigins:'[]',playbackTrustedProxies:'[]',webrtcAdditionalHosts:'['+JSON.stringify(host)+']'}))setGlobal(key,value);
 const defaults=blocks.get('pathDefaults');
 if(!/^pathDefaults:\s*(?:#.*)?$/.test(defaults[0]))throw Error('Existing path defaults must be a block mapping');
 for(const [key,value]of Object.entries({record:'false',recordPath:'/var/lib/unmanned-boat-video/recordings/%path/%Y-%m-%d_%H-%M-%S-%f_%z',recordFormat:'fmp4',recordPartDuration:'1s',recordSegmentDuration:'60s',recordDeleteAfter:'7d'}))scalar(defaults,key,value,'  ',true);
 const paths=blocks.get('paths');if(!/^paths:\s*(?:#.*)?$/.test(paths[0]))throw Error('Existing paths must be a block mapping');
 output=[...preamble,...[...blocks.values()].flat()];
}
if(udpDevice){
 const start=output.findIndex(line=>/^paths:\s*(?:#.*)?$/.test(line));if(start<0)throw Error('Media paths are unavailable');
 const end=output.findIndex((line,index)=>index>start&&/^[A-Za-z][A-Za-z0-9]*:/.test(line)),limit=end<0?output.length:end;
 const expression=new RegExp('^  (?:'+udpDevice+'|"'+udpDevice+'"|\x27'+udpDevice+'\x27):(?:\\s*(.*))?$');
 const matches=output.map((line,index)=>index>start&&index<limit&&expression.test(line)?index:-1).filter(index=>index>=0);
 if(matches.length>1)throw Error('Duplicate UDP device path');
 const source='udp+'+udpFormat+'://0.0.0.0:'+udpPort;
 const sdp=['v=0','o=- 0 0 IN IP4 0.0.0.0','s=Boat H264 RTP','c=IN IP4 0.0.0.0','t=0 0','m=video '+udpPort+' RTP/AVP '+udpPayload,'a=rtpmap:'+udpPayload+' H264/90000','a=fmtp:'+udpPayload+' packetization-mode=1',''].join('\n');
 if(!matches.length)output.splice(start+1,0,'  '+JSON.stringify(udpDevice)+':','    source: '+JSON.stringify(source),...(udpFormat==='rtp'?['    rtpSDP: '+JSON.stringify(sdp)]:[]));
 else{
  const index=matches[0],tail=output[index].match(expression)[1]||'';
  if(tail&&tail.trim()!=='{}'&&!tail.trim().startsWith('#'))throw Error('UDP device path must be a block mapping');
  const next=output.findIndex((line,pos)=>pos>index&&(/^[A-Za-z][A-Za-z0-9]*:/.test(line)||/^  \S/.test(line))),last=next<0?output.length:next;
  const section=output.slice(index,last);section[0]='  '+JSON.stringify(udpDevice)+':';scalar(section,'source',JSON.stringify(source),'    ');
  const sdpIndex=section.findIndex(line=>/^    rtpSDP:/.test(line));if(sdpIndex>=0){let stop=sdpIndex+1;while(stop<section.length&&(section[stop].trim()===''||/^      /.test(section[stop])))stop++;section.splice(sdpIndex,stop-sdpIndex);}
  if(udpFormat==='rtp')scalar(section,'rtpSDP',JSON.stringify(sdp),'    ');output.splice(index,last-index,...section);
 }
}
fs.writeFileSync(runtime,Object.entries(env).map(([key,value])=>key+'='+value).join('\n')+'\n',{mode:0o600,flag:'wx'});
fs.writeFileSync(configuration,output.join('\n').replace(/\n*$/,'\n'),{mode:0o600,flag:'wx'});
MEDIA_CONFIG
"$stage/mediamtx" --validate-conf="$stage/mediamtx.yml" >/dev/null 2>&1 || die 'generated media configuration is invalid; existing configuration was not replaced.'

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
cat > "$stage/media.service" <<'SERVICE'
# Owned by unmanned-boat-video-media-v1
[Unit]
Description=Unmanned Boat SRT UDP to WebRTC media gateway
After=network-online.target unmanned-boat-web.service
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
User=boat-video-media
# 仅媒体进程能写录像状态目录；网页通过本地鉴权 API 读取，不授予磁盘访问。
StateDirectory=unmanned-boat-video
StateDirectoryMode=0700
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
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
LimitNOFILE=4096
TasksMax=64
MemoryMax=256M
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
SERVICE
# 已有受管理 unit 保留自定义启动参数和限制；只补充录像目录及 UDP 所需 netlink。
"$node_path" - "$unit" "$stage/media.service" <<'MEDIA_SERVICE'
const fs=require('node:fs');const [previous,target]=process.argv.slice(2);if(!fs.existsSync(previous))process.exit(0);
let lines=fs.readFileSync(previous,'utf8').replace(/\r\n/g,'\n').split('\n');const start=lines.indexOf('[Service]');
if(start<0)throw Error('Managed media service has no Service section');
let end=lines.findIndex((line,index)=>index>start&&/^\[/.test(line));if(end<0)end=lines.length;
const section=lines.slice(start,end);
const set=(name,value)=>{const found=section.map((line,index)=>line.startsWith(name+'=')?index:-1).filter(index=>index>=0);if(found.length>1)throw Error('Repeated media service storage setting needs manual review');if(found.length)section[found[0]]=name+'='+value;else section.push(name+'='+value);};
const state=section.find(line=>line.startsWith('StateDirectory='))?.slice('StateDirectory='.length)||'';
if(!state.split(/\s+/).includes('unmanned-boat-video'))set('StateDirectory',[state,'unmanned-boat-video'].filter(Boolean).join(' '));
set('StateDirectoryMode','0700');
const family=section.find(line=>line.startsWith('RestrictAddressFamilies='))?.slice('RestrictAddressFamilies='.length)||'';
if(family.startsWith('~')){const excluded=family.slice(1).split(/\s+/).filter(value=>value&&value!=='AF_NETLINK');set('RestrictAddressFamilies',excluded.length?'~'+excluded.join(' '):'');}
else set('RestrictAddressFamilies',[...new Set([...family.split(/\s+/).filter(Boolean),'AF_UNIX','AF_INET','AF_INET6','AF_NETLINK'])].join(' '));
lines.splice(start,end-start,...section);fs.writeFileSync(target,lines.join('\n').replace(/\n*$/,'\n'),{mode:0o644});
MEDIA_SERVICE
install -o root -g root -m 644 "$stage/media.service" "$unit"
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
echo 'Internal TCP 8889/9996/9997 stay on loopback; video signaling, recordings and playback require platform login.'
echo 'Configure each boat video account in Platform Settings; sender instructions are in VIDEO_UDP_SETUP.md.'
echo 'Server recording is available in the video page. Storage is /var/lib/unmanned-boat-video; see VIDEO_RECORDING_SETUP.md.'
echo 'Private service settings: /etc/unmanned-boat-video/runtime.env (root only; do not publish).'
