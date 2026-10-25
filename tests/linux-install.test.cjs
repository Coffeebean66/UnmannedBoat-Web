'use strict';
// Execute the first-install Bash flow only against an isolated temporary root.
// apt/network/systemd/Nginx/Certbot are fakes; account generation uses real Node.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const project=path.resolve(__dirname,'..');
const candidates=process.platform==='win32'?[process.env.BOAT_TEST_BASH,'D:/Software/Git/bin/bash.exe','C:/Program Files/Git/bin/bash.exe'].filter(Boolean):['bash'];
const bash=candidates.find(name=>spawnSync(name,['--version'],{encoding:'utf8'}).status===0);
const unix=value=>value.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(match,drive)=>'/'+drive.toLowerCase());
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-first-install-')),root=unix(directory);
  const write=(name,text)=>{const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);fs.chmodSync(file,0o755);return file;};
  for(const name of ['run/systemd/system','tmp','opt','bin'])fs.mkdirSync(path.join(directory,name),{recursive:true});
  write('etc/os-release','ID=ubuntu\nVERSION_ID=24.04\n');
  const production=fs.readFileSync(path.join(project,'install-linux.sh'),'utf8');
  const isolated=production.replace('[[ "$EUID" -eq 0 ]]','[[ 1 -eq 1 ]]').replace(/\/(?:etc|opt|run|var|usr)\b/g,match=>root+match).replaceAll('/tmp/unmanned-boat-install.',root+'/tmp/unmanned-boat-install.');
  // Git Bash can prepend /mingw64/bin while starting. Set PATH inside the script,
  // after that startup, so real git/curl can never bypass the isolated adapters.
  write('install-linux.sh',isolated.replace('set -euo pipefail','set -euo pipefail\nexport PATH="$BOAT_FIXTURE_BIN:/usr/bin:/bin:/mingw64/bin"'));
  const realNode=quote(unix(process.execPath));
  write('usr/bin/node',`#!/usr/bin/env bash\nprintf 'system-node %s\\n' "$*" >> "$MOCK_LOG"\nif [[ "\${1:-}" == -p ]]; then [[ "\${MOCK_OLD_NODE:-0}" == 1 ]] && echo false || echo true; exit 0; fi\nexec ${realNode} "$@"\n`);
  write('usr/bin/npm','#!/usr/bin/env bash\necho 10.0.0\n');
  write('bin/readlink',`#!/usr/bin/env bash\nif [[ "\${MOCK_PRIVATE_NODE:-0}" == 1 && "\${@: -1}" == "$MOCK_ROOT/usr/bin/node" ]]; then printf '%s\\n' "$MOCK_ROOT/home/private/node"; else exec /usr/bin/readlink "$@"; fi\n`);
  write('bin/uname','#!/usr/bin/env bash\n[[ "$*" == -m ]] || exit 91\necho x86_64\n');
  write('bin/apt-get','#!/usr/bin/env bash\nprintf "apt %s\\n" "$*" >> "$MOCK_LOG"\n');
  write('bin/ss','#!/usr/bin/env bash\nif [[ "${MOCK_PORT_BUSY:-0}" == 1 && "$*" == *7890* ]]; then echo "LISTEN 0 128 127.0.0.1:7890"; fi\nexit 0\n');
  write('bin/systemctl','#!/usr/bin/env bash\nprintf "systemctl %s\\n" "$*" >> "$MOCK_LOG"\nif [[ "$1" == is-active || "$1" == is-enabled ]]; then [[ "$*" != *mosquitto.service* ]]; else exit 0; fi\n');
  write('bin/nginx','#!/usr/bin/env bash\nprintf "nginx %s\\n" "$*" >> "$MOCK_LOG"\nif [[ "$1" == -T ]]; then echo "server_name ${MOCK_EXISTING_DOMAIN:-unrelated.example.org};"; fi\nexit 0\n');
  write('bin/certbot','#!/usr/bin/env bash\nprintf "certbot %s\\n" "$*" >> "$MOCK_LOG"\nexit "${MOCK_CERTBOT_FAIL:-0}"\n');
  write('bin/curl',`#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$MOCK_LOG"
url='' destination=''
while [[ $# -gt 0 ]]; do
  case "$1" in https://*) url="$1";; -o) shift; destination="$1";; esac
  shift
done
case "$url" in
  https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt) cp "$MOCK_ROOT/download/SHASUMS256.txt" "$destination";;
  https://nodejs.org/dist/latest-v22.x/node-v22.0.0-linux-x64.tar.xz) cp "$MOCK_ROOT/download/node-v22.0.0-linux-x64.tar.xz" "$destination";;
  https://boat.example.com/healthz) [[ -z "$destination" ]] || exit 90; printf '{"ok":true}\\n';;
  *) echo "Unexpected download blocked: $url" >&2; exit 90;;
esac
`);
  write('bin/tar','#!/usr/bin/env bash\nprintf "tar %s\\n" "$*" >> "$MOCK_LOG"\n[[ "$1" == -xJf && "$*" == *--strip-components=1* && "$*" == *--no-same-owner* ]] || exit 91\nexec /usr/bin/tar "$@"\n');
  write('templates/package.json','{"name":"fixture","version":"1.14.0"}\n');
  write('templates/deploy-cloud.sh',`#!/usr/bin/env bash\nprintf 'deploy-cloud %s\\n' "$*" >> "$MOCK_LOG"\nmkdir -p ${quote(root+'/etc/unmanned-boat-web')} ${quote(root+'/opt/unmanned-boat-web')}\nprintf 'unmanned-boat-cloud-v1\\n' > ${quote(root+'/etc/unmanned-boat-web/.boat-cloud-deployment')}\n`);
  write('templates/maintenance/install-update.sh','#!/usr/bin/env bash\nprintf "install-update %s\\n" "$*" >> "$MOCK_LOG"\n');
  write('templates/maintenance/install-mqtt-device-admin.sh','#!/usr/bin/env bash\nprintf "install-mqtt-device-admin %s\\n" "$*" >> "$MOCK_LOG"\n');
  write('bin/git',`#!/usr/bin/env bash
if [[ "$1" == clone && "$*" == *'--depth 1 --branch main https://github.com/Coffeebean66/UnmannedBoat-Web.git '* && "\${@: -1}" == "$MOCK_ROOT/tmp/unmanned-boat-install."*/source ]]; then
  cp -R ${quote(root+'/templates')} "\${@: -1}"; printf 'git clone\\n' >> "$MOCK_LOG"
elif [[ "$1" == -C && "$2" == "$MOCK_ROOT/tmp/unmanned-boat-install."*/source && "\${3:-}" == rev-parse && "\${4:-}" == HEAD && $# == 4 ]]; then
  printf '%040d\\n' 1
else echo 'Unexpected git command blocked' >&2; exit 91; fi
`);
  const log=path.join(directory,'calls.log');
  const run=(args=['boat.example.com','admin@example.com'],env={})=>{
    const result=spawnSync(bash,[unix(path.join(directory,'install-linux.sh')),...args],{encoding:'utf8',env:{...process.env,BOAT_FIXTURE_BIN:root+'/usr/bin:'+root+'/bin',MOCK_ROOT:root,MOCK_LOG:unix(log),...env},timeout:60000});
    assert.equal(result.error,undefined,'Isolated installer must finish: '+result.error+'\n'+result.stderr);return result;
  };
  const nodeArchive=({badChecksum=false}={})=>{
    const name='node-v22.0.0-linux-x64',archive=path.join(directory,'download',name+'.tar.xz');
    write('archive/'+name+'/bin/node',`#!/usr/bin/env bash\nprintf 'downloaded-node %s\\n' "$*" >> "$MOCK_LOG"\nif [[ "\${1:-}" == -p ]]; then echo true; exit 0; fi\nexec ${realNode} "$@"\n`);
    write('archive/'+name+'/bin/npm','#!/usr/bin/env bash\necho 10.0.0\n');
    fs.mkdirSync(path.dirname(archive),{recursive:true});
    const pack=spawnSync(bash,['-c',`/usr/bin/tar -cJf ${quote(unix(archive))} -C ${quote(root+'/archive')} ${quote(name)}`],{encoding:'utf8',timeout:20000});
    assert.equal(pack.status,0,'Create isolated Node archive: '+pack.stderr);
    const digest=badChecksum?'0'.repeat(64):crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    write('download/SHASUMS256.txt',digest+'  '+name+'.tar.xz\n');
  };
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return {directory,write,run,log,nodeArchive,read:name=>fs.readFileSync(path.join(directory,name),'utf8')};
}
test('first installer Bash syntax is valid',{skip:!bash},()=>{
  const result=spawnSync(bash,['-n',unix(path.join(project,'install-linux.sh'))],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('invalid domain, email and conflicting service ports are rejected before installation',{skip:!bash},t=>{
  const f=fixture(t);
  for(const args of [['https://boat.example.com','admin@example.com'],['boat.example.com','a@bad..com'],['boat.example.com','admin@example.com','1883'],['boat.example.com','admin@example.com','65536']]){
    const result=f.run(args);assert.notEqual(result.status,0,result.stdout+result.stderr);assert.equal(fs.existsSync(f.log),false);
  }
});
test('an existing installation is refused before apt, network or service mutations',{skip:!bash},t=>{
  const f=fixture(t);f.write('etc/unmanned-boat-web/keep.txt','existing-secret');
  const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/First installation only/);assert.equal(fs.existsSync(f.log),false);assert.equal(f.read('etc/unmanned-boat-web/keep.txt'),'existing-secret');
});
test('a busy internal web port and a matching Nginx domain never replace an existing site',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run(undefined,{MOCK_PORT_BUSY:'1'});assert.notEqual(result.status,0);assert.equal(fs.existsSync(f.log),false);
  result=f.run(undefined,{MOCK_EXISTING_DOMAIN:'boat.example.com'});assert.notEqual(result.status,0);assert.match(result.stderr,/already configured in Nginx/);assert.doesNotMatch(f.read('calls.log'),/deploy-cloud|systemctl (reload|stop)/);assert.equal(fs.existsSync(path.join(f.directory,'etc/nginx/conf.d/unmanned-boat-web.conf')),false);
});
test('fresh installation creates accounts and HTTPS/SSE settings and enables updates without exposing passwords',{skip:!bash},t=>{
  const f=fixture(t),result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/Installation complete: https:\/\/boat.example.com/);
  const env=f.read('etc/unmanned-boat-web/accounts.env'),credentials=f.read('etc/unmanned-boat-web/accounts-access.txt');assert.match(env,/BOAT_ADMIN_USERNAME=admin/);assert.match(env,/BOAT_GUEST_USERNAME=guest/);assert.match(env,/BOAT_ACCOUNTS_ORIGIN=https:\/\/boat.example.com/);
  const passwords=[...env.matchAll(/PASSWORD=(.+)/g)].map(match=>match[1]);assert.equal(passwords.length,2);assert.notEqual(passwords[0],passwords[1]);for(const password of passwords){assert.ok(credentials.includes(password));assert.ok(!(result.stdout+result.stderr).includes(password));}
  const nginx=f.read('etc/nginx/conf.d/unmanned-boat-web.conf');assert.match(nginx,/listen 443 ssl/);assert.match(nginx,/proxy_pass http:\/\/127\.0\.0\.1:7890/);assert.match(nginx,/proxy_buffering off/);assert.match(nginx,/proxy_read_timeout 3600s/);assert.ok(fs.existsSync(path.join(f.directory,'etc/letsencrypt/renewal-hooks/deploy/unmanned-boat-web-reload.sh')));
  const calls=f.read('calls.log');assert.match(calls,/deploy-cloud 7890 127\.0\.0\.1 https:\/\/boat.example.com/);assert.match(calls,/install-update https:\/\/boat.example.com 7890/);assert.doesNotMatch(calls,/systemctl stop|apt .*mosquitto/);
  assert.match(calls,/install-mqtt-device-admin/);assert.ok(calls.indexOf('install-update')<calls.indexOf('install-mqtt-device-admin'),'MQTT management follows updater bootstrap');
  assert.match(calls,/apt install .*\bprocps\b/);assert.match(calls,/apt install .*\blibstdc\+\+6\b/);assert.match(calls,/git clone/);assert.doesNotMatch(calls,/nodejs\.org|^tar /m);
  assert.equal(fs.readdirSync(path.join(f.directory,'tmp')).length,0,'temporary checkout is removed');
});

