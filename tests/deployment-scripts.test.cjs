'use strict';
// Execute the production Bash transactions against a rewritten, temporary root.
// systemd/npm/health are fakes; the actual machine's /opt and /etc are untouched.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const project=path.resolve(__dirname,'..');
const candidates=process.platform==='win32'?[process.env.BOAT_TEST_BASH,'D:/Software/Git/bin/bash.exe','C:/Program Files/Git/bin/bash.exe'].filter(Boolean):['bash'];
const bash=candidates.find(candidate=>spawnSync(candidate,['--version'],{encoding:'utf8'}).status===0);
function unix(value){return value.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(m,drive)=>'/'+drive.toLowerCase());}
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-deployment-'));
  const root=unix(directory),source=path.join(directory,'source'),bin=path.join(directory,'bin'),state=path.join(directory,'state');
  const write=(name,text)=>{const full=path.join(directory,name);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,text);fs.chmodSync(full,0o755);return full;};
  fs.mkdirSync(source);fs.mkdirSync(bin);fs.mkdirSync(state);
  fs.mkdirSync(path.join(directory,'opt'));fs.mkdirSync(path.join(directory,'etc/systemd/system'),{recursive:true});
  for(const name of ['deploy.sh','remove.sh','deploy-cloud.sh']){
    const production=fs.readFileSync(path.join(project,name),'utf8');
    write('source/'+name,production.replace('[[ "$EUID" -eq 0 ]]','[[ 1 -eq 1 ]]').replace(/\/opt\b/g,root+'/opt').replace(/\/etc\b/g,root+'/etc'));
  }
  write('source/package.json','{"name":"test-fixture","version":"1.0.0"}');
  write('source/server.js','// server fixture');write('source/server/helper.js','// runtime module');write('source/public/index.html','new-site');
  write('bin/node','#!/usr/bin/env bash\nif [[ "${1:-}" == -p ]]; then echo true; exit 0; fi\nif [[ "${1:-}" == - ]]; then cat >/dev/null; exit "${MOCK_HEALTH:-0}"; fi\nexit 0\n');
  write('bin/npm','#!/usr/bin/env bash\nexit "${MOCK_NPM_FAIL:-0}"\n');
  write('bin/sleep','#!/usr/bin/env bash\nexit 0\n');
  write('bin/ss','#!/usr/bin/env bash\nexit 0\n');
  write('bin/mosquitto','#!/usr/bin/env bash\necho "mosquitto version ${MOCK_MOSQUITTO_VERSION:-2.0.18}"\nexit 3\n');
  write('bin/mosquitto_passwd','#!/usr/bin/env bash\nexit 0\n');
  write('bin/getent','#!/usr/bin/env bash\nexit 1\n');
  write('bin/systemctl',`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
service="\${@: -1}"
case "$1" in
  is-active) [[ -f "$MOCK_STATE/$service.active" ]];;
  is-enabled) [[ -f "$MOCK_STATE/$service.enabled" ]];;
  stop) rm -f "$MOCK_STATE/$service.active";;
  start) touch "$MOCK_STATE/$service.active";;
  enable) touch "$MOCK_STATE/$service.enabled"; if [[ "$*" == *--now* ]]; then touch "$MOCK_STATE/$service.active"; fi;;
  disable) rm -f "$MOCK_STATE/$service.enabled"; if [[ "$*" == *--now* ]]; then rm -f "$MOCK_STATE/$service.active"; fi;;
  daemon-reload) :;;
  *) exit 1;;
esac
`);
  const target=path.join(directory,'opt/unmanned-boat-web'),unit=path.join(directory,'etc/systemd/system/unmanned-boat-web.service');
  write('opt/unmanned-boat-web/.boat-web-deployment','unmanned-boat-web-v1\n');write('opt/unmanned-boat-web/old.txt','old-site');
  const originalUnit='# Owned by unmanned-boat-web-v1\nold service contents\n';write('etc/systemd/system/unmanned-boat-web.service',originalUnit);
  write('state/unmanned-boat-web.service.active','');write('state/unmanned-boat-web.service.enabled','');
  const log=path.join(directory,'calls.log');
  const run=(script,args=[],extra={})=>spawnSync(bash,[unix(path.join(source,script)),...args],{encoding:'utf8',env:{...process.env,PATH:unix(bin)+':'+process.env.PATH,MOCK_STATE:unix(state),MOCK_LOG:unix(log),...extra},timeout:20000});
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return {directory,target,unit,state,write,run,log,originalUnit};
}
test('Linux dependency failure leaves the old site/service untouched',{skip:!bash},t=>{
  const f=fixture(t);f.write('source/package-lock.json','{}');
  const result=f.run('deploy.sh',['7890','127.0.0.1'],{MOCK_NPM_FAIL:'1'});
  assert.notEqual(result.status,0,result.stderr);assert.equal(fs.readFileSync(path.join(f.target,'old.txt'),'utf8'),'old-site');
  assert.equal(fs.readFileSync(f.unit,'utf8'),f.originalUnit);
  assert.doesNotMatch(fs.readFileSync(f.log,'utf8'),/^stop /m);
});
test('Linux startup failure rolls back application, unit and active state',{skip:!bash},t=>{
  const f=fixture(t),result=f.run('deploy.sh',['7890','127.0.0.1'],{MOCK_HEALTH:'1'});
  assert.notEqual(result.status,0,result.stderr);assert.match(result.stdout,/restored the previous site/);
  assert.equal(fs.readFileSync(path.join(f.target,'old.txt'),'utf8'),'old-site');assert.equal(fs.readFileSync(f.unit,'utf8'),f.originalUnit);
  assert.ok(fs.existsSync(path.join(f.state,'unmanned-boat-web.service.active')));
  assert.ok(fs.existsSync(path.join(f.state,'unmanned-boat-web.service.enabled')));
});
test('Linux upgrade preserves cloud secrets and default removal keeps recovery files',{skip:!bash},t=>{
  const f=fixture(t);
  f.write('etc/unmanned-boat-web/.boat-cloud-deployment','unmanned-boat-cloud-v1\n');
  f.write('etc/unmanned-boat-web/runtime.env','BOAT_CLOUD_ENABLED=1\nsecret-fixture\n');
  f.write('etc/systemd/system/unmanned-boat-mqtt.service','# Owned by unmanned-boat-cloud-v1\n');
  let result=f.run('deploy.sh',['7890','127.0.0.1']);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(fs.readFileSync(path.join(f.target,'server/helper.js'),'utf8'),'// runtime module');
  assert.equal(fs.readFileSync(path.join(f.directory,'etc/unmanned-boat-web/runtime.env'),'utf8'),'BOAT_CLOUD_ENABLED=1\nsecret-fixture\n');
  result=f.run('remove.sh');assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(fs.existsSync(f.target),false);
  const recovery=fs.readdirSync(path.join(f.directory,'opt')).find(x=>x.startsWith('unmanned-boat-web.removed-'));
  assert.ok(recovery);const saved=path.join(f.directory,'opt',recovery);
  assert.ok(fs.existsSync(path.join(saved,'app/server.js')));assert.ok(fs.existsSync(path.join(saved,'cloud-config/runtime.env')));
  assert.ok(fs.existsSync(path.join(saved,'unmanned-boat-web.service')));assert.ok(fs.existsSync(path.join(saved,'unmanned-boat-mqtt.service')));
});
test('Linux removal rejects an unmanaged cloud directory before stopping services',{skip:!bash},t=>{
  const f=fixture(t);f.write('etc/unmanned-boat-web/runtime.env','unmanaged');
  const result=f.run('remove.sh');assert.notEqual(result.status,0);assert.match(result.stdout,/Cloud ownership marker/);
  assert.equal(fs.existsSync(f.log),false);assert.ok(fs.existsSync(f.target));
});
test('Cloud installer accepts a Mosquitto2 help banner with exit status3',{skip:!bash},t=>{
  const f=fixture(t),result=f.run('deploy-cloud.sh');
  assert.notEqual(result.status,0);
  assert.match(result.stdout,/mosquitto service account is missing/);
  assert.doesNotMatch(result.stdout,/Mosquitto2 is required/);
  assert.equal(fs.readFileSync(path.join(f.target,'old.txt'),'utf8'),'old-site');
});
test('Cloud installer rejects an older broker even when help exits3',{skip:!bash},t=>{
  const f=fixture(t),result=f.run('deploy-cloud.sh',[],{MOCK_MOSQUITTO_VERSION:'1.6.18'});
  assert.notEqual(result.status,0);assert.match(result.stdout,/Mosquitto2 is required/);
});
