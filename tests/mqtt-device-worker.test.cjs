'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createMqttDeviceManager,createMqttDeviceWorker,validateInput}=require('../maintenance/mqtt-device-worker.cjs');
const originalPassword='$7$101$oldSalt$oldDeviceHash',bridgePassword='$7$101$bridgeSalt$bridgeHash';
const acl='# managed ACL\nuser boat-01\ntopic write boats/boat-01/telemetry\ntopic write boats/boat-01/status\ntopic read boats/boat-01/parameter-command\ntopic write boats/boat-01/parameter-response\ntopic write boats/boat-01/parameter-capability\n\nuser weather-reader\ntopic read weather/#\n\nuser boat-web-bridge\ntopic read boats/+/telemetry\ntopic read boats/+/status\ntopic write boats/+/parameter-command\ntopic read boats/+/parameter-response\ntopic read boats/+/parameter-capability\n';
async function fixture(t,options={}){
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'boat-mqtt-admin-')),file=name=>path.join(directory,name),calls=[],services=[];
  await fsp.writeFile(file('.boat-cloud-deployment'),'unmanned-boat-cloud-v1\n');
  await fsp.writeFile(file('broker.service'),'# Owned by unmanned-boat-cloud-v1\n');
  await fsp.writeFile(file('runtime.env'),'BOAT_MQTT_USERNAME=boat-web-bridge\nBOAT_MQTT_PASSWORD=fake-bridge-secret\nBOAT_MQTT_TOPIC_PREFIX=boats\n');
  await fsp.writeFile(file('passwd'),'boat-01:'+originalPassword+'\nweather-reader:$7$101$weather$hash\nboat-web-bridge:'+bridgePassword+'\n',{mode:0o640});
  await fsp.writeFile(file('acl'),acl,{mode:0o640});
  await fsp.writeFile(file('mosquitto.conf'),'allow_anonymous false\npassword_file '+file('passwd')+'\nacl_file '+file('acl')+'\n');
  await fsp.writeFile(file('access.txt'),'Device ID / username: boat-01\nDevice password: fake-old-secret\n#define BOAT_MQTT_DEVICE_ID "boat-01"\n#define BOAT_MQTT_USERNAME "boat-01"\n#define BOAT_MQTT_PASSWORD "fake-old-secret"\nBridge password: fake-bridge-secret\n',{mode:0o600});
  const initial=Object.fromEntries(await Promise.all(['passwd','acl','access.txt','runtime.env'].map(async name=>[name,await fsp.readFile(file(name),'utf8')])));
  const execute=async(executable,args)=>{
    calls.push([executable,...args]);assert.equal(args[0],'-U');assert.equal(args.length,2);
    const text=await fsp.readFile(args[1],'utf8'),split=text.indexOf(':'),username=text.slice(0,split),password=text.slice(split+1).trimEnd();
    if(process.platform!=='win32')assert.equal((await fsp.stat(args[1])).mode&0o777,0o600,'plaintext staging file must be private');
    const hash='$7$101$fakeSalt$'+crypto.createHash('sha512').update(password).digest('base64');
    await fsp.writeFile(args[1],username+':'+hash+'\n');
    if(options.afterHash)await options.afterHash({file});
  };
  const service=options.service||(async()=>{services.push('restart');});
  const managerOptions={configDir:directory,brokerUnit:file('broker.service'),checkOwnership:false,execute,service};
  t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
  return {directory,file,calls,services,initial,managerOptions,manager:createMqttDeviceManager(managerOptions)};
}
const input=async(f,extra={})=>({username:'boat-01',revision:(await f.manager.list()).revision,...extra});

test('device listing exposes only stable topic ID, username and opaque revision',async t=>{
  const f=await fixture(t),data=await f.manager.list();
  assert.deepEqual(data.devices,[{deviceId:'boat-01',username:'boat-01'}]);assert.match(data.revision,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(data),/fake-|\$7\$|password|bridge/);assert.deepEqual(f.calls,[]);assert.deepEqual(f.services,[]);
});

