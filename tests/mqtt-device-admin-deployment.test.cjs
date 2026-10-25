'use strict';
// 真实 Bash 安装/卸载事务只运行在隔离目录，systemd 与系统账户工具均为适配器。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const project=path.resolve(__dirname,'..');
const candidates=process.platform==='win32'?[process.env.BOAT_TEST_BASH,'D:/Software/Git/bin/bash.exe','C:/Program Files/Git/bin/bash.exe'].filter(Boolean):['bash'];
const bash=candidates.find(name=>spawnSync(name,['--version'],{encoding:'utf8'}).status===0);
const unix=value=>value.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-mqtt-admin-deploy-')),root=unix(directory),source=path.join(directory,'source');
  const write=(name,value)=>{const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);fs.chmodSync(file,0o755);return file;};
  const rewrite=text=>text.replace('[[ "$EUID" -eq 0 ]]','[[ 1 -eq 1 ]]')
    .replace(/\/(?:etc|opt|run)\b/g,match=>root+match).replace(/\/usr\/local\/lib\b/g,root+'/usr/local/lib').replace(/\/var\/lib\b/g,root+'/var/lib')
    .replace('set -euo pipefail','set -euo pipefail\nexport PATH="$BOAT_FIXTURE_BIN:$PATH"\nstat(){ if [[ "$2" == %u ]]; then echo 0; elif [[ -n "${MOCK_WRITABLE_PATH:-}" && "$3" == "$MOCK_WRITABLE_PATH" ]]; then echo 777; else echo 755; fi; }')
    .replace(/-o root -g root /g,'').replace('current="$(dirname -- "$current")"','current="${current%/*}"; [[ -n "$current" ]] || current=/');
  write('source/maintenance/install-mqtt-device-admin.sh',rewrite(fs.readFileSync(path.join(project,'maintenance/install-mqtt-device-admin.sh'),'utf8')));
  write('source/maintenance/mqtt-device-worker.cjs','// Root helper source fixture.\n');
  write('source/remove.sh',rewrite(fs.readFileSync(path.join(project,'remove.sh'),'utf8')));
  write('bin/node',`#!/usr/bin/env bash\nif [[ "\${1:-}" == - && "\${2:-}" == */control.sock && $# == 2 ]]; then cat >/dev/null; exit "\${MOCK_HEALTH:-0}"; fi\nexec '${unix(process.execPath)}' "$@"\n`);
  for(const command of ['getent','groupadd','mosquitto_passwd'])write('bin/'+command,'#!/usr/bin/env bash\nprintf "'+command+' %s\\n" "$*" >> "$MOCK_LOG"\nexit 0\n');
  write('bin/systemctl',`#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "$MOCK_LOG"
# Preserve systemctl's real any-active semantics for a multiple-unit query.
if [[ "$1" == is-active && "\${MOCK_WEB_FAILED:-0}" == 1 ]]; then
  for argument in "$@"; do
    if [[ "$argument" == *.service || "$argument" == *.socket ]]; then
      [[ "$argument" == unmanned-boat-web.service ]] || exit 0
    fi
  done
  exit 1
fi
exit 0
`);
  write('bin/stat','#!/usr/bin/env bash\nif [[ "$*" == *%u* ]]; then echo 0; else echo 755; fi\n');
  write('opt/unmanned-boat-web/.boat-web-deployment','unmanned-boat-web-v1\n');
  write('opt/unmanned-boat-web/server/mqtt-device-api.js','// MQTT device API supported.\n');
  write('etc/systemd/system/unmanned-boat-web.service','# Owned by unmanned-boat-web-v1\n');
  write('etc/systemd/system/unmanned-boat-mqtt.service','# Owned by unmanned-boat-cloud-v1\n');
  write('etc/unmanned-boat-web/.boat-cloud-deployment','unmanned-boat-cloud-v1\n');
  write('etc/unmanned-boat-web/passwd','boat-01:$7$hashed-device\nbridge:$7$hashed-bridge\n');
  write('etc/unmanned-boat-web/acl','user boat-01\ntopic write boats/boat-01/telemetry\n');
  write('etc/unmanned-boat-web/runtime.env','BOAT_MQTT_USERNAME=bridge\nBOAT_MQTT_PASSWORD=keep-bridge-secret\n');
  write('etc/unmanned-boat-web/mosquitto.conf','password_file /etc/unmanned-boat-web/passwd\n');
  write('etc/unmanned-boat-web/access.txt','device-secret-and-bridge-secret-must-remain\n');
  const log=path.join(directory,'calls.log');
  const run=(script='maintenance/install-mqtt-device-admin.sh',args=[],extra={})=>spawnSync(bash,[...(process.env.BOAT_TEST_TRACE?['-x']:[]),unix(path.join(source,script)),...args],{encoding:'utf8',timeout:60000,env:{...process.env,BOAT_FIXTURE_BIN:root+'/bin',MOCK_LOG:unix(log),...extra}});
  const snapshot=()=>Object.fromEntries(['passwd','acl','runtime.env','mosquitto.conf','access.txt'].map(name=>[name,fs.readFileSync(path.join(directory,'etc/unmanned-boat-web',name),'utf8')]));
  t.after(()=>{assert.match(path.basename(directory),/^boat-mqtt-admin-deploy-/);fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,root,write,run,log,snapshot,read:name=>fs.readFileSync(path.join(directory,name),'utf8')};
}

