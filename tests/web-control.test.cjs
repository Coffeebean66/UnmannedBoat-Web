'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{EventEmitter}=require('node:events');
const P=require('../server/control-protocol'),{ControlService}=require('../server/control-service'),{CloudBridge}=require('../server/cloud'),{createServer}=require('../server');
const UART=require('../public/utils/uart4Protocol'),parameters=require('../server/parameter-protocol');
const TOKEN='0123456789abcdef',NEXT='fedcba9876543210',CLIENT='1122334455667788',OTHER='8899aabbccddeeff';
const INPUT={mode:1,throttle:0,turn:0,targetHeading:9000};
const ENV={BOAT_CLOUD_ENABLED:'1',BOAT_CLOUD_ORIGIN:'https://boat.test',BOAT_CLOUD_PASSWORD:'legacy-test-password-fixture',BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'control-admin',BOAT_ADMIN_PASSWORD:'control test password',BOAT_GUEST_USERNAME:'control-guest',BOAT_GUEST_PASSWORD:'654321'};
function telemetry(){const packet=Buffer.alloc(176);for(const [offset,length,version,type]of [[0,64,1,1],[64,40,2,2],[104,36,2,3],[140,36,1,4]]){const frame=packet.subarray(offset,offset+length);frame.set([0xa5,0x5a,version,type,length]);frame.writeUInt16LE(UART.crc16CcittFalse(frame,2,length-4),length-2);}return packet;}
function status(values={}){return {version:1,token:TOKEN,uptimeMs:1000,state:0,leaseId:P.ZERO,sequence:0,mode:1,reason:0,enabled:true,timeoutMs:500,...values};}
class MQTT extends EventEmitter{
  constructor(){super();this.connected=true;this.sent=[];this.subscriptions=[];}
  subscribe(topics,options,callback){this.subscriptions.push(topics);callback?.(null,topics.map(topic=>({topic,qos:0})));}
  publish(topic,payload,options,callback){const command={topic,payload:Buffer.from(payload),options};this.sent.push(command);this.onPublish?.(command);callback?.(this.publishError);}
  end(){}
}
function fixture(t,options={}){
  let time=10000;const client=new MQTT(),bridge=new CloudBridge({env:ENV,connect:()=>client,now:()=>time,tickMs:60000});bridge.start();client.emit('connect');
  const manager=new ControlService({bridge,now:()=>time,pollMs:60000,...options});
  t.after(async()=>{manager.close();await bridge.stop();});
  const publish=(value,id='boat-01',packet={},kind='control-state')=>bridge.acceptMessage('boats/'+id+'/'+kind,Buffer.from(JSON.stringify(value)),packet);
  const live=(id='boat-01')=>bridge.acceptMessage('boats/'+id+'/telemetry',telemetry());
  const ack=(command=client.sent.at(-1),values={},id=command.topic.split('/')[1])=>publish(status({token:command.payload.subarray(4,12).toString('hex'),uptimeMs:command.payload.readUInt32LE(12),leaseId:command.payload.subarray(16,24).toString('hex'),sequence:command.payload.readUInt32LE(24),mode:command.payload[29],state:command.payload[28]<=2?1:2,reason:command.payload[28]===3?2:command.payload[28]===4?3:0,...(command.payload[36]?{testMode:command.payload[28]<=2}:{}),...values}),id);
  live();publish(status(),undefined,{},'control-capability');
  return {bridge,manager,client,publish,live,ack,now:()=>time,setTime:value=>{time=value;},async acquire(owner='session-a',clientId=CLIENT,id='boat-01'){const pending=manager.acquire(id,owner,clientId,INPUT);ack();return pending;}};
}
function call(port,route,{method='GET',cookie,origin='https://boat.test',body,raw,headers={}}={}){
  const data=raw!==undefined?raw:body===undefined?undefined:JSON.stringify(body);
  return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...(data!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...(cookie?{cookie}:{}),...(origin?{origin}:{}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(text);}catch(_){}resolve({status:res.statusCode,json,text,headers:res.headers});});});req.on('error',reject);req.end(data);});
}
async function apiFixture(t,options={}){
  const f=fixture(t),server=createServer({env:ENV,cloud:f.bridge,accountOptions:{now:f.now,...options.accountOptions},controlOptions:{service:f.manager}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const port=server.address().port;
  return {...f,server,port,call:(route,options)=>call(port,route,options),async login(role='admin'){
    const response=await call(port,'/api/auth/login',{method:'POST',body:{username:role==='admin'?'control-admin':'control-guest',password:role==='admin'?'control test password':'654321'}});assert.equal(response.status,200,response.text);return response.headers['set-cookie'][0].split(';')[0];
  },post(cookie,values={},options={}){return call(port,'/api/cloud/control',{method:'POST',cookie,body:{deviceId:'boat-01',clientId:CLIENT,action:'acquire',...INPUT,...values},...options});}};
}
async function until(predicate){const end=Date.now()+1500;while(!predicate()){if(Date.now()>end)throw Error('Timed out');await new Promise(resolve=>setTimeout(resolve,2));}}

test('BDC1 uses a stable forty-byte signed little-endian protocol vector and strict live statuses',()=>{
  const value=P.command({token:TOKEN,uptimeMs:1000,leaseId:CLIENT,sequence:7,action:'input',mode:1,throttle:-321,turn:456,targetHeading:35999});
  assert.equal(value.toString('hex'),'424443310123456789abcdefe80300001122334455667788070000000201bffec8019f8c00000000');
  assert.deepEqual(P.status(Buffer.from(JSON.stringify(status()))),status());
  for(const value of [{...status(),version:2},{...status(),timeoutMs:501},{...status(),leaseId:'unsafe'},{...status(),token:P.ZERO},{...status(),token:[TOKEN]},{...status(),state:3},{...status(),sequence:-1},{...status(),extra:true}])assert.equal(P.status(Buffer.from(JSON.stringify(value))),null);
  for(const value of [{...INPUT,throttle:1001},{...INPUT,mode:'1'},{...INPUT,targetHeading:36000},{...INPUT,turn:NaN}])assert.throws(()=>P.controls(value),{status:400});
});

test('test mode adds an explicit flag, requires PWM, and advertises capability without breaking old statuses',()=>{
  const packet=P.command({token:TOKEN,uptimeMs:1000,leaseId:CLIENT,sequence:7,action:'input',mode:0,throttle:200,turn:-100,targetHeading:0,testMode:true});
  assert.equal(packet.length,40);assert.equal(packet[36],1);assert.deepEqual([...packet.subarray(37)],[0,0,0]);
  const current=status({mode:0,testMode:false});assert.deepEqual(P.status(Buffer.from(JSON.stringify(current))),current);
  assert.deepEqual(P.status(Buffer.from(JSON.stringify(status()))),status());
  for(const value of [status({testMode:'false'}),status({testMode:null}),status({testMode:true}),status({state:1,mode:1,testMode:true})])assert.equal(P.status(Buffer.from(JSON.stringify(value))),null);
  for(const input of [{...INPUT,testMode:true},{...INPUT,testMode:'true'},{...INPUT,testMode:1}])assert.throws(()=>P.controls(input),{status:400});
  assert.ok(P.status(Buffer.from(JSON.stringify(status({state:1,mode:0,testMode:true})))));
  const largest=status({uptimeMs:0xffffffff,sequence:0xffffffff,state:1,mode:0,testMode:true});assert.ok(Buffer.byteLength(JSON.stringify(largest))<=256);
});

test('test leases require firmware support and matching ACK; input cannot toggle the test flag mid-lease',async t=>{
  const f=fixture(t),input={mode:0,throttle:0,turn:0,targetHeading:0,testMode:true};
  assert.throws(()=>f.manager.acquire('boat-01','session-a',CLIENT,input),{status:409});assert.equal(f.client.sent.length,0);
  f.publish(status({uptimeMs:1100,testMode:false}));assert.equal(f.manager.snapshot('boat-01').testSupported,true);
  const pending=f.manager.acquire('boat-01','session-a',CLIENT,input);assert.equal(f.client.sent.at(-1).payload[36],1);f.ack();const lease=await pending;
  assert.equal(lease.testMode,true);assert.equal(lease.active,true);
  assert.throws(()=>f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,1,'input',{...input,testMode:false}),{status:409});
  f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,2,'input',{...input,throttle:600});f.ack();assert.equal(f.client.sent.at(-1).payload.readInt16LE(30),600);
  f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,3,'release',input);f.ack();assert.equal(f.manager.snapshot('boat-01').testMode,false);assert.equal(f.manager.jobs.size,0);
});