test('concurrent helper list callers share only in-flight work and retry fresh configuration after success or failure',async t=>{
  const f=await fixture(t),[first,second]=await Promise.all([f.manager.list(),f.manager.list()]);
  assert.deepEqual(first,second);assert.equal(f.services.length,0);assert.equal(f.calls.length,0);
  await fsp.appendFile(f.file('acl'),'\n# changed after first list\n');
  assert.notEqual((await f.manager.list()).revision,first.revision);
  await fsp.writeFile(f.file('.boat-cloud-deployment'),'invalid-deployment');
  const failed=await Promise.allSettled([f.manager.list(),f.manager.list()]);
  assert.deepEqual(failed.map(item=>[item.status,item.reason?.status]),[['rejected',503],['rejected',503]]);
  await fsp.writeFile(f.file('.boat-cloud-deployment'),'unmanned-boat-cloud-v1\n');
  assert.deepEqual((await f.manager.list()).devices,first.devices);
});
test('renaming a device preserves its hash, topic permissions and all unrelated credentials',async t=>{
  const f=await fixture(t),value=await f.manager.update('boat-01',await input(f,{username:'new-mqtt-user'}));
  assert.equal(value.ok,true);assert.equal(value.requiresReconnect,true);assert.deepEqual(value.devices,[{deviceId:'boat-01',username:'new-mqtt-user'}]);
  assert.equal(await fsp.readFile(f.file('passwd'),'utf8'),f.initial.passwd.replace('boat-01:','new-mqtt-user:'));
  assert.equal(await fsp.readFile(f.file('acl'),'utf8'),f.initial.acl.replace('user boat-01\n','user new-mqtt-user\n'));
  assert.equal(await fsp.readFile(f.file('runtime.env'),'utf8'),f.initial['runtime.env']);
  assert.equal(f.services.length,1);assert.equal(f.calls.length,0);
  const access=await fsp.readFile(f.file('access.txt'),'utf8');assert.doesNotMatch(access,/fake-old-secret|#define BOAT_MQTT_PASSWORD/);assert.match(access,/fake-bridge-secret/);assert.match(access,/Device ID: boat-01/);assert.match(access,/Device username: new-mqtt-user/);
});
test('password rotation uses private file hashing, never command-line passwords, and preserves bridge hash',async t=>{
  const f=await fixture(t),value=await f.manager.update('boat-01',await input(f,{password:'new-test-Secret!23'}));
  const passwd=await fsp.readFile(f.file('passwd'),'utf8');assert.ok(passwd.includes('boat-web-bridge:'+bridgePassword));assert.ok(!passwd.includes(originalPassword));
  assert.doesNotMatch(JSON.stringify(value),/new-test|\$7\$/);assert.doesNotMatch(JSON.stringify(f.calls),/new-test/);
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].slice(0,2),['/usr/bin/mosquitto_passwd','-U']);
  assert.deepEqual(await fsp.readdir(f.directory).then(names=>names.filter(name=>/^\.mqtt-/.test(name))),[]);
  if(process.platform!=='win32')assert.equal((await fsp.stat(f.file('passwd'))).mode&0o777,0o640);
});
test('no-op does not restart broker; stale revision and username collisions fail without changes',async t=>{
  const f=await fixture(t),request=await input(f),noop=await f.manager.update('boat-01',request);assert.equal(noop.requiresReconnect,false);
  for(const username of ['boat-web-bridge','weather-reader'])await assert.rejects(f.manager.update('boat-01',{...request,username}),{status:409});
  await assert.rejects(f.manager.update('boat-01',{...request,revision:'a'.repeat(64)}),{status:409});
  await assert.rejects(f.manager.update('other-boat',request),{status:404});
  assert.equal(await fsp.readFile(f.file('passwd'),'utf8'),f.initial.passwd);assert.equal(f.services.length,0);
});
test('strict request validation blocks injection, unsupported credentials and ID changes',()=>{
  const base={username:'boat-01',revision:'a'.repeat(64)};
  for(const body of [{...base,deviceId:'different'}, {...base,username:123}, {...base,username:'user\ntopic read #'}, {...base,username:'a:b'},{...base,password:'bad:colon'},{...base,password:'has space'},{...base,password:'密码密码1234'},{...base,password:''},{...base,password:'a'.repeat(65)},{...base,revision:'stale'}])assert.throws(()=>validateInput(body),{status:400});
  assert.doesNotThrow(()=>validateInput({...base,password:'AZaz09!@#$%^&*()_+-=[]{};,.?/|~'}));
});
test('ambiguous and overbroad device ACL rules fail closed without touching other accounts',async t=>{
  const changes=[text=>text.replace('topic write boats/boat-01/status','topic write boats/+/status'),text=>text.replace('topic read boats/boat-01/parameter-command','topic read #'),text=>text+'\nuser boat-01\ntopic read #\n',text=>text.replace('user weather-reader','user other-boat\ntopic write boats/boat-01/telemetry\ntopic write boats/boat-01/status\n\nuser weather-reader')];
  for(const change of changes){const f=await fixture(t);await fsp.writeFile(f.file('acl'),change(acl));await assert.rejects(f.manager.list(),{status:503});assert.equal(await fsp.readFile(f.file('passwd'),'utf8'),f.initial.passwd);}
});
test('configuration changed during hash preparation is rejected before journaling',async t=>{
  const f=await fixture(t,{afterHash:async({file})=>fsp.appendFile(file('acl'),'\n# external change\n')});
  await assert.rejects(f.manager.update('boat-01',await input(f,{password:'new-test-Secret!23'})),{status:409});
  assert.equal(await fsp.readFile(f.file('passwd'),'utf8'),f.initial.passwd);assert.equal(f.services.length,0);assert.equal(fs.existsSync(f.file('.mqtt-device-transaction.json')),false);
});
test('broker failure restores all previous files and leaves no credential transaction after successful recovery',async t=>{
  let restarts=0;const f=await fixture(t,{service:async()=>{if(++restarts===1)throw Error('secret backend detail should not escape');}});
  const error=await f.manager.update('boat-01',await input(f,{username:'new-name',password:'new-test-Secret!23'})).then(()=>null,error=>error);
  assert.equal(error.status,503);assert.match(error.message,/已恢复原账号/);assert.doesNotMatch(error.message,/secret backend/);assert.equal(restarts,2);
  for(const name of ['passwd','acl','access.txt'])assert.equal(await fsp.readFile(f.file(name),'utf8'),f.initial[name]);assert.equal(fs.existsSync(f.file('.mqtt-device-transaction.json')),false);
});
test('failed rollback preserves a private durable journal and the next process recovers before listing',async t=>{
  const f=await fixture(t,{service:async()=>{throw Error('offline');}});
  await assert.rejects(f.manager.update('boat-01',await input(f,{username:'new-name'})),error=>error.status===503&&/恢复尚未完成/.test(error.message));
  assert.equal(fs.existsSync(f.file('.mqtt-device-transaction.json')),true);
  if(process.platform!=='win32')assert.equal((await fsp.stat(f.file('.mqtt-device-transaction.json'))).mode&0o777,0o600);
  let recovered=0;const manager=createMqttDeviceManager({...f.managerOptions,service:async()=>{recovered++;}}),listed=await manager.list();
  assert.equal(recovered,1);assert.deepEqual(listed.devices,[{deviceId:'boat-01',username:'boat-01'}]);assert.equal(fs.existsSync(f.file('.mqtt-device-transaction.json')),false);
});
test('parallel manager requests are serialized and cross-instance lock rejects overlapping writes',async t=>{
  let release,started;const signal=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{service:()=>{started();return new Promise(resolve=>{release=resolve;});}}),data=await input(f,{username:'new-name'});
  const change=f.manager.update('boat-01',data);await signal;
  await assert.rejects(f.manager.list(),{status:409});
  await assert.rejects(createMqttDeviceManager(f.managerOptions).list(),{status:409});release();await change;
});
test('unsafe symlink, hardlink, broker mismatch and unknown deployment are rejected',async t=>{
  for(const name of ['acl','passwd','runtime.env','.boat-cloud-deployment']){
    const f=await fixture(t),original=f.file(name),other=f.file('outside-'+name.replaceAll('.',''));
    await fsp.rename(original,other);
    try{await fsp.symlink(other,original);}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.diagnostic('Windows symlink privilege unavailable; checking hardlinks instead');await fsp.link(other,original);}else throw error;}
    await assert.rejects(f.manager.list(),{status:503});
  }
  const f=await fixture(t);await fsp.appendFile(f.file('mosquitto.conf'),'plugin /tmp/unmanaged-auth.so\n');await assert.rejects(f.manager.list(),{status:503});
  const g=await fixture(t);await fsp.writeFile(g.file('.boat-cloud-deployment'),'wrong-marker');await assert.rejects(g.manager.list(),{status:503});
});
test('interrupted plaintext staging files are removed only after claiming the configuration lock',async t=>{
  const f=await fixture(t),temporary=f.file('.mqtt-password-12345678-1234-4123-8123-123456789abc');
  await fsp.writeFile(temporary,'boat-01:fake-interrupted-secret\n',{mode:0o600});
  await f.manager.list();assert.equal(fs.existsSync(temporary),false);
  const other=f.file('unrelated-private-file');await fsp.writeFile(other,'private');await fsp.link(other,temporary);
  await assert.rejects(f.manager.list(),{status:503});assert.equal(await fsp.readFile(other,'utf8'),'private');
});
test('HTTP worker accepts bounded fixed routes and emits only safe errors',async t=>{
  const f=await fixture(t),server=createMqttDeviceWorker({manager:f.manager});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const list=await fetch(base+'/devices'),data=await list.json();assert.equal(list.status,200);assert.equal(list.headers.get('cache-control'),'no-store');
  const put=body=>fetch(base+'/devices/boat-01',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await put({...data,username:'new-name'})).status,400);
  const changed=await put({revision:data.revision,username:'new-name'});assert.equal(changed.status,200);assert.equal((await changed.json()).requiresReconnect,true);
  assert.equal((await fetch(base+'/devices/../passwd')).status,404);
  assert.equal((await fetch(base+'/devices',{method:'DELETE'})).status,405);
  assert.equal((await fetch(base+'/devices/boat-01',{method:'PUT',body:'bad'})).status,415);
  assert.equal((await put({revision:data.revision,username:'new-name',password:'a'.repeat(3000)})).status,413);
});

