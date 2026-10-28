'use strict';
// 配置生成器真实执行；Bash 安装/停用事务在临时根目录运行，不接触主机服务或公网。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const project=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(project,'maintenance/install-video-media.sh'),'utf8');
const generator=source.match(/<<'MEDIA_CONFIG'\r?\n([\s\S]*?)\r?\nMEDIA_CONFIG/)[1];
const unix=value=>value.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
const candidates=process.platform==='win32'?[process.env.BOAT_TEST_BASH,'D:/Software/Git/bin/bash.exe','C:/Program Files/Git/bin/bash.exe'].filter(Boolean):['bash'];
const bash=candidates.find(name=>spawnSync(name,['--version'],{encoding:'utf8'}).status===0);
function temporary(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-video-media-test-'));
  t.after(()=>{assert.match(path.basename(directory),/^boat-video-media-test-/);fs.rmSync(directory,{recursive:true,force:true});});
  return directory;
}
function generate(directory,previous='missing.env',host='boat.example.com',port='7890',suffix='',options={}){
  const runtime=path.join(directory,'runtime'+suffix+'.env'),configuration=path.join(directory,'mediamtx'+suffix+'.yml');
  const result=spawnSync(process.execPath,['-',path.join(directory,previous),runtime,configuration,host,port,...(options.previousConfiguration?[options.previousConfiguration]:[])],{input:generator,encoding:'utf8',env:{...process.env,BOAT_VIDEO_UDP_DEVICE:'',BOAT_VIDEO_UDP_PORT:'',BOAT_VIDEO_UDP_FORMAT:'',BOAT_VIDEO_UDP_PAYLOAD_TYPE:'',...options.env}});
  return {...result,runtime,configuration};
}
test('媒体配置启用SRT、本地WebRTC与鉴权录像API，随机密钥不输出且重复生成保留凭据',t=>{
  const directory=temporary(t),first=generate(directory);assert.equal(first.status,0,first.stderr);assert.equal(first.stdout,'');
  const env=fs.readFileSync(first.runtime,'utf8'),config=fs.readFileSync(first.configuration,'utf8');
  const values=Object.fromEntries(env.trim().split('\n').map(line=>line.split('=')));
  assert.match(values.BOAT_VIDEO_MEDIA_AUTH_TOKEN,/^[a-f0-9]{64}$/);assert.match(values.BOAT_VIDEO_MEDIA_READER_PASSWORD,/^[a-f0-9]{64}$/);
  assert.notEqual(values.BOAT_VIDEO_MEDIA_AUTH_TOKEN,values.BOAT_VIDEO_MEDIA_READER_PASSWORD);
  assert.match(config,/authMethod: http/);assert.ok(config.includes('/api/video/media/auth?token='+values.BOAT_VIDEO_MEDIA_AUTH_TOKEN));
  assert.match(config,/webrtcAddress: 127\.0\.0\.1:8889/);assert.match(config,/webrtcLocalUDPAddress: :8189/);assert.match(config,/srtAddress: :8890/);
  for(const protocol of ['metrics','pprof','rtsp','rtmp','hls','moq'])assert.match(config,new RegExp('^'+protocol+': false$','m'));
  assert.match(config,/^api: true$/m);assert.match(config,/^apiAddress: 127\.0\.0\.1:9997$/m);
  assert.match(config,/^playback: true$/m);assert.match(config,/^playbackAddress: 127\.0\.0\.1:9996$/m);
  assert.match(config,/^authHTTPExclude: \[\]$/m);assert.match(config,/^apiAllowOrigins: \[\]$/m);assert.match(config,/^playbackAllowOrigins: \[\]$/m);
  assert.equal(values.BOAT_VIDEO_RECORDING_ENABLED,'1');assert.equal(values.BOAT_VIDEO_RECORDING_ROOT,'/var/lib/unmanned-boat-video');
  assert.match(config,/recordPath: \/var\/lib\/unmanned-boat-video\/recordings\/%path\/%Y-%m-%d_%H-%M-%S-%f_%z/);
  assert.match(config,/recordFormat: fmp4/);assert.match(config,/recordPartDuration: 1s/);assert.match(config,/recordSegmentDuration: 60s/);assert.match(config,/recordDeleteAfter: 7d/);
  assert.match(config,/webrtcIPsFromInterfaces: false/);assert.match(config,/overridePublisher: false/);assert.match(config,/record: false/);
  assert.match(config,/webrtcAdditionalHosts: \["boat\.example\.com"\]/);
  const second=generate(directory,'runtime.env','47.251.109.111','7891','-new');assert.equal(second.status,0,second.stderr);
  const next=fs.readFileSync(second.runtime,'utf8');assert.ok(next.includes(values.BOAT_VIDEO_MEDIA_AUTH_TOKEN));assert.ok(next.includes(values.BOAT_VIDEO_MEDIA_READER_PASSWORD));
  assert.match(next,/BOAT_VIDEO_MEDIA_PUBLIC_HOST=47\.251\.109\.111/);assert.match(fs.readFileSync(second.configuration,'utf8'),/127\.0\.0\.1:7891\/api/);
  const defaults=generate(directory,'missing.env','boat.example.com','7890','-format-defaults',{env:{BOAT_VIDEO_UDP_FORMAT:'rtp',BOAT_VIDEO_UDP_PAYLOAD_TYPE:'96'}});
  assert.equal(defaults.status,0,defaults.stderr);assert.doesNotMatch(fs.readFileSync(defaults.configuration,'utf8'),/source: "udp\+/,'format defaults alone do not enable UDP');
});
test('无效旧密钥、重复env项及可注入的地址/端口在写入文件前拒绝',t=>{
  const directory=temporary(t);
  for(const [index,content] of ['BOAT_VIDEO_MEDIA_AUTH_TOKEN=broken\n','BOAT_VIDEO_MEDIA_AUTH_TOKEN='+('a'.repeat(64))+'\nBOAT_VIDEO_MEDIA_AUTH_TOKEN='+('a'.repeat(64))+'\n'].entries()){
    fs.writeFileSync(path.join(directory,'bad.env'),content);const result=generate(directory,'bad.env','boat.example.com','7890','-'+index);
    assert.notEqual(result.status,0);assert.equal(fs.existsSync(result.runtime),false);assert.equal(fs.existsSync(result.configuration),false);
  }
  for(const [index,host,port] of [[0,'example.com\napi: true','7890'],[1,'https://boat.example.com','7890'],[2,'boat.example.com','8889'],[3,'boat.example.com','0'],[4,'boat.example.com','9996'],[5,'boat.example.com','9997']]){
    const result=generate(directory,'missing.env',host,port,'-invalid-'+index);assert.notEqual(result.status,0);assert.equal(fs.existsSync(result.runtime),false);
  }
});

test('可按船配置原始UDP MPEG-TS接收，同时保留其他船的SRT入口',t=>{
  const directory=temporary(t),result=generate(directory,'missing.env','boat.example.com','7890','',{env:{BOAT_VIDEO_UDP_DEVICE:'boat-01',BOAT_VIDEO_UDP_PORT:'8000',BOAT_VIDEO_UDP_FORMAT:'mpegts'}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
  const config=fs.readFileSync(result.configuration,'utf8'),runtime=fs.readFileSync(result.runtime,'utf8');
  assert.match(config,/^  "boat-01":\n    source: "udp\+mpegts:\/\/0\.0\.0\.0:8000"$/m);
  assert.match(config,/^  '~\^\[A-Za-z0-9_-\]\{1,64\}\$': \{\}$/m);assert.match(config,/^srtAddress: :8890$/m);
  assert.match(runtime,/^BOAT_VIDEO_UDP_DEVICE=boat-01$/m);assert.match(runtime,/^BOAT_VIDEO_UDP_PORT=8000$/m);
  const rtp=generate(directory,'missing.env','boat.example.com','7890','-rtp',{env:{BOAT_VIDEO_UDP_DEVICE:'boat-01',BOAT_VIDEO_UDP_PORT:'8000'}});
  assert.equal(rtp.status,0,rtp.stderr);const rtpConfig=fs.readFileSync(rtp.configuration,'utf8');assert.match(rtpConfig,/source: "udp\+rtp:\/\/0\.0\.0\.0:8000"/);assert.match(rtpConfig,/rtpSDP: .*RTP\/AVP 96\\na=rtpmap:96 H264\/90000\\na=fmtp:96 packetization-mode=1/);
  for(const [index,env]of [
    {BOAT_VIDEO_UDP_DEVICE:'boat-01'}, {BOAT_VIDEO_UDP_PORT:'8000'},
    {BOAT_VIDEO_UDP_DEVICE:'bad/name',BOAT_VIDEO_UDP_PORT:'8000'}, {BOAT_VIDEO_UDP_DEVICE:'boat-01',BOAT_VIDEO_UDP_PORT:'80'},
    {BOAT_VIDEO_UDP_DEVICE:'boat-01',BOAT_VIDEO_UDP_PORT:'8000',BOAT_VIDEO_UDP_FORMAT:'rtsp'},
    {BOAT_VIDEO_UDP_DEVICE:'boat-01',BOAT_VIDEO_UDP_PORT:'8000',BOAT_VIDEO_UDP_PAYLOAD_TYPE:'128'},
    ...['7890','8189','8889','8890','9996','9997','65536','1e4','8000\napi: true'].map(port=>({BOAT_VIDEO_UDP_DEVICE:'boat-01',BOAT_VIDEO_UDP_PORT:port}))
  ].entries()){
    const invalid=generate(directory,'missing.env','boat.example.com','7890','-bad-'+index,{env});assert.notEqual(invalid.status,0);assert.equal(fs.existsSync(invalid.runtime),false);
  }
});

test('升级只合入录像和同源鉴权接口，保留自定义UDP源、未知字段和全部路径',t=>{
  const directory=temporary(t),first=generate(directory);assert.equal(first.status,0,first.stderr);
  let original=fs.readFileSync(first.configuration,'utf8').replace('logLevel: warn','logLevel: debug').replace('writeQueueSize: 256','writeQueueSize: 512')
    .replace('api: true','api: false').replace('playback: true','playback: false').replace(/^  record(?:Path|Format|PartDuration|SegmentDuration|DeleteAfter):.*\n/gm,'')
    .replace('paths:\n','paths:\n  boat-01:\n    source: udp+rtp://0.0.0.0:8000\n    rtpSDP: |\n      v=0\n      m=video 8000 RTP/AVP 96\n      a=rtpmap:96 H264/90000\n      a=fmtp:96 packetization-mode=1;profile-level-id=42e01f\n    sourceOnDemand: false\n    runOnReady: echo custom-ready\n  boat-02:\n    source: publisher\n');
  fs.writeFileSync(first.configuration,original);
  const result=generate(directory,'runtime.env','newboat.example.com','7891','-upgrade',{previousConfiguration:first.configuration});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');const next=fs.readFileSync(result.configuration,'utf8');
  assert.ok(next.includes('logLevel: debug'));assert.ok(next.includes('writeQueueSize: 512'));
  assert.ok(next.includes('  boat-01:\n    source: udp+rtp://0.0.0.0:8000\n    rtpSDP: |\n      v=0\n      m=video 8000 RTP/AVP 96\n      a=rtpmap:96 H264/90000\n      a=fmtp:96 packetization-mode=1;profile-level-id=42e01f\n    sourceOnDemand: false\n    runOnReady: echo custom-ready\n  boat-02:\n    source: publisher\n'));
  assert.match(next,/^api: true$/m);assert.match(next,/^playback: true$/m);assert.match(next,/^apiAddress: 127\.0\.0\.1:9997$/m);
  assert.match(next,/^  recordPath: \/var\/lib\/unmanned-boat-video\/recordings\/%path\//m);
  assert.match(next,/webrtcAdditionalHosts: \["newboat\.example\.com"\]/);assert.match(next,/127\.0\.0\.1:7891\/api\/video\/media\/auth/);
  const again=generate(directory,'runtime-upgrade.env','newboat.example.com','7891','-again',{previousConfiguration:result.configuration});
  assert.equal(again.status,0,again.stderr);assert.equal(fs.readFileSync(again.configuration,'utf8'),next,'reinstall remains stable');
  const changed=generate(directory,'runtime-upgrade.env','newboat.example.com','7891','-udp-change',{previousConfiguration:result.configuration,env:{BOAT_VIDEO_UDP_DEVICE:'boat-01',BOAT_VIDEO_UDP_PORT:'8001',BOAT_VIDEO_UDP_FORMAT:'mpegts'}});
  assert.equal(changed.status,0,changed.stderr);const updated=fs.readFileSync(changed.configuration,'utf8');assert.match(updated,/source: "udp\+mpegts:\/\/0\.0\.0\.0:8001"/);assert.ok(updated.includes('runOnReady: echo custom-ready'));assert.doesNotMatch(updated,/rtpSDP:/);assert.equal((updated.match(/boat-01/g)||[]).length,1);
});

function fixture(t){
  const directory=temporary(t),root=unix(directory),state=path.join(directory,'state');
  const write=(name,value)=>{const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);fs.chmodSync(file,0o755);return file;};
  fs.mkdirSync(state);fs.mkdirSync(path.join(directory,'tmp'));
  write('archive-source/mediamtx','#!/usr/bin/env bash\nprintf "v1.21.3\\n"\n');
  const archive=path.join(directory,'archive.tar.gz');
  const packed=spawnSync(bash,['-c','tar -czf "$1" -C "$2" mediamtx','--',unix(archive),root+'/archive-source'],{encoding:'utf8'});assert.equal(packed.status,0,packed.stderr);
  const sha=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const rewrite=text=>text.replace('[[ "$EUID" -eq 0 ]]','[[ 1 -eq 1 ]]')
    // Windows fixture cannot represent Linux ownership; marker/unit checks below remain real.
    .replace(/trusted_path\(\) \{[\s\S]*?\n\}/,'trusted_path() { :; }')
    .replace(/\/(?:etc|opt|run|var)\b/g,match=>root+match).replace(/\/usr\/local\/lib\b/g,root+'/usr/local/lib').replace(/\/tmp\/boat-video-media/g,root+'/tmp/boat-video-media')
    .replace('[[ -S "$socket" ]]','[[ -f "$socket" ]]') // Unix socket existence is represented by a fixture file on Windows.
    .replace(/media_sha256=[a-f0-9]{64}/g,'media_sha256='+sha).replace(/-o root -g root /g,'')
    .replace('set -euo pipefail','set -euo pipefail\nexport PATH="$BOAT_FIXTURE_BIN:$PATH"\nstat(){ case "$2" in %u) echo 0;; %h) echo 1;; %a) case "$3" in */runtime.env|*/mediamtx.yml) echo 600;; *) echo 755;; esac;; esac; }')
    .replace('current="$(dirname -- "$current")"','current="${current%/*}"; [[ -n "$current" ]] || current=/');
  for(const name of ['install-video-media.sh','remove-video-media.sh'])write('source/'+name,rewrite(fs.readFileSync(path.join(project,'maintenance',name),'utf8')));
  write('source/maintenance/remove-video-media.sh',rewrite(fs.readFileSync(path.join(project,'maintenance/remove-video-media.sh'),'utf8')));
  write('source/remove.sh',rewrite(fs.readFileSync(path.join(project,'remove.sh'),'utf8')));
  write('bin/node','#!/usr/bin/env bash\nexec \''+unix(process.execPath)+'\' "$@"\n');
  write('bin/ss','#!/usr/bin/env bash\nif [[ -n "${MOCK_TCP_USED:-}" && "$*" == *"sport = :$MOCK_TCP_USED"* ]]; then echo LISTEN; fi\nexit 0\n');
  write('bin/uname','#!/usr/bin/env bash\nif [[ "$1" == -m ]]; then echo x86_64; else echo Linux; fi\n');
  write('bin/curl',`#!/usr/bin/env bash
case "$*" in
  *releases/download*) while [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then cp "$MOCK_ARCHIVE" "$2"; exit; fi; shift; done; exit 1;;
  */healthz*) printf '{"ok":true,"app":"unmanned-boat-web","readiness":{"accountsEnabled":true}}';;
  *localhost/devices*) printf '{"canAuthenticateVideo":true}';;
  *127.0.0.1:8889/*) exit 0;;
  *) exit 1;;
esac
`);
  write('bin/systemctl',`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
service="\${@: -1}"
case "$1" in
  --version) printf 'systemd 252\\n';;
  is-active) [[ -f "$MOCK_STATE/$service.active" ]];;
  is-enabled) [[ -f "$MOCK_STATE/$service.enabled" ]];;
  stop) rm -f "$MOCK_STATE/$service.active";;
  start) touch "$MOCK_STATE/$service.active";;
  restart) if [[ "$service" == unmanned-boat-video.service && "\${MOCK_VIDEO_FAIL:-0}" == 1 ]]; then exit 1; fi; touch "$MOCK_STATE/$service.active";;
  enable) touch "$MOCK_STATE/$service.enabled";;
  disable) rm -f "$MOCK_STATE/$service.enabled"; if [[ "$*" == *--now* ]]; then rm -f "$MOCK_STATE/$service.active"; fi;;
  daemon-reload) :;;
  *) exit 1;;
esac
`);
  write('opt/unmanned-boat-web/.boat-web-deployment','unmanned-boat-web-v1\n');
  write('opt/unmanned-boat-web/server/video-media-api.js','// Supported media API.\n');
  write('opt/unmanned-boat-web/server/video-recording-api.js','// Supported recording API.\n');
  write('etc/systemd/system/unmanned-boat-web.service','# Owned by unmanned-boat-web-v1\n');
  write('run/unmanned-boat-mqtt-admin/control.sock','fixture socket');write('state/unmanned-boat-web.service.active','');
  const log=path.join(directory,'calls.log');
  const run=(script='install-video-media.sh',args=['boat.example.com'],extra={})=>spawnSync(bash,[...(process.env.BOAT_TEST_TRACE?['-x']:[]),root+'/source/'+script,...args],{
    encoding:'utf8',timeout:90000,env:{...process.env,BOAT_FIXTURE_BIN:root+'/bin',MOCK_STATE:unix(state),MOCK_LOG:unix(log),MOCK_ARCHIVE:unix(archive),...extra}});
  const read=name=>fs.readFileSync(path.join(directory,name),'utf8');
  return {directory,root,write,run,read,log};
}
test('视频安装与停用脚本Bash语法有效',{skip:!bash},()=>{
  for(const name of ['install-video-media.sh','remove-video-media.sh']){
    const result=spawnSync(bash,['-n',unix(path.join(project,'maintenance',name))],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
});
test('隔离安装生成最小权限服务、重装保留密钥，check-only不操作，停用保留恢复文件',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);
  const env=f.read('etc/unmanned-boat-video/runtime.env'),unit=f.read('etc/systemd/system/unmanned-boat-video.service');
  assert.match(unit,/DynamicUser=yes/);assert.match(unit,/LoadCredential=mediamtx\.yml:/);assert.match(unit,/ExecStart=.* %d\/mediamtx\.yml/);assert.match(unit,/ProtectSystem=strict/);
  assert.match(unit,/^StateDirectory=unmanned-boat-video$/m);assert.match(unit,/^StateDirectoryMode=0700$/m);
  assert.match(unit,/^RestrictAddressFamilies=.*\bAF_NETLINK\b/m);
  assert.doesNotMatch(unit,/ReadWritePaths=\/(?:var|etc)\s*$/m);
  assert.doesNotMatch(result.stdout+result.stderr,new RegExp(env.match(/BOAT_VIDEO_MEDIA_AUTH_TOKEN=(.*)/)[1]));
  f.write('etc/systemd/system/unmanned-boat-video.service',unit.replace('MemoryMax=256M','MemoryMax=384M').replace('RestartSec=3','RestartSec=7\nEnvironment=VIDEO_BUFFER=custom'));
  result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(f.read('etc/unmanned-boat-video/runtime.env'),env);
  const retainedUnit=f.read('etc/systemd/system/unmanned-boat-video.service');assert.match(retainedUnit,/^MemoryMax=384M$/m);assert.match(retainedUnit,/^RestartSec=7$/m);assert.match(retainedUnit,/^Environment=VIDEO_BUFFER=custom$/m);assert.match(retainedUnit,/^StateDirectory=unmanned-boat-video$/m);
  fs.writeFileSync(f.log,'');result=f.run('remove-video-media.sh',['--check-only']);assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(f.read('calls.log'),'');
  f.write('var/lib/unmanned-boat-video/recordings/boat-01/existing.mp4','retained video fixture');
  result=f.run('remove-video-media.sh',[]);assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(f.read('etc/unmanned-boat-video/runtime.env'),env);
  assert.equal(f.read('var/lib/unmanned-boat-video/recordings/boat-01/existing.mp4'),'retained video fixture');
  assert.equal(fs.existsSync(path.join(f.directory,'etc/systemd/system/unmanned-boat-web.service.d/45-video-media.conf')),false);
  assert.equal(fs.existsSync(path.join(f.directory,'usr/local/lib/unmanned-boat-video/mediamtx')),true);
  assert.equal(fs.existsSync(path.join(f.directory,'state/unmanned-boat-video.service.active')),false);
  assert.match(f.read('calls.log'),/disable --now unmanned-boat-video\.service/);assert.doesNotMatch(f.read('calls.log'),/mosquitto|unmanned-boat-mqtt\.service/);
});

test('首次安装发现本地录像端口被占用时拒绝，不停止其他服务或覆盖安装文件',{skip:!bash},t=>{
  for(const port of ['9996','9997']){
    const f=fixture(t),result=f.run(undefined,undefined,{MOCK_TCP_USED:port});
    assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp('local TCP port '+port+' is already used'));
    assert.equal(fs.existsSync(path.join(f.directory,'etc/unmanned-boat-video/runtime.env')),false);
    assert.doesNotMatch(f.read('calls.log'),/stop |restart |disable /);
  }
});
test('首次启动失败恢复启用状态并清理空目录，之后可以重新安装',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run(undefined,undefined,{MOCK_VIDEO_FAIL:'1'});assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.equal(fs.existsSync(path.join(f.directory,'etc/unmanned-boat-video')),false);assert.equal(fs.existsSync(path.join(f.directory,'usr/local/lib/unmanned-boat-video')),false);
  assert.equal(fs.existsSync(path.join(f.directory,'state/unmanned-boat-video.service.enabled')),false);
  result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);
});
test('升级启动失败恢复原凭据和active状态，陌生unit在所有权预检阶段拒绝',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);const env=f.read('etc/unmanned-boat-video/runtime.env');
  result=f.run(undefined,['new-host.example.com'],{MOCK_VIDEO_FAIL:'1'});assert.notEqual(result.status,0);assert.equal(f.read('etc/unmanned-boat-video/runtime.env'),env);
  assert.equal(fs.existsSync(path.join(f.directory,'state/unmanned-boat-video.service.active')),true);
  f.write('etc/systemd/system/unmanned-boat-video.service','# Foreign service\n');fs.writeFileSync(f.log,'');
  result=f.run('remove-video-media.sh',['--check-only']);assert.notEqual(result.status,0);assert.match(result.stderr,/unrelated service/);assert.equal(f.read('calls.log'),'');
});
test('完整平台卸载先完成视频预检，再关闭网关，之后停网页且保留视频恢复文件',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);
  const unit=f.read('etc/systemd/system/unmanned-boat-video.service');
  f.write('etc/systemd/system/unmanned-boat-video.service','# Foreign media service\n');fs.writeFileSync(f.log,'');
  result=f.run('remove.sh',[]);assert.notEqual(result.status,0);assert.match(result.stderr,/unrelated service/);assert.equal(f.read('calls.log'),'');
  f.write('etc/systemd/system/unmanned-boat-video.service',unit);result=f.run('remove.sh',[]);assert.equal(result.status,0,result.stdout+result.stderr);
  const calls=f.read('calls.log');assert.ok(calls.indexOf('disable --now unmanned-boat-video.service')<calls.indexOf('disable --now unmanned-boat-web.service'));
  assert.equal(fs.existsSync(path.join(f.directory,'state/unmanned-boat-video.service.active')),false);
  assert.equal(fs.existsSync(path.join(f.directory,'state/unmanned-boat-video.service.enabled')),false);
  assert.equal(fs.existsSync(path.join(f.directory,'etc/unmanned-boat-video/runtime.env')),true);
  assert.equal(fs.existsSync(path.join(f.directory,'usr/local/lib/unmanned-boat-video/mediamtx')),true);
  assert.equal(fs.existsSync(path.join(f.directory,'etc/systemd/system/unmanned-boat-video.service')),true);
  const backup=fs.readdirSync(path.join(f.directory,'opt')).find(name=>name.startsWith('unmanned-boat-web.removed-'));
  assert.ok(backup);assert.ok(fs.existsSync(path.join(f.directory,'opt',backup,'45-video-media.conf')));
});