test('a firmware ACK without the requested test flag cancels takeover instead of enabling ordinary control',async t=>{
  const f=fixture(t);f.publish(status({uptimeMs:1100,testMode:false}));
  const pending=f.manager.acquire('boat-01','session-a',CLIENT,{mode:0,throttle:0,turn:0,targetHeading:0,testMode:true});
  f.ack(undefined,{testMode:false});await assert.rejects(pending,{status:409});assert.equal(f.manager.snapshot('boat-01').ready,false);assert.equal(f.manager.jobs.get('boat-01').status,'stopping');
});

test('acquire remains pending until the exact current boat token and lease receive a nonretained hardware acknowledgement',async t=>{
  const f=fixture(t),pending=f.manager.acquire('boat-01','session-a',CLIENT,INPUT),command=f.client.sent.at(-1);let done=false;pending.then(()=>{done=true;});
  assert.equal(command.topic,'boats/boat-01/control-command');assert.deepEqual(command.options,{qos:0,retain:false});
  assert.equal(f.manager.snapshot('boat-01','session-a',CLIENT).active,false);assert.equal(f.manager.snapshot('boat-01','session-a',CLIENT).status,'acquiring');
  assert.equal(f.ack(command,{},'boat-02'),true);await Promise.resolve();assert.equal(done,false);
  assert.equal(f.ack(command,{token:NEXT},'other'),true);await Promise.resolve();assert.equal(done,false);
  assert.equal(f.publish(status({state:1,leaseId:command.payload.subarray(16,24).toString('hex'),sequence:1}), 'boat-01',{retain:true}),false);
  f.ack(command);const result=await pending;assert.equal(result.active,true);assert.equal(result.owned,true);assert.equal(result.leaseId,command.payload.subarray(16,24).toString('hex'));
});