test('new boat gets an independent account and eleven own-topic permissions while existing credentials persist',async t=>{
  const f=await fixture(t),before=await f.manager.list();assert.equal(before.canCreate,true);
  const password='new-boat-test-Secret!23',created=await f.manager.create({deviceId:'boat-02',username:'vessel-two',password,revision:before.revision});
  assert.deepEqual(created.devices,[{deviceId:'boat-01',username:'boat-01'},{deviceId:'boat-02',username:'vessel-two'}]);
  assert.equal(created.requiresReconnect,true);assert.notEqual(created.revision,before.revision);
  const passwd=await fsp.readFile(f.file('passwd'),'utf8');assert.ok(passwd.startsWith(f.initial.passwd));assert.match(passwd,/vessel-two:\$7\$/);assert.ok(!passwd.includes(password));
  const nextAcl=await fsp.readFile(f.file('acl'),'utf8');assert.ok(nextAcl.startsWith(f.initial.acl));
  assert.equal(nextAcl.slice(f.initial.acl.length).trim(),'user vessel-two\ntopic write boats/boat-02/telemetry\ntopic write boats/boat-02/status\ntopic read boats/boat-02/parameter-command\ntopic write boats/boat-02/parameter-response\ntopic write boats/boat-02/parameter-capability\ntopic read boats/boat-02/firmware-command\ntopic write boats/boat-02/firmware-response\ntopic write boats/boat-02/firmware-capability\ntopic read boats/boat-02/control-command\ntopic write boats/boat-02/control-state\ntopic write boats/boat-02/control-capability');
  assert.equal(await fsp.readFile(f.file('runtime.env'),'utf8'),f.initial['runtime.env']);
  assert.doesNotMatch(JSON.stringify(created),/password|\$7\$/);assert.ok(!(await fsp.readFile(f.file('access.txt'),'utf8')).includes(password));assert.equal(f.services.length,1);
  assert.deepEqual((await createMqttDeviceManager(f.managerOptions).list()).devices,created.devices);
});