test('an old system Node downloads and verifies the official-layout archive before installing it',{skip:!bash},t=>{
  const f=fixture(t);f.nodeArchive();const result=f.run(undefined,{MOCK_OLD_NODE:'1'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const calls=f.read('calls.log');assert.match(calls,/curl .*https:\/\/nodejs\.org\/dist\/latest-v22\.x\/SHASUMS256\.txt/);assert.match(calls,/curl .*node-v22\.0\.0-linux-x64\.tar\.xz/);
  assert.match(result.stdout,/node-v22\.0\.0-linux-x64\.tar\.xz: OK/);assert.match(calls,/^tar -xJf .*--strip-components=1 -C .*\/opt\/unmanned-boat-node22 --no-same-owner$/m);
  assert.match(calls,/^downloaded-node --version$/m);assert.match(calls,/install-update/);assert.ok(fs.existsSync(path.join(f.directory,'opt/unmanned-boat-node22/bin/node')));
});

test('a checksum mismatch stops before archive extraction or application changes',{skip:!bash},t=>{
  const f=fixture(t);f.nodeArchive({badChecksum:true});const result=f.run(undefined,{MOCK_OLD_NODE:'1'});
  assert.notEqual(result.status,0,result.stdout+result.stderr);assert.match(result.stderr,/phase: node-runtime/);assert.match(result.stdout+result.stderr,/FAILED|did NOT match/);
  assert.doesNotMatch(f.read('calls.log'),/^tar |git clone|deploy-cloud|install-update/m);
  assert.equal(fs.existsSync(path.join(f.directory,'opt/unmanned-boat-node22')),false);assert.equal(fs.existsSync(path.join(f.directory,'etc/unmanned-boat-web')),false);
  assert.equal(fs.readdirSync(path.join(f.directory,'tmp')).length,0);
});

test('a system Node resolving into a private home is rejected before execution and replaced',{skip:!bash},t=>{
  const f=fixture(t);f.nodeArchive();const result=f.run(undefined,{MOCK_PRIVATE_NODE:'1'});
  assert.equal(result.status,0,result.stdout+result.stderr);const calls=f.read('calls.log');
  assert.doesNotMatch(calls,/^system-node /m);assert.match(calls,/nodejs\.org/);assert.match(calls,/^downloaded-node /m);assert.match(calls,/install-update/);
});
test('certificate failure remains incomplete, preserves generated credentials and never exposes the application over HTTP',{skip:!bash},t=>{
  const f=fixture(t),result=f.run(undefined,{MOCK_CERTBOT_FAIL:'1'});assert.notEqual(result.status,0);assert.match(result.stderr,/Installation NOT complete \(phase: certificate/);assert.ok(fs.existsSync(path.join(f.directory,'etc/unmanned-boat-web/accounts-access.txt')));
  const nginx=f.read('etc/nginx/conf.d/unmanned-boat-web.conf');assert.match(nginx,/location \/ \{ return 404; \}/);assert.doesNotMatch(nginx,/proxy_pass/);assert.doesNotMatch(f.read('calls.log'),/install-update|systemctl stop/);assert.equal(fs.readdirSync(path.join(f.directory,'tmp')).length,0);
});