test('per-boat lease belongs to an account session and one browser; foreign sessions never learn or use its lease',async t=>{
  const f=fixture(t),lease=await f.acquire();
  for(const [owner,client]of [['session-b',CLIENT],['session-a',OTHER]]){
    const value=f.manager.snapshot('boat-01',owner,client);assert.equal(value.owned,false);assert.equal(value.leaseId,undefined);
    assert.throws(()=>f.manager.command('boat-01',owner,client,lease.leaseId,1,'input',{...INPUT,throttle:500}),{status:409});
    assert.throws(()=>f.manager.acquire('boat-01',owner,client,INPUT),{status:409});
  }
  f.live('boat-02');f.publish(status(), 'boat-02');const other=await f.acquire('session-b',OTHER,'boat-02');assert.equal(other.active,true);assert.equal(f.manager.jobs.size,2);
});

test('new browser sequence is required for every input; duplicates cannot extend life or replay a motion command',async t=>{
  const f=fixture(t),lease=await f.acquire(),job=f.manager.jobs.get('boat-01');
  f.setTime(f.now()+100);f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,10,'input',{...INPUT,throttle:600,turn:-100});
  const packet=f.client.sent.at(-1).payload;assert.equal(packet.readUInt32LE(24),2);assert.equal(packet.readInt16LE(30),600);assert.equal(packet.readInt16LE(32),-100);
  const at=job.lastInputAt,count=f.client.sent.length;f.setTime(f.now()+200);
  for(const sequence of [10,9,0])assert.throws(()=>f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,sequence,'input',{...INPUT,throttle:600}),{status:409});
  assert.equal(job.lastInputAt,at);assert.equal(f.client.sent.length,count);
});

test('server never resends nonzero controls and sends a zero release after browser silence',async t=>{
  const f=fixture(t),lease=await f.acquire();f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,1,'input',{...INPUT,throttle:700});
  const count=f.client.sent.length;f.setTime(f.now()+599);f.manager.refresh();assert.equal(f.client.sent.length,count);
  f.setTime(f.now()+1);f.manager.refresh();assert.equal(f.client.sent.length,count+1);
  const stop=f.client.sent.at(-1);assert.equal(stop.payload[28],3);assert.equal(stop.payload.readInt16LE(30),0);assert.equal(stop.payload.readInt16LE(32),0);assert.equal(f.manager.jobs.get('boat-01').status,'stopping');
  f.ack(stop);assert.equal(f.manager.jobs.size,0);assert.equal(f.bridge.controlLocks.size,0);assert.equal(f.manager.snapshot('boat-01').state,2);
});