test('new boat validation and duplicate ID or account reject without hashing, restart or overwriting existing files',async t=>{
  const f=await fixture(t),revision=(await f.manager.list()).revision,valid={deviceId:'boat-02',username:'vessel-two',password:'new-test-Password!23',revision};
  for(const extra of [{deviceId:'boat-01'},{username:'boat-web-bridge'},{username:'weather-reader'},{revision:'b'.repeat(64)}])await assert.rejects(f.manager.create({...valid,...extra}),{status:409});
  for(const extra of [{deviceId:'boat/02'},{deviceId:[]},{password:''},{password:'has:colon'},{password:'with space'},{revision:'invalid'},{command:'restart'},{username:'evil\nuser bridge'}])await assert.rejects(f.manager.create({...valid,...extra}),{status:400});
  const missing={...valid};delete missing.password;await assert.rejects(f.manager.create(missing),{status:400});
  for(const name of ['passwd','acl','access.txt','runtime.env'])assert.equal(await fsp.readFile(f.file(name),'utf8'),f.initial[name]);assert.equal(f.services.length,0);assert.equal(f.calls.length,0);
});

test('new boat creation respects custom topic prefixes and the 64-boat limit',async t=>{
  const f=await fixture(t);await fsp.writeFile(f.file('runtime.env'),f.initial['runtime.env'].replace('PREFIX=boats','PREFIX=fleet'));await fsp.writeFile(f.file('acl'),f.initial.acl.replaceAll('boats/','fleet/'));
  await f.manager.create({deviceId:'boat-02',username:'vessel-two',password:'test-Password!23',revision:(await f.manager.list()).revision});assert.match(await fsp.readFile(f.file('acl'),'utf8'),/topic write fleet\/boat-02\/telemetry/);
  const g=await fixture(t);for(let i=2;i<=64;i++){await fsp.appendFile(g.file('passwd'),'boat-'+i+':$7$101$salt$hash\n');await fsp.appendFile(g.file('acl'),'\nuser boat-'+i+'\ntopic write boats/boat-'+i+'/telemetry\ntopic write boats/boat-'+i+'/status\n');}
  const full=await g.manager.list();assert.equal(full.devices.length,64);await assert.rejects(g.manager.create({deviceId:'boat-65',username:'boat-65',password:'test-Password!23',revision:full.revision}),{status:409});assert.equal(g.services.length,0);assert.equal(g.calls.length,0);
});

