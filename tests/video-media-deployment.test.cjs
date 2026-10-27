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
function generate(directory,previous='missing.env',host='boat.example.com',port='7890',suffix=''){
  const runtime=path.join(directory,'runtime'+suffix+'.env'),configuration=path.join(directory,'mediamtx'+suffix+'.yml');
  const result=spawnSync(process.execPath,['-',path.join(directory,previous),runtime,configuration,host,port],{input:generator,encoding:'utf8'});
  return {...result,runtime,configuration};
}
test('媒体配置只启用SRT和本地WebRTC信令，随机密钥不输出且重复生成保留凭据',t=>{
  const directory=temporary(t),first=generate(directory);assert.equal(first.status,0,first.stderr);assert.equal(first.stdout,'');
  const env=fs.readFileSync(first.runtime,'utf8'),config=fs.readFileSync(first.configuration,'utf8');
  const values=Object.fromEntries(env.trim().split('\n').map(line=>line.split('=')));
  assert.match(values.BOAT_VIDEO_MEDIA_AUTH_TOKEN,/^[a-f0-9]{64}$/);assert.match(values.BOAT_VIDEO_MEDIA_READER_PASSWORD,/^[a-f0-9]{64}$/);
  assert.notEqual(values.BOAT_VIDEO_MEDIA_AUTH_TOKEN,values.BOAT_VIDEO_MEDIA_READER_PASSWORD);
  assert.match(config,/authMethod: http/);assert.ok(config.includes('/api/video/media/auth?token='+values.BOAT_VIDEO_MEDIA_AUTH_TOKEN));
  assert.match(config,/webrtcAddress: 127\.0\.0\.1:8889/);assert.match(config,/webrtcLocalUDPAddress: :8189/);assert.match(config,/srtAddress: :8890/);
  for(const protocol of ['api','metrics','pprof','playback','rtsp','rtmp','hls','moq'])assert.match(config,new RegExp('^'+protocol+': false$','m'));
  assert.match(config,/webrtcIPsFromInterfaces: false/);assert.match(config,/overridePublisher: false/);assert.match(config,/record: false/);
  assert.match(config,/webrtcAdditionalHosts: \["boat\.example\.com"\]/);
  const second=generate(directory,'runtime.env','47.251.109.111','7891','-new');assert.equal(second.status,0,second.stderr);
  const next=fs.readFileSync(second.runtime,'utf8');assert.ok(next.includes(values.BOAT_VIDEO_MEDIA_AUTH_TOKEN));assert.ok(next.includes(values.BOAT_VIDEO_MEDIA_READER_PASSWORD));
  assert.match(next,/BOAT_VIDEO_MEDIA_PUBLIC_HOST=47\.251\.109\.111/);assert.match(fs.readFileSync(second.configuration,'utf8'),/127\.0\.0\.1:7891\/api/);
});
test('无效旧密钥、重复env项及可注入的地址/端口在写入文件前拒绝',t=>{
  const directory=temporary(t);
  for(const [index,content] of ['BOAT_VIDEO_MEDIA_AUTH_TOKEN=broken\n','BOAT_VIDEO_MEDIA_AUTH_TOKEN='+('a'.repeat(64))+'\nBOAT_VIDEO_MEDIA_AUTH_TOKEN='+('a'.repeat(64))+'\n'].entries()){
    fs.writeFileSync(path.join(directory,'bad.env'),content);const result=generate(directory,'bad.env','boat.example.com','7890','-'+index);
    assert.notEqual(result.status,0);assert.equal(fs.existsSync(result.runtime),false);assert.equal(fs.existsSync(result.configuration),false);
  }
  for(const [index,host,port] of [[0,'example.com\napi: true','7890'],[1,'https://boat.example.com','7890'],[2,'boat.example.com','8889'],[3,'boat.example.com','0']]){
    const result=generate(directory,'missing.env',host,port,'-invalid-'+index);assert.notEqual(result.status,0);assert.equal(fs.existsSync(result.runtime),false);
  }
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
  write('bin/ss','#!/usr/bin/env bash\nexit 0\n');
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
  assert.doesNotMatch(result.stdout+result.stderr,new RegExp(env.match(/BOAT_VIDEO_MEDIA_AUTH_TOKEN=(.*)/)[1]));
  result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(f.read('etc/unmanned-boat-video/runtime.env'),env);
  fs.writeFileSync(f.log,'');result=f.run('remove-video-media.sh',['--check-only']);assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(f.read('calls.log'),'');
  result=f.run('remove-video-media.sh',[]);assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(f.read('etc/unmanned-boat-video/runtime.env'),env);
  assert.equal(fs.existsSync(path.join(f.directory,'etc/systemd/system/unmanned-boat-web.service.d/45-video-media.conf')),false);
  assert.equal(fs.existsSync(path.join(f.directory,'usr/local/lib/unmanned-boat-video/mediamtx')),true);
  assert.equal(fs.existsSync(path.join(f.directory,'state/unmanned-boat-video.service.active')),false);
  assert.match(f.read('calls.log'),/disable --now unmanned-boat-video\.service/);assert.doesNotMatch(f.read('calls.log'),/mosquitto|unmanned-boat-mqtt\.service/);
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