test('mode changes require neutral keys; stop invalidates further input and releases only after hardware acknowledgement',async t=>{
  const f=fixture(t),lease=await f.acquire();
  assert.throws(()=>f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,1,'input',{...INPUT,mode:2,throttle:500}),{status:400});
  f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,2,'input',{...INPUT,mode:2});f.ack();
  f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,3,'stop',{...INPUT,mode:2});assert.equal(f.bridge.controlLocks.has('boat-01'),true);
  assert.throws(()=>f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,4,'input',{...INPUT,mode:2,throttle:100}),{status:409});f.ack();assert.equal(f.bridge.controlLocks.has('boat-01'),false);
});

test('acquire, parameters and OTA share a per-boat mutex in both directions',async t=>{
  const f=fixture(t),lease=await f.acquire();f.bridge.firmwareSubscribed=true;
  await assert.rejects(f.bridge.requestParameters('boat-01','read'),{status:409});assert.throws(()=>f.bridge.claimFirmware('boat-01'),{status:409});
  f.manager.command('boat-01','session-a',CLIENT,lease.leaseId,1,'release',INPUT);f.ack();
  f.bridge.claimFirmware('boat-01');assert.throws(()=>f.manager.acquire('boat-01','session-a',CLIENT,INPUT),{status:409});f.bridge.releaseFirmware('boat-01');
  f.bridge.pendingParameters.set('boat-01',{});assert.throws(()=>f.manager.acquire('boat-01','session-a',CLIENT,INPUT),{status:409});f.bridge.pendingParameters.delete('boat-01');
});

test('stale telemetry/state, token changes and network loss stop the lease, and reconnect requires a new capability',async t=>{
  for(const cause of ['state','telemetry','token','network']){
    const f=fixture(t),lease=await f.acquire();
    if(cause==='state'){f.setTime(f.now()+751);f.live();}
    if(cause==='telemetry'){f.setTime(f.now()+1001);f.publish(status({uptimeMs:2001,state:1,leaseId:lease.leaseId,sequence:1}));}
    if(cause==='token')f.publish(status({token:NEXT}));
    if(cause==='network'){f.client.emit('close');assert.equal(f.manager.caps.size,0);f.client.emit('connect');f.live();assert.equal(f.manager.snapshot('boat-01').supported,false);}
    f.manager.refresh();assert.ok(!f.manager.jobs.has('boat-01')||f.manager.jobs.get('boat-01').status==='stopping',cause);
  }
});

test('an active firmware lease after server restart cannot be stolen and old wire status cannot roll back an ACK',async t=>{
  const f=fixture(t);f.publish(status({state:1,leaseId:OTHER,uptimeMs:1100,sequence:88}));
  assert.equal(f.manager.snapshot('boat-01').active,true);assert.equal(f.manager.snapshot('boat-01').owned,false);assert.equal(f.manager.snapshot('boat-01').ready,false);
  assert.throws(()=>f.manager.acquire('boat-01','session-a',CLIENT,INPUT),{status:409});
  f.publish(status({uptimeMs:1000,state:0}));assert.equal(f.manager.snapshot('boat-01').state,1);
  f.publish(status({state:2,leaseId:OTHER,uptimeMs:1200,sequence:88,reason:1}));assert.equal(f.manager.snapshot('boat-01').ready,true);
});

test('logout/session invalidation sends a zero stop and pending acquire timeouts do not leave indefinite locks',async t=>{
  const f=fixture(t),lease=await f.acquire();f.manager.releaseOwner('session-a');const stop=f.client.sent.at(-1);assert.equal(stop.payload[28],4);assert.equal(stop.payload.readInt16LE(30),0);f.ack(stop);
  const pending=f.manager.acquire('boat-01','session-a',CLIENT,INPUT);
  for(const uptimeMs of [1600,2200,2800]){f.setTime(f.now()+600);f.publish(status({uptimeMs,state:2,leaseId:OTHER}));f.live();}
  f.manager.refresh();await assert.rejects(pending,{status:504});
  f.setTime(f.now()+1200);f.manager.refresh();assert.equal(f.manager.jobs.size,0);assert.equal(f.bridge.controlLocks.size,0);
});

