/* 离线模拟 OTA，不连接船或生产 Broker；验证真实 ACK、重启确认、权限及有界上传。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),http=require('node:http');
const P=require('../server/firmware-protocol'),{FirmwareService}=require('../server/firmware-service');
const {CloudBridge}=require('../server/cloud'),{createServer}=require('../server');
const KEY='42'.repeat(32),SESSION='0123456789abcdef',BOOT='fedcba9876543210',ORIGIN='https://firmware.test';
const ENV={BOAT_CLOUD_ENABLED:'1',BOAT_MQTT_URL:'mqtt://test.invalid',BOAT_OTA_KEY:KEY,BOAT_ACCOUNTS_ENABLED:'1',BOAT_ACCOUNTS_ORIGIN:ORIGIN,
  BOAT_ADMIN_USERNAME:'admin',BOAT_ADMIN_PASSWORD:'firmware-admin-test',BOAT_GUEST_USERNAME:'guest',BOAT_GUEST_PASSWORD:'firmware-guest-test'};
function image(size=1024){const result=Buffer.alloc(size,0x55);result.writeUInt32LE(0x20020000,0);result.writeUInt32LE(P.APPLICATION_ADDRESS+129,4);return result;}
function capability(extra={}){return Buffer.from(JSON.stringify({v:1,boardId:P.BOARD_ID,applicationAddress:P.APPLICATION_ADDRESS,maxSize:P.MAX_SIZE,
  chunkSize:P.CHUNK_SIZE,session:SESSION,bootId:BOOT,imageSha256:null,ready:true,state:'idle',uptimeMs:1000,...extra}));}
function ack(packet,size=1024,{status=0,nextOffset=packet[4]===P.OP.DATA?packet.readUInt32LE(32)+packet.readUInt32LE(36):packet[4]===P.OP.COMMIT?size:0}={}){
  const result=Buffer.alloc(48);result.write('BOR1');result[4]=packet[4];result[5]=status;packet.copy(result,8,8,32);result.writeUInt32LE(nextOffset,32);result.writeUInt32LE(size,36);return result;
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,timeout=1500){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error('Timed out');await new Promise(resolve=>setTimeout(resolve,2));}}
class FakeBridge extends EventEmitter{
  constructor(){super();this.enabled=true;this.brokerConnected=true;this.sent=[];this.locks=new Set();}
  claimFirmware(id){if(this.locks.has(id))throw Object.assign(Error('busy'),{status:409});this.locks.add(id);}
  releaseFirmware(id){this.locks.delete(id);}
  publishFirmware(deviceId,payload){const sent={deviceId,payload:Buffer.from(payload)};this.sent.push(sent);this.onPublish?.(sent);return Promise.resolve();}
  cap(extra={},deviceId='boat-01'){this.emit('firmware-capability',{deviceId,payload:capability(extra)});}
  reply(sent=this.sent.at(-1),options={},size=1024){this.emit('firmware-response',{deviceId:sent.deviceId,payload:ack(sent.payload,size,options)});}
}
function serviceFixture(t,options={}){const bridge=new FakeBridge(),service=new FirmwareService({bridge,key:P.keyFrom(KEY),beginTimeoutMs:15,blockTimeoutMs:15,installTimeoutMs:40,...options});t.after(()=>service.close());bridge.cap();return{bridge,service};}

test('OTA protocol binds image, board, address and size to HMAC and rejects straight-flash or malformed binaries',()=>{
  const bin=image(),key=P.keyFrom(KEY),manifest=P.manifest(bin,key);assert.equal(manifest.length,88);assert.equal(manifest.toString('ascii',0,8),'BOATOTA1');
  assert.equal(manifest.readUInt32LE(8),P.BOARD_ID);assert.equal(manifest.readUInt32LE(12),P.APPLICATION_ADDRESS);assert.equal(manifest.readUInt32LE(16),bin.length);
  assert.deepEqual(manifest.subarray(24,56),crypto.createHash('sha256').update(bin).digest());assert.deepEqual(manifest.subarray(56),crypto.createHmac('sha256',key).update(manifest.subarray(0,56)).digest());
  assert.equal(P.keyFrom('bad'),null);assert.equal(P.keyFrom(['42'.repeat(32)]),null);
  for(const bad of [Buffer.alloc(255),Buffer.alloc(P.MAX_SIZE+1),Buffer.alloc(256)])assert.throws(()=>P.validateImage(bad),{status:400});
  for(const [offset,value]of [[0,0x08020000],[0,0x20000001],[4,0x08000101],[4,P.APPLICATION_ADDRESS+1025],[4,P.APPLICATION_ADDRESS+128]]){
    const bad=image();bad.writeUInt32LE(value,offset);assert.throws(()=>P.validateImage(bad),{status:400});
  }
  for(const ramTop of [0x20020000,0x24080000,0x30048000,0x38010000]){const valid=image();valid.writeUInt32LE(ramTop,0);assert.equal(P.validateImage(valid).size,1024);}
});
test('OTA parser rejects malformed fields and fixed headers; command bytes follow the shared 40-byte layout',()=>{
  const packet=P.command(P.OP.DATA,SESSION,'ab'.repeat(16),256,Buffer.alloc(256,7));assert.equal(packet.length,296);assert.equal(packet.toString('ascii',0,4),'BOT1');assert.equal(packet.readUInt32LE(32),256);assert.equal(packet.readUInt32LE(36),256);
  assert.throws(()=>P.command(P.OP.DATA,[SESSION],'ab'.repeat(16),0,Buffer.alloc(1)));assert.throws(()=>P.command(P.OP.DATA,SESSION,'ab'.repeat(16),P.MAX_SIZE,Buffer.alloc(1)));
  assert.equal(P.capability(capability()).session,SESSION);
  for(const change of [{session:[SESSION]},{bootId:[BOOT]},{boardId:1},{maxSize:1},{chunkSize:1024},{imageSha256:['a'.repeat(64)]},{ready:1},{uptimeMs:-1},{state:'unknown'}])assert.equal(P.capability(capability(change)),null);
  const response=ack(packet);assert.equal(P.response(response).nextOffset,512);
  for(const mutate of [b=>b[4]=9,b=>b[5]=10,b=>b[6]=1,b=>b[44]=1,b=>b[0]=0]){const bad=Buffer.from(response);mutate(bad);assert.equal(P.response(bad),null);}
  assert.equal(P.response(response.subarray(1)),null);
});
test('progress needs matching device/session/transfer/offset ACK; only reboot plus exact installed hash means success',async t=>{
  const f=serviceFixture(t);const snapshot=f.service.start('boat-01','test.bin',image());assert.equal(snapshot.job.progress,0);await turn();
  assert.equal(f.bridge.sent[0].payload[4],P.OP.BEGIN);assert.equal(f.service.snapshot('boat-01').job.receivedBytes,0);
  const begin=f.bridge.sent[0];f.bridge.emit('firmware-response',{deviceId:'boat-02',payload:ack(begin.payload)});await turn();assert.equal(f.bridge.sent.length,1);
  const wrong=ack(begin.payload);wrong[8]^=1;f.bridge.emit('firmware-response',{deviceId:'boat-01',payload:wrong});f.bridge.reply(begin,{nextOffset:1});await turn();assert.equal(f.bridge.sent.length,1);
  f.bridge.reply(begin);await turn();assert.equal(f.bridge.sent[1].payload[4],P.OP.DATA);assert.equal(f.service.snapshot('boat-01').job.progress,0);
  for(let index=1;index<=4;index++){f.bridge.reply(f.bridge.sent[index]);await turn();assert.equal(f.service.snapshot('boat-01').job.progress,index*25);}
  assert.equal(f.service.snapshot('boat-01').job.state,'verifying');f.bridge.reply();await turn();assert.equal(f.service.snapshot('boat-01').job.state,'installing');
  const sha256=P.validateImage(image()).sha256;f.bridge.cap({imageSha256:sha256});assert.equal(f.service.snapshot('boat-01').job.state,'installing');
  f.bridge.cap({bootId:'11'.repeat(8),imageSha256:'00'.repeat(32)});assert.equal(f.service.snapshot('boat-01').job.state,'installing');
  f.bridge.cap({bootId:'11'.repeat(8),imageSha256:sha256});assert.equal(f.service.snapshot('boat-01').job.state,'succeeded');assert.equal(f.bridge.locks.size,0);
  assert.equal(f.service.jobs.get('boat-01').image,null);assert.equal(f.service.jobs.get('boat-01').manifest,null);
  assert.doesNotMatch(JSON.stringify(f.service.snapshot('boat-01')),new RegExp(KEY+'|'+SESSION+'|bootId|session'));
});
test('timeouts retransmit identical packet at most three times and cancellation cannot leave the same boat locked',async t=>{
  const f=serviceFixture(t);f.service.start('boat-01','retry.bin',image());await until(()=>f.service.snapshot('boat-01').job.state==='failed');
  const begin=f.bridge.sent.filter(item=>item.payload[4]===P.OP.BEGIN);assert.equal(begin.length,3);assert.ok(begin.every(item=>item.payload.equals(begin[0].payload)));assert.equal(f.bridge.locks.size,0);
  f.bridge.cap();f.service.start('boat-01','cancel.bin',image());await turn();assert.throws(()=>f.service.start('boat-01','second.bin',image()),{status:409});
  assert.equal(f.service.cancel('boat-01').job.state,'cancelled');assert.equal(f.bridge.sent.at(-1).payload[4],P.OP.ABORT);assert.equal(f.bridge.locks.size,0);await turn();assert.equal(f.service.snapshot('boat-01').job.state,'cancelled');
});
test('commit without reboot confirmation is unknown; mid-transfer disconnect fails and requires fresh capabilities after reconnect',async t=>{
  const f=serviceFixture(t);f.bridge.onPublish=sent=>{if(sent.payload[4]!==P.OP.ABORT)f.bridge.reply(sent);};f.service.start('boat-01','install.bin',image());
  await until(()=>f.service.snapshot('boat-01').job.state==='installing');assert.throws(()=>f.service.cancel('boat-01'),{status:409});await until(()=>f.service.snapshot('boat-01').job.state==='unknown');assert.equal(f.bridge.locks.size,0);
  f.bridge.onPublish=null;f.bridge.cap();f.service.start('boat-01','disconnect.bin',image());await turn();f.bridge.brokerConnected=false;f.bridge.emit('state',{brokerConnected:false});
  assert.equal(f.service.snapshot('boat-01').job.state,'failed');f.bridge.brokerConnected=true;assert.equal(f.service.snapshot('boat-01').supported,false);assert.throws(()=>f.service.start('boat-01','stale.bin',image()),{status:503});
  f.bridge.cap();assert.equal(f.service.snapshot('boat-01').supported,true);assert.equal(f.service.acceptCapability({deviceId:'boat-01',payload:capability(),retained:true}),false);
});
test('device rejection, session rollover and bounded concurrent jobs never report success or accept stale capabilities',async t=>{
  let now=1000;const f=serviceFixture(t,{now:()=>now,maxActive:1,maxJobs:2});f.service.start('boat-01','one.bin',image());await turn();f.bridge.cap({},'boat-02');
  assert.throws(()=>f.service.start('boat-02','two.bin',image()),{status:429});f.bridge.reply(undefined,{status:2});await turn();assert.equal(f.service.snapshot('boat-01').job.state,'failed');
  f.bridge.cap();f.service.start('boat-01','one.bin',image());await turn();f.bridge.cap({session:'12'.repeat(8)});assert.equal(f.service.snapshot('boat-01').job.state,'failed');
  now+=5001;assert.equal(f.service.snapshot('boat-01').supported,false);assert.throws(()=>f.service.start('boat-01','old.bin',image()),{status:503});
});
test('late DATA acknowledgements cannot advance another block or boat; an explicit COMMIT rejection is failed',async t=>{
  const f=serviceFixture(t);f.bridge.cap({},'boat-02');f.service.start('boat-01','one.bin',image());f.service.start('boat-02','two.bin',image());await turn();
  for(const sent of [...f.bridge.sent])f.bridge.reply(sent);await turn();const data=f.bridge.sent.filter(item=>item.payload[4]===P.OP.DATA);assert.equal(data.length,2);
  f.bridge.reply(data[0]);await turn();const before=f.service.snapshot(data[0].deviceId).job.receivedBytes;f.bridge.reply(data[0]);await turn();assert.equal(f.service.snapshot(data[0].deviceId).job.receivedBytes,before);
  assert.equal(f.service.snapshot(data[1].deviceId).job.receivedBytes,0);f.service.cancel('boat-02');
  for(let block=1;block<4;block++){const sent=f.bridge.sent.filter(item=>item.deviceId==='boat-01'&&item.payload[4]===P.OP.DATA).at(-1);f.bridge.reply(sent);await turn();}
  const commit=f.bridge.sent.find(item=>item.deviceId==='boat-01'&&item.payload[4]===P.OP.COMMIT);assert.ok(commit);f.bridge.reply(commit,{status:6});await turn();assert.equal(f.service.snapshot('boat-01').job.state,'failed');
});
test('COMMIT ACK loss plus disconnect or session change keeps the lock until reboot evidence or a bounded timeout',async t=>{
  for(const cause of ['disconnect','session','timeout']){
    const f=serviceFixture(t,{installTimeoutMs:150,blockTimeoutMs:5});f.bridge.onPublish=sent=>{if([P.OP.BEGIN,P.OP.DATA].includes(sent.payload[4]))f.bridge.reply(sent);};
    f.service.start('boat-01','commit.bin',image());await until(()=>f.bridge.sent.some(item=>item.payload[4]===P.OP.COMMIT));
    if(cause==='disconnect'){f.bridge.brokerConnected=false;f.bridge.emit('state',{brokerConnected:false});}
    else if(cause==='session')f.bridge.cap({session:'33'.repeat(8),state:'installing',ready:false});
    else await until(()=>f.service.snapshot('boat-01').job.state==='installing');
    assert.equal(f.service.snapshot('boat-01').job.state,'installing');assert.equal(f.bridge.locks.has('boat-01'),true);await turn();
    f.bridge.brokerConnected=true;f.bridge.cap({session:'44'.repeat(8),bootId:'55'.repeat(8),imageSha256:P.validateImage(image()).sha256});
    assert.equal(f.service.snapshot('boat-01').job.state,'succeeded');assert.equal(f.bridge.locks.size,0);assert.equal(f.service.jobs.get('boat-01').pending,null);
  }
});
test('a rejected BEGIN need not report the new size, and shutdown releases queued, transferring and installing locks',async t=>{
  const rejected=serviceFixture(t);rejected.service.start('boat-01','unsafe.bin',image());await turn();rejected.bridge.reply(undefined,{status:2},0);await turn();assert.equal(rejected.service.snapshot('boat-01').job.state,'failed');assert.equal(rejected.bridge.locks.size,0);
  rejected.bridge.cap({ready:false,state:'failed'});assert.throws(()=>rejected.service.start('boat-01','early.bin',image()),{status:503});
  rejected.bridge.cap();rejected.service.start('boat-01','retry.bin',image());rejected.service.cancel('boat-01');
  for(const state of ['queued','transferring','installing']){
    const f=serviceFixture(t);if(state==='installing')f.bridge.onPublish=sent=>{if(sent.payload[4]!==P.OP.ABORT)f.bridge.reply(sent);};f.service.start('boat-01','close.bin',image());
    if(state==='transferring')await turn();if(state==='installing')await until(()=>f.service.snapshot('boat-01').job.state==='installing');
    f.service.close();await turn();assert.equal(f.service.snapshot('boat-01').job.state,state==='installing'?'unknown':'failed');assert.equal(f.bridge.locks.size,0);assert.equal(f.service.jobs.get('boat-01').pending,null);
    assert.equal(f.bridge.listenerCount('state'),0);assert.equal(f.bridge.listenerCount('firmware-capability'),0);
  }
});

class MQTT extends EventEmitter{constructor(){super();this.connected=true;this.sent=[];this.subscriptions=[];}subscribe(topics,options,callback){this.subscriptions.push(topics);callback(this.failOta&&topics.some(topic=>topic.endsWith('/firmware-capability'))?Error('forbidden'):null);}publish(topic,payload,options,callback){this.sent.push({topic,payload:Buffer.from(payload),options});callback?.();}end(){}}
function cloudFixture(t,extra={}){const client=new MQTT(),bridge=new CloudBridge({env:ENV,connect:()=>client,tickMs:60000,...extra});bridge.start();client.emit('connect');t.after(()=>bridge.stop());return{bridge,client};}
test('MQTT OTA grants no telemetry freshness, rejects retained and enforces parameter/firmware mutual exclusion',async t=>{
  const f=cloudFixture(t);assert.deepEqual(f.client.subscriptions.at(-1),['boats/+/firmware-capability','boats/+/firmware-response']);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/firmware-capability',capability(),{retain:true}),false);assert.equal(f.bridge.get('boat-01'),null);
  let events=0;f.bridge.on('firmware-capability',()=>events++);assert.equal(f.bridge.acceptMessage('boats/boat-01/firmware-capability',capability()),true);assert.equal(events,1);assert.equal(f.bridge.get('boat-01').online,false);assert.equal(f.bridge.get('boat-01').lastReceivedAt,null);
  f.bridge.pendingParameters.set('boat-01',{});assert.throws(()=>f.bridge.claimFirmware('boat-01'),{status:409});f.bridge.pendingParameters.delete('boat-01');f.bridge.claimFirmware('boat-01');
  await assert.rejects(f.bridge.requestParameters('boat-01','read'),{status:409});const packet=P.command(P.OP.ABORT,SESSION,'aa'.repeat(16));await f.bridge.publishFirmware('boat-01',packet);
  assert.equal(f.client.sent[0].topic,'boats/boat-01/firmware-command');assert.deepEqual(f.client.sent[0].options,{qos:0,retain:false});await assert.rejects(f.bridge.publishFirmware('boat-02',packet),{status:503});
  f.bridge.releaseFirmware('boat-01');await assert.rejects(f.bridge.publishFirmware('boat-01',packet),{status:503});
  f.client.failOta=true;f.client.emit('close');f.client.emit('connect');assert.equal(f.bridge.brokerConnected,true);assert.equal(f.bridge.firmwareSubscribed,false);assert.throws(()=>f.bridge.claimFirmware('boat-01'),{status:503});
});

function request(port,route,{method='GET',cookie,origin=ORIGIN,body,raw,headers={}}={}){const data=raw!==undefined?raw:body===undefined?undefined:JSON.stringify(body);return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...(data!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),...headers}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,raw,data,headers:res.headers});});});req.once('error',reject);req.end(data);
});}
async function apiFixture(t,options={}){const env={...ENV,...options.env},f=cloudFixture(t,{env}),server=createServer({env,cloud:f.bridge,accountOptions:{...options.accountOptions},firmwareOptions:{uploadTimeoutMs:100,serviceOptions:{beginTimeoutMs:100,blockTimeoutMs:100},...options.firmwareOptions}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));f.bridge.acceptMessage('boats/boat-01/firmware-capability',capability());
  const call=(route,opts)=>request(server.address().port,route,opts),login=async(role='admin')=>{const response=await call('/api/auth/login',{method:'POST',body:{username:role,password:role==='admin'?ENV.BOAT_ADMIN_PASSWORD:ENV.BOAT_GUEST_PASSWORD}});assert.equal(response.status,200,response.raw);return response.headers['set-cookie'][0].split(';')[0];};
  const upload=(cookie,extra={})=>call('/api/firmware/boats/boat-01',{method:'POST',cookie,raw:image(),headers:{'Content-Type':'application/octet-stream','X-Firmware-Name':'ota.bin'},...extra});return{...f,server,call,login,upload};
}
test('firmware HTTP is admin-only and same-origin, rejects unsafe filenames/media/size/vectors, and does not expose signing/session secrets',async t=>{
  const f=await apiFixture(t),admin=await f.login(),guest=await f.login('guest');assert.equal((await f.call('/api/firmware/config')).status,401);assert.equal((await f.call('/api/firmware/config',{cookie:guest})).status,403);
  const config=await f.call('/api/firmware/config',{cookie:admin});assert.equal(config.status,200);assert.equal(config.data.enabled,true);assert.doesNotMatch(config.raw,new RegExp(KEY));
  assert.equal((await f.upload(guest)).status,403);assert.equal((await f.upload(admin,{origin:'https://evil.test'})).status,403);assert.equal((await f.upload(admin,{origin:null})).status,403);
  assert.equal((await f.upload(admin,{headers:{'Content-Type':'application/json','X-Firmware-Name':'ota.bin'}})).status,415);
  for(const filename of ['../ota.bin','C%3A%5Cota.bin','.bin','ota.hex','ota%00.bin'])assert.equal((await f.upload(admin,{headers:{'Content-Type':'application/octet-stream','X-Firmware-Name':filename}})).status,400);
  assert.equal((await f.upload(admin,{raw:Buffer.alloc(256)})).status,400);assert.equal((await f.upload(admin,{headers:{'Content-Type':'application/octet-stream','X-Firmware-Name':'ota.bin','Content-Length':P.MAX_SIZE+1}})).status,413);assert.equal(f.client.sent.length,0);
  assert.equal((await f.call('/api/firmware/boats/unknown',{cookie:admin})).status,404);
  const result=await f.upload(admin);assert.equal(result.status,202,result.raw);assert.equal(result.data.job.name,'ota.bin');assert.equal(result.data.job.progress,0);assert.doesNotMatch(result.raw,new RegExp(KEY+'|'+SESSION+'|session|bootId'));
  assert.equal((await f.upload(admin)).status,409);const cancelled=await f.call('/api/firmware/boats/boat-01/cancel',{method:'POST',cookie:admin,body:{}});assert.equal(cancelled.status,200);assert.equal(cancelled.data.job.state,'cancelled');
});
test('disabled OTA and expired upload session cannot queue a command; installed service is present in server lifecycle',async t=>{
  const disabled=await apiFixture(t,{env:{BOAT_OTA_KEY:''}}),cookie=await disabled.login();assert.equal((await disabled.call('/api/firmware/config',{cookie})).data.enabled,false);assert.equal((await disabled.upload(cookie)).status,503);assert.equal(disabled.client.sent.length,0);
  let now=10000;const f=await apiFixture(t,{accountOptions:{now:()=>now,sessionMs:100}}),admin=await f.login();const bin=image();
  const result=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:f.server.address().port,path:'/api/firmware/boats/boat-01',method:'POST',agent:false,headers:{Origin:ORIGIN,Cookie:admin,'Content-Type':'application/octet-stream','Content-Length':bin.length,'X-Firmware-Name':'ota.bin'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.once('error',reject);req.write(bin.subarray(0,8));setTimeout(()=>{now+=101;req.end(bin.subarray(8));},10);});
  assert.equal(result,401);assert.equal(f.client.sent.length,0);assert.equal(f.server.boatFirmwareApi.manager.jobs.size,0);
});
test('chunked oversize, upload timeout and an abandoned upload cannot queue a firmware task',async t=>{
  const f=await apiFixture(t,{firmwareOptions:{uploadTimeoutMs:25}}),admin=await f.login();
  const send=mode=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:f.server.address().port,path:'/api/firmware/boats/boat-01',method:'POST',agent:false,headers:{Origin:ORIGIN,Cookie:admin,'Content-Type':'application/octet-stream','X-Firmware-Name':'ota.bin','Transfer-Encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.once('error',reject);req.write(image(256));
    if(mode==='oversize'){for(let offset=256;offset<=P.MAX_SIZE;offset+=16384)req.write(Buffer.alloc(Math.min(16384,P.MAX_SIZE+1-offset)));req.end();}
  });
  assert.equal(await send('oversize'),413);assert.equal(await send('timeout'),408);assert.equal(f.client.sent.length,0);assert.equal(f.server.boatFirmwareApi.manager.jobs.size,0);
  await new Promise(resolve=>{const req=http.request({host:'127.0.0.1',port:f.server.address().port,path:'/api/firmware/boats/boat-01',method:'POST',agent:false,headers:{Origin:ORIGIN,Cookie:admin,'Content-Type':'application/octet-stream','X-Firmware-Name':'ota.bin','Content-Length':1024}});req.once('error',()=>resolve());req.write(image(256));setTimeout(()=>req.destroy(),5);});
  await turn();assert.equal(f.client.sent.length,0);assert.equal(f.server.boatFirmwareApi.manager.jobs.size,0);
});
test('closing the firmware service while bytes are uploading rejects the late body and cannot restart a task',async t=>{
  const f=await apiFixture(t),admin=await f.login(),bin=image();
  const result=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:f.server.address().port,path:'/api/firmware/boats/boat-01',method:'POST',agent:false,headers:{Origin:ORIGIN,Cookie:admin,'Content-Type':'application/octet-stream','Content-Length':bin.length,'X-Firmware-Name':'ota.bin'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.once('error',reject);req.write(bin.subarray(0,8));setTimeout(()=>{f.server.boatFirmwareApi.close();req.end(bin.subarray(8));},10);});
  assert.equal(result,401);await turn();assert.equal(f.client.sent.length,0);assert.equal(f.server.boatFirmwareApi.manager.jobs.size,0);assert.equal(f.bridge.firmwareLocks.size,0);
  assert.equal(f.bridge.listenerCount('firmware-capability'),0);assert.equal(f.bridge.listenerCount('firmware-response'),0);
});
