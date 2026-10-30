'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {configureParameterAcl}=require('../maintenance/configure-parameter-acl.cjs');
const original='# private ACL\nuser boat-01\ntopic write boats/boat-01/telemetry\ntopic write boats/boat-01/status\n\nuser unrelated\ntopic read weather/#\n\nuser boat-web-bridge\ntopic read boats/+/telemetry\ntopic read boats/+/status\n';
function fixture(t,acl=original,env='BOAT_MQTT_USERNAME=boat-web-bridge\nBOAT_MQTT_TOPIC_PREFIX=boats\nBOAT_MQTT_PASSWORD=fake-only-test-password\n'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boat-parameter-acl-')),file=path.join(dir,'acl'),envFile=path.join(dir,'runtime.env');
  fs.writeFileSync(file,acl);fs.writeFileSync(envFile,env);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,file,envFile};
}
test('parameter ACL grants per-device replies and commands while preserving secrets and unrelated rules',t=>{
  const f=fixture(t),before=fs.readFileSync(f.envFile,'utf8');assert.equal(configureParameterAcl(f.file,f.envFile),true);
  const text=fs.readFileSync(f.file,'utf8'),device=text.split('user boat-01\n')[1].split('user unrelated')[0],bridge=text.split('user boat-web-bridge\n')[1];
  assert.match(device,/topic read boats\/boat-01\/parameter-command/);assert.match(device,/topic write boats\/boat-01\/parameter-response/);assert.match(device,/topic write boats\/boat-01\/parameter-capability/);
  assert.match(device,/topic read boats\/boat-01\/firmware-command/);assert.match(device,/topic write boats\/boat-01\/firmware-response/);assert.match(device,/topic write boats\/boat-01\/firmware-capability/);
  assert.match(bridge,/topic write boats\/\+\/firmware-command/);assert.match(bridge,/topic read boats\/\+\/firmware-response/);assert.match(bridge,/topic read boats\/\+\/firmware-capability/);
  assert.match(device,/topic read boats\/boat-01\/control-command/);assert.match(device,/topic write boats\/boat-01\/control-state/);assert.match(device,/topic write boats\/boat-01\/control-capability/);
  assert.match(bridge,/topic write boats\/\+\/control-command/);assert.match(bridge,/topic read boats\/\+\/control-state/);assert.match(bridge,/topic read boats\/\+\/control-capability/);
  assert.doesNotMatch(device,/topic write .*control-command/);assert.doesNotMatch(bridge,/topic write .*control-state/);
  assert.doesNotMatch(device,/topic write .*firmware-command/);assert.doesNotMatch(bridge,/topic write .*firmware-response/);
  assert.doesNotMatch(device,/topic write .*parameter-command|boats\/\+/);assert.match(bridge,/topic write boats\/\+\/parameter-command/);assert.match(bridge,/topic read boats\/\+\/parameter-response/);assert.match(bridge,/topic read boats\/\+\/parameter-capability/);
  assert.ok(text.includes('user unrelated\ntopic read weather/#\n\n'));assert.equal(fs.readFileSync(f.envFile,'utf8'),before);
  const backups=fs.readdirSync(f.dir).filter(name=>name.startsWith('acl.before-parameters-'));assert.equal(backups.length,1);assert.equal(fs.readFileSync(path.join(f.dir,backups[0]),'utf8'),original);
  assert.equal(configureParameterAcl(f.file,f.envFile),false);assert.equal(fs.readdirSync(f.dir).filter(name=>name.startsWith('acl.before-parameters-')).length,1);
});
test('custom prefixes preserve the same per-device ACL restriction',t=>{
  const f=fixture(t,original.replaceAll('boats/','fleet/'),'BOAT_MQTT_USERNAME=boat-web-bridge\nBOAT_MQTT_TOPIC_PREFIX=fleet\n');
  assert.equal(configureParameterAcl(f.file,f.envFile),true);const text=fs.readFileSync(f.file,'utf8');assert.match(text,/topic read fleet\/boat-01\/parameter-command/);assert.doesNotMatch(text,/boats\//);
});
test('unrecognized or ambiguous accounts fail before changing the existing ACL',t=>{
  for(const acl of ['user stranger\ntopic read #\n',original+'\nuser boat-web-bridge\ntopic read weather/#\n']){
    const f=fixture(t,acl);assert.throws(()=>configureParameterAcl(f.file,f.envFile),/missing or ambiguous/);assert.equal(fs.readFileSync(f.file,'utf8'),acl);assert.equal(fs.readdirSync(f.dir).length,2);
  }
});