test('acquire may await hardware ACK beyond the active input deadline, while duplicate or older status cannot renew freshness',async t=>{
  const f=fixture(t),pending=f.manager.acquire('boat-01','session-a',CLIENT,INPUT),job=f.manager.jobs.get('boat-01');
  f.setTime(f.now()+700);f.live();f.publish(status({uptimeMs:1700}));f.manager.refresh();assert.equal(job.status,'acquiring');
  f.setTime(f.now()+600);f.live();f.publish(status({uptimeMs:2300}));f.manager.refresh();assert.equal(job.status,'acquiring');
  const cap=f.manager.caps.get('boat-01'),receivedAt=cap.receivedAt;f.setTime(f.now()+100);
  f.publish(status({uptimeMs:2300}));assert.equal(f.manager.caps.get('boat-01').receivedAt,receivedAt);
  f.publish(status({uptimeMs:2299}));assert.equal(f.manager.caps.get('boat-01').receivedAt,receivedAt);
  f.ack(f.client.sent.find(command=>command.payload[28]===1),{uptimeMs:2400});assert.equal((await pending).active,true);
  assert.equal(job.lastInputAt,f.now(),'The active input deadline starts at the MCU ACK, not the start of acquisition');
  f.manager.refresh();assert.equal(job.status,'active','A slow but fresh acquisition ACK gets time for the first browser heartbeat');
});

test('an acquire ACK delayed longer than the firmware deadline never makes the browser active',async t=>{
  const f=fixture(t),pending=f.manager.acquire('boat-01','session-a',CLIENT,INPUT),command=f.client.sent.at(-1);
  f.setTime(f.now()+650);f.live();f.ack(command);
  assert.equal(f.manager.snapshot('boat-01','session-a',CLIENT).active,false);assert.equal(f.manager.jobs.get('boat-01').status,'acquiring');
  f.ack(command,{uptimeMs:1650,state:2,reason:1});await assert.rejects(pending,{status:409});assert.equal(f.manager.jobs.size,0);
});

test('control HTTP rejects guests, cross origins, extra fields, old browser sequences and mismatched leases',async t=>{
  const f=await apiFixture(t),guest=await f.login('guest'),admin=await f.login();
  assert.equal((await f.post(undefined)).status,401);assert.equal((await f.post(guest)).status,403);assert.equal((await f.post(admin,{}, {origin:'https://evil.test'})).status,403);
  assert.equal((await f.post(admin,{rawPacket:'x'})).status,400);assert.equal((await f.post(admin,{throttle:1})).status,400);
  const count=f.client.sent.length;assert.equal((await f.post(admin,{mode:'1'})).status,400);assert.equal(f.client.sent.length,count);
  const pending=f.post(admin);await until(()=>f.manager.jobs.has('boat-01'));f.ack();const acquired=await pending;assert.equal(acquired.status,200,acquired.text);assert.equal(acquired.json.active,true);
  const input={action:'input',leaseId:acquired.json.leaseId,sequence:1,throttle:500};assert.equal((await f.post(admin,input)).status,202);
  const stale=await f.post(admin,input);assert.equal(stale.status,409);assert.equal(stale.json.code,'STALE_CONTROL_SEQUENCE');
  assert.equal((await f.post(admin,{...input,sequence:2,leaseId:OTHER})).status,409);
  const other=await f.login(),view=await f.call('/api/cloud/control?deviceId=boat-01&clientId='+CLIENT,{cookie:other});assert.equal(view.status,200);assert.equal(view.json.owned,false);assert.equal(view.json.leaseId,undefined);
  assert.equal((await f.post(other,{...input,sequence:3})).status,409);
});

test('HTTP test takeover validates role, boolean flag, firmware support and the returned test acknowledgement',async t=>{
  const f=await apiFixture(t),guest=await f.login('guest'),admin=await f.login(),input={mode:0,testMode:true};
  assert.equal((await f.post(guest,input)).status,403);
  assert.equal((await f.post(admin,{mode:0,testMode:'true'})).status,400);
  assert.equal((await f.post(admin,{mode:1,testMode:true})).status,400);
  assert.equal((await f.post(admin,input)).status,409);assert.equal(f.client.sent.length,0);
  f.publish(status({uptimeMs:1100,testMode:false}));
  const pending=f.post(admin,input);await until(()=>f.manager.jobs.has('boat-01'));f.ack();const acquired=await pending;
  assert.equal(acquired.status,200);assert.equal(acquired.json.testMode,true);assert.equal(acquired.json.testSupported,true);
  const command={...input,action:'input',leaseId:acquired.json.leaseId,sequence:1,throttle:300};
  assert.equal((await f.post(admin,command)).status,202);assert.equal(f.client.sent.at(-1).payload[36],1);
  assert.equal((await f.post(admin,{...command,sequence:2,testMode:false})).status,409);
});