test('MQTT administration installer and removal Bash syntax is valid',{skip:!bash},()=>{
  for(const name of ['maintenance/install-mqtt-device-admin.sh','install-linux.sh','remove.sh']){
    const result=spawnSync(bash,['-n',unix(path.join(project,name))],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
});

test('installation creates a local socket and an independent root helper without changing MQTT credentials',{skip:!bash},t=>{
  const f=fixture(t),before=f.snapshot(),result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(f.snapshot(),before);
  const service=f.read('etc/systemd/system/unmanned-boat-mqtt-admin.service'),socket=f.read('etc/systemd/system/unmanned-boat-mqtt-admin.socket'),dropin=f.read('etc/systemd/system/unmanned-boat-web.service.d/40-mqtt-device-admin.conf');
  assert.match(service,/User=root/);assert.match(service,/Requires=unmanned-boat-mqtt-admin\.socket/);assert.match(service,/Sockets=unmanned-boat-mqtt-admin\.socket/);assert.match(service,/ProtectSystem=strict/);assert.match(service,/ReadWritePaths=.*\/etc\/unmanned-boat-web\n/);assert.doesNotMatch(service,/ReadWritePaths=.*\/opt|EnvironmentFile|sudo/);
  assert.match(socket,/ListenStream=.*\/run\/unmanned-boat-mqtt-admin\/control\.sock/);assert.match(socket,/SocketMode=0660/);assert.match(socket,/SocketUser=root/);assert.match(socket,/SocketGroup=boat-mqtt-admin/);assert.match(socket,/DirectoryMode=0755/);assert.doesNotMatch(socket,/ListenStream=\d|ListenDatagram/);
  assert.match(dropin,/SupplementaryGroups=boat-mqtt-admin/);assert.doesNotMatch(dropin,/ReadWritePaths|User=root|ExecStart/);
  assert.equal(f.read('usr/local/lib/unmanned-boat-mqtt-admin/mqtt-device-worker.cjs'),'// Root helper source fixture.\n');
  const config=JSON.parse(f.read('usr/local/lib/unmanned-boat-mqtt-admin/mqtt-device-worker-config.json'));assert.deepEqual(Object.keys(config).sort(),['mosquittoPasswd','systemctl']);
  const calls=f.read('calls.log');assert.match(calls,/systemctl enable --now unmanned-boat-mqtt-admin\.socket/);assert.match(calls,/systemctl restart unmanned-boat-web\.service/);assert.doesNotMatch(calls,/systemctl .*unmanned-boat-mqtt\.service|mosquitto_passwd /);
  assert.doesNotMatch(result.stdout+result.stderr,/keep-bridge-secret|device-secret-and-bridge-secret/);
});

test('reinstallation preserves credentials and safely reloads only its own helper and socket',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);const before=f.snapshot();fs.writeFileSync(f.log,'');
  result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(f.snapshot(),before);
  const calls=f.read('calls.log');assert.match(calls,/systemctl stop unmanned-boat-mqtt-admin\.socket unmanned-boat-mqtt-admin\.service/);assert.doesNotMatch(calls,/systemctl .*unmanned-boat-mqtt\.service/);
});

