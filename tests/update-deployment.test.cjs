'use strict';
// Exercise the real bootstrap/removal transactions in an isolated fake Linux root.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const project=path.resolve(__dirname,'..');
const candidates=process.platform==='win32'?[process.env.BOAT_TEST_BASH,'D:/Software/Git/bin/bash.exe','C:/Program Files/Git/bin/bash.exe'].filter(Boolean):['bash'];
const bash=candidates.find(value=>spawnSync(value,['--version'],{encoding:'utf8'}).status===0);
const unix=value=>value.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'boat-update-deployment-')),root=unix(base),source=path.join(base,'source'),bin=path.join(base,'bin');
  const write=(name,content)=>{const file=path.join(base,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);fs.chmodSync(file,0o755);return file;};
  fs.mkdirSync(source);fs.mkdirSync(bin);fs.mkdirSync(path.join(base,'opt'));fs.mkdirSync(path.join(base,'etc/systemd/system'),{recursive:true});
  const rewrite=text=>text.replace('set -euo pipefail','set -euo pipefail\nexport PATH="$BOAT_FIXTURE_BIN:$PATH"\nstat(){ if [[ "$2" == %u ]]; then echo 0; else echo 755; fi; }').replace('[[ "$EUID" -eq 0 ]]','[[ 1 -eq 1 ]]').replace(/\/usr\/local\/lib\b/g,root+'/usr/local/lib').replace(/\/var\/lib\b/g,root+'/var/lib').replace(/\/opt\b/g,root+'/opt').replace(/\/etc\b/g,root+'/etc')
    .replace(/-o root -g (?:boat-web-update|root) /g,'').replace(/-o boat-web-build -g boat-web-build /g,'').replace('-m 2770','-m 755').replace(/-m 700/g,'-m 755')
    .replace('current="$(dirname -- "$current")"','current="${current%/*}"; [[ -n "$current" ]] || current=/');
  write('source/maintenance/install-update.sh',rewrite(fs.readFileSync(path.join(project,'maintenance/install-update.sh'),'utf8')));
  for(const name of ['update-worker.cjs','validate-release.cjs'])write('source/maintenance/'+name,fs.readFileSync(path.join(project,'maintenance',name),'utf8'));
  write('source/remove.sh',rewrite(fs.readFileSync(path.join(project,'remove.sh'),'utf8')));
  // A simple-path Node wrapper preserves real config/credential generation but fakes HTTP readiness.
  write('bin/node',`#!/usr/bin/env bash\nif [[ "\${1:-}" == - && "\${2:-}" == 7890 && $# == 2 ]]; then cat >/dev/null; exit "\${MOCK_HEALTH:-0}"; fi\nexec '${unix(process.execPath)}' "$@"\n`);
  for(const command of ['npm','git','runuser','groupadd','useradd','getent','pkill','pgrep','chown'])write('bin/'+command,'#!/usr/bin/env bash\nexit 0\n');
  write('bin/id','#!/usr/bin/env bash\nif [[ "$1" == -Gn ]]; then echo boat-web-build; else echo 987; fi\n');
  write('bin/stat','#!/usr/bin/env bash\nif [[ "$*" == *%u* ]]; then echo 0; else echo 755; fi\n');
  write('bin/sleep','#!/usr/bin/env bash\nexit 0\n');
  write('bin/systemctl','#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MOCK_LOG"\nexit 0\n');
  write('opt/unmanned-boat-web/.boat-web-deployment','unmanned-boat-web-v1\n');write('opt/unmanned-boat-web/server/update-api.js','// supported');write('opt/unmanned-boat-web/server.js','// managed app');
  write('etc/systemd/system/unmanned-boat-web.service','# Owned by unmanned-boat-web-v1\n');
  write('etc/unmanned-boat-web/.boat-cloud-deployment','unmanned-boat-cloud-v1\n');write('etc/unmanned-boat-web/runtime.env','BOAT_CLOUD_PASSWORD=preserve-cloud-secret\n');
  const log=path.join(base,'systemctl.log');
  t.after(()=>{assert.match(path.basename(base),/^boat-update-deployment-/);fs.rmSync(base,{recursive:true,force:true});});
  const run=(script='maintenance/install-update.sh',args=['https://boat.test','7890'],extra={})=>spawnSync(bash,[...(process.env.BOAT_TEST_TRACE?['-x']:[]),unix(path.join(source,script)),...args],{encoding:'utf8',env:{...process.env,PATH:unix(bin)+':'+process.env.PATH,BOAT_FIXTURE_BIN:unix(bin),MOCK_LOG:unix(log),...extra},timeout:30000});
  return {base,write,run,log,config:path.join(base,'etc/unmanned-boat-web'),state:path.join(base,'var/lib/unmanned-boat-web-update'),helper:path.join(base,'usr/local/lib/unmanned-boat-web-update')};
}
test('bootstrap installs a separate trusted helper and keeps all existing cloud credentials',{skip:!bash},t=>{
  const f=fixture(t),first=f.run();assert.equal(first.status,0,first.stdout+first.stderr);
  const config=JSON.parse(fs.readFileSync(path.join(f.state,'config.json'),'utf8'));
  assert.deepEqual(config,{apiVersion:1,repository:'https://github.com/Coffeebean66/UnmannedBoat-Web',branch:'main'});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.state,'state/status.json'),'utf8')),{status:'idle'});
  const runtime=fs.readFileSync(path.join(f.config,'runtime.env'),'utf8'),env=fs.readFileSync(path.join(f.config,'update.env'),'utf8'),access=fs.readFileSync(path.join(f.config,'update-access.txt'),'utf8');
  assert.equal(runtime,'BOAT_CLOUD_PASSWORD=preserve-cloud-secret\n');assert.match(env,/^BOAT_UPDATE_ENABLED=1$/m);
  const password=env.match(/^BOAT_UPDATE_PASSWORD=(.+)$/m)[1];assert.ok(password.length>=16);assert.match(access,/Update administrator password:/);assert.equal(first.stdout.includes(password),false);
  assert.ok(fs.existsSync(path.join(f.helper,'update-worker.cjs')));assert.equal(fs.existsSync(path.join(f.state,'requests')),true);
  const dropin=fs.readFileSync(path.join(f.base,'etc/systemd/system/unmanned-boat-web.service.d/30-update.conf'),'utf8');
  assert.match(dropin,/SupplementaryGroups=boat-web-update/);assert.match(dropin,/ReadWritePaths=.*\/requests/);assert.doesNotMatch(dropin,/runtime\.env|ExecStart=/);
  const second=f.run();assert.equal(second.status,0,second.stdout+second.stderr);assert.equal(fs.readFileSync(path.join(f.config,'update.env'),'utf8'),env);assert.equal(fs.readFileSync(path.join(f.config,'update-access.txt'),'utf8'),access);
  const unit=fs.readFileSync(path.join(f.base,'etc/systemd/system/unmanned-boat-web-update.service'),'utf8');assert.match(unit,/Type=oneshot/);assert.match(unit,/KillMode=control-group/);assert.doesNotMatch(unit,/EnvironmentFile=.*runtime/);
});
test('bootstrap refuses an unmanaged helper and never stops the web service',{skip:!bash},t=>{
  const f=fixture(t);f.write('usr/local/lib/unmanned-boat-web-update/foreign.txt','not ours');const result=f.run();assert.notEqual(result.status,0);assert.match(result.stdout,/Unmanaged updater directory/);assert.equal(fs.existsSync(f.log),false);
});
test('bootstrap preserves password and refuses an implicit origin change',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);const saved=fs.readFileSync(path.join(f.config,'update.env'),'utf8');
  result=f.run('maintenance/install-update.sh',['https://different.test','7890']);assert.notEqual(result.status,0);assert.match(result.stderr,/origin differs/);assert.equal(fs.readFileSync(path.join(f.config,'update.env'),'utf8'),saved);
});
test('removal disables the queue first and retains helper, status and admin secrets for recovery',{skip:!bash},t=>{
  const f=fixture(t);let result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);fs.writeFileSync(f.log,'');
  result=f.run('remove.sh',[]);assert.equal(result.status,0,result.stdout+result.stderr);
  const backup=fs.readdirSync(path.join(f.base,'opt')).find(name=>name.startsWith('unmanned-boat-web.removed-'));assert.ok(backup);const directory=path.join(f.base,'opt',backup);
  assert.ok(fs.existsSync(path.join(directory,'update-helper/update-worker.cjs')));assert.ok(fs.existsSync(path.join(directory,'update-state/state/status.json')));assert.ok(fs.existsSync(path.join(directory,'update-credentials/update-access.txt')));assert.ok(fs.existsSync(path.join(directory,'cloud-config/runtime.env')));
  assert.equal(fs.existsSync(f.helper),false);assert.equal(fs.existsSync(f.state),false);
  const calls=fs.readFileSync(f.log,'utf8');assert.ok(calls.indexOf('disable --now unmanned-boat-web-update.path')<calls.indexOf('stop unmanned-boat-web-update.service'));assert.ok(calls.indexOf('stop unmanned-boat-web-update.service')<calls.indexOf('disable --now unmanned-boat-web.service'));
  assert.doesNotMatch(calls,/nginx|mosquitto\.service|docker/);
});
test('installer explicitly publishes readable state and setgid-only writable requests',()=>{
  const script=fs.readFileSync(path.join(project,'maintenance/install-update.sh'),'utf8');
  assert.match(script,/-g boat-web-update -m 2770/);assert.match(script,/chmod 644 "\$state\/config\.json" "\$state\/state\/status\.json"/);assert.match(script,/chmod 600 "\$config\/update\.env" "\$config\/update-access\.txt"/);
});