test('account logout stops active controls and late credentials cannot publish another motion input',async t=>{
  const f=await apiFixture(t),admin=await f.login(),pending=f.post(admin);await until(()=>f.manager.jobs.has('boat-01'));f.ack();const result=await pending;
  assert.equal((await f.call('/api/auth/session',{method:'DELETE',cookie:admin})).status,200);
  const stop=f.client.sent.at(-1);assert.equal(stop.topic,'boats/boat-01/control-command');assert.equal(stop.payload[28],4);assert.equal(stop.payload.readInt16LE(30),0);
  assert.equal((await f.post(admin,{action:'input',leaseId:result.json.leaseId,sequence:1,throttle:900})).status,401);
});

test('a session expiring while the request body arrives cannot acquire or publish controls',async t=>{
  const f=await apiFixture(t,{accountOptions:{sessionMs:100}}),admin=await f.login(),before=f.client.sent.length;
  const data=JSON.stringify({deviceId:'boat-01',clientId:CLIENT,action:'acquire',...INPUT});
  const code=await new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:f.port,path:'/api/cloud/control',method:'POST',agent:false,headers:{origin:'https://boat.test',cookie:admin,'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(data.slice(0,1));setTimeout(()=>{f.setTime(f.now()+101);req.end(data.slice(1));},10);
  });
  assert.equal(code,401);assert.equal(f.client.sent.length,before);assert.equal(f.manager.jobs.size,0);
});

test('closing the HTTP acquire before its acknowledgement sends a stop instead of leaving browserless control',async t=>{
  const f=await apiFixture(t),admin=await f.login(),data=JSON.stringify({deviceId:'boat-01',clientId:CLIENT,action:'acquire',...INPUT});
  const req=http.request({host:'127.0.0.1',port:f.port,path:'/api/cloud/control',method:'POST',agent:false,headers:{origin:'https://boat.test',cookie:admin,'content-type':'application/json','content-length':Buffer.byteLength(data)}});req.on('error',()=>{});req.end(data);
  await until(()=>f.manager.jobs.has('boat-01'));req.destroy();await until(()=>f.manager.jobs.get('boat-01')?.status==='stopping');
  const stop=f.client.sent.at(-1);assert.equal(stop.payload[28],4);assert.equal(stop.payload.readInt16LE(30),0);f.ack(stop);assert.equal(f.manager.jobs.size,0);
});

test('missing optional driving ACL leaves existing monitoring connected and cannot enable control',async t=>{
  const client=new MQTT(),normal=client.subscribe.bind(client);client.subscribe=(topics,options,callback)=>{
    if(topics.some(topic=>topic.includes('control-')))return callback(null,topics.map(topic=>({topic,qos:128})));
    normal(topics,options,callback);
  };
  const bridge=new CloudBridge({env:ENV,connect:()=>client,tickMs:60000});bridge.start();client.emit('connect');t.after(()=>bridge.stop());
  assert.equal(bridge.brokerConnected,true);assert.equal(bridge.controlSubscribed,false);assert.equal(bridge.acceptMessage('boats/boat-01/telemetry',telemetry()),true);
  assert.equal(bridge.get('boat-01').online,true);assert.throws(()=>bridge.claimControl('boat-01'),{status:503});
  const manager=new ControlService({bridge,pollMs:60000});t.after(()=>manager.close());
  const view=manager.snapshot('boat-01');assert.equal(view.ready,false);assert.equal(view.supported,false);assert.match(view.message,/驾驶主题订阅未就绪/);
});

test('missing or expired driving state is reported separately from telemetry and MQTT availability',t=>{
  const f=fixture(t);f.manager.caps.clear();
  let view=f.manager.snapshot('boat-01');assert.equal(view.ready,false);assert.equal(view.supported,false);assert.match(view.message,/尚未收到有效的船端驾驶状态/);
  assert.throws(()=>f.manager.acquire('boat-01','session-a',CLIENT,INPUT),{status:503});assert.equal(f.client.sent.length,0);
  f.setTime(f.now()+1001);view=f.manager.snapshot('boat-01');assert.match(view.message,/实时遥测未就绪或已超时/);
  f.client.emit('close');view=f.manager.snapshot('boat-01');assert.match(view.message,/云端 MQTT 通道未就绪/);assert.equal(view.ready,false);
});