test('foreign helper, foreign unit and missing managed API are rejected before changing services or credentials',{skip:!bash},t=>{
  for(const kind of ['helper','unit','api']){
    const f=fixture(t),before=f.snapshot();
    if(kind==='helper')f.write('usr/local/lib/unmanned-boat-mqtt-admin/foreign.txt','not managed');
    else if(kind==='unit')f.write('etc/systemd/system/unmanned-boat-mqtt-admin.service','# Another application\n');
    else fs.unlinkSync(path.join(f.directory,'opt/unmanned-boat-web/server/mqtt-device-api.js'));
    const result=f.run();assert.notEqual(result.status,0,result.stdout+result.stderr);assert.deepEqual(f.snapshot(),before);assert.equal(fs.existsSync(f.log),false,'No group or systemd mutations after invalid ownership');
  }
});

test('group writable trusted paths are rejected before mutation',{skip:!bash},t=>{
  const f=fixture(t),before=f.snapshot(),result=f.run(undefined,[],{MOCK_WRITABLE_PATH:f.root+'/etc/unmanned-boat-web'});
  assert.notEqual(result.status,0);assert.match(result.stdout,/not group\/world-writable/);assert.deepEqual(f.snapshot(),before);assert.equal(fs.existsSync(f.log),false);
});

test('failed readiness keeps credentials unchanged and does not restart the website',{skip:!bash},t=>{
  const f=fixture(t),before=f.snapshot(),result=f.run(undefined,[],{MOCK_HEALTH:'1'});
  assert.notEqual(result.status,0);assert.deepEqual(f.snapshot(),before);assert.doesNotMatch(f.read('calls.log'),/systemctl restart unmanned-boat-web\.service/);
});

test('an active administration socket cannot hide a failed web service during installation',{skip:!bash},t=>{
  const f=fixture(t),before=f.snapshot(),result=f.run(undefined,[],{MOCK_WEB_FAILED:'1'});
  assert.notEqual(result.status,0,result.stdout+result.stderr);assert.deepEqual(f.snapshot(),before);
  assert.match(result.stderr,/Web service is not active/);assert.doesNotMatch(result.stdout,/MQTT device administration installed/);
  const calls=f.read('calls.log');assert.match(calls,/systemctl enable --now unmanned-boat-mqtt-admin\.socket/);assert.match(calls,/systemctl is-active --quiet unmanned-boat-web\.service\n/);
});

test('removal saves the helper and its units and disables the socket before stopping the worker',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);const before=f.snapshot();fs.writeFileSync(f.log,'');
  result=f.run('remove.sh');assert.equal(result.status,0,result.stdout+result.stderr);
  const backup=fs.readdirSync(path.join(f.directory,'opt')).find(name=>name.startsWith('unmanned-boat-web.removed-'));assert.ok(backup);
  const saved=path.join(f.directory,'opt',backup);assert.ok(fs.existsSync(path.join(saved,'mqtt-admin-helper/mqtt-device-worker.cjs')));assert.ok(fs.existsSync(path.join(saved,'unmanned-boat-mqtt-admin.socket')));assert.ok(fs.existsSync(path.join(saved,'40-mqtt-device-admin.conf')));
  for(const [name,value]of Object.entries(before))assert.equal(fs.readFileSync(path.join(saved,'cloud-config',name),'utf8'),value);
  const calls=f.read('calls.log');assert.ok(calls.indexOf('disable --now unmanned-boat-mqtt-admin.socket')<calls.indexOf('stop unmanned-boat-mqtt-admin.service'));assert.ok(calls.indexOf('stop unmanned-boat-mqtt-admin.service')<calls.indexOf('disable --now unmanned-boat-web.service'));assert.doesNotMatch(calls,/nginx|mosquitto\.service|docker/);
});

test('uninstall refuses an unrelated MQTT administration unit before stopping any service',{skip:!bash},t=>{
  const f=fixture(t);f.write('etc/systemd/system/unmanned-boat-mqtt-admin.socket','# Foreign socket\n');const before=f.snapshot(),result=f.run('remove.sh');
  assert.notEqual(result.status,0);assert.match(result.stdout,/Unmanaged MQTT administration service/);assert.deepEqual(f.snapshot(),before);assert.equal(fs.existsSync(f.log),false);
});