test('new boat creation rolls back every file if Broker restart fails and leaves the existing boat usable',async t=>{
  let restarts=0;const f=await fixture(t,{service:async()=>{if(++restarts===1)throw Error('restart failed');}});
  await assert.rejects(f.manager.create({deviceId:'boat-02',username:'vessel-two',password:'test-Password!23',revision:(await f.manager.list()).revision}),{status:503});
  for(const name of ['passwd','acl','access.txt','runtime.env'])assert.equal(await fsp.readFile(f.file(name),'utf8'),f.initial[name]);
  assert.equal(restarts,2);assert.equal(fs.existsSync(f.file('.mqtt-device-transaction.json')),false);assert.equal((await f.manager.list()).devices.length,1);
});

test('new boat creation rejects concurrent external ACL changes before journal or account writes',async t=>{
  const f=await fixture(t,{afterHash:async({file})=>fsp.appendFile(file('acl'),'\n# changed externally\n')});
  await assert.rejects(f.manager.create({deviceId:'boat-02',username:'vessel-two',password:'test-Password!23',revision:(await f.manager.list()).revision}),{status:409});
  assert.equal(await fsp.readFile(f.file('passwd'),'utf8'),f.initial.passwd);assert.equal(f.services.length,0);assert.equal(fs.existsSync(f.file('.mqtt-device-transaction.json')),false);
});

test('HTTP worker provisions a second boat using the bounded POST collection route',async t=>{
  const f=await fixture(t),worker=createMqttDeviceWorker({manager:f.manager});await new Promise(resolve=>worker.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>worker.close(resolve)));
  const base='http://127.0.0.1:'+worker.address().port,revision=(await f.manager.list()).revision;
  const response=await fetch(base+'/devices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:'boat-02',username:'vessel-two',password:'test-Password!23',revision})});
  assert.equal(response.status,200);assert.equal((await response.json()).devices.length,2);
  assert.equal((await fetch(base+'/devices',{method:'POST',body:'not-json'})).status,415);
});
