'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),http=require('node:http');
const {CloudBridge}=require('../server/cloud'),{createServer}=require('../server');
const PP=require('../server/parameter-protocol'),P=require('../public/utils/uart4Protocol');
const ENV={BOAT_CLOUD_ENABLED:'1',BOAT_CLOUD_PASSWORD:'legacy-test-password-fixture',BOAT_CLOUD_ORIGIN:'https://boat.test',BOAT_MQTT_URL:'mqtt://broker.test:1883'};
const ACCOUNT_ENV={...ENV,BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'test-admin',BOAT_ADMIN_PASSWORD:'test admin password',BOAT_GUEST_USERNAME:'test-guest',BOAT_GUEST_PASSWORD:'654321'};
const TOKEN='0123456789abcdef',NEXT='fedcba9876543210';
const VALUES=Object.fromEntries(Object.entries(PP.RANGES).map(([key,[min]])=>[key,min]));
function telemetry(){const result=Buffer.alloc(176);for(const [offset,length,version,type]of [[0,64,1,1],[64,40,2,2],[104,36,2,3],[140,36,1,4]]){const frame=result.subarray(offset,offset+length);frame.set([0xa5,0x5a,version,type,length]);frame.writeUInt16LE(P.crc16CcittFalse(frame,2,length-4),length-2);}return result;}
class FakeMQTT extends EventEmitter{constructor(){super();this.sent=[];this.connected=true;}subscribe(topics,options,callback){this.topics=topics;callback(null);}publish(topic,payload,options,callback){this.sent.push({topic,payload:Buffer.from(payload),options});if(this.onPublish)this.onPublish(this.sent.at(-1));callback?.(this.publishError);}end(){}}
function bridgeFixture(t,options={}){let time=10000;const client=new FakeMQTT(),bridge=new CloudBridge({env:ENV,now:()=>time,connect:()=>client,tickMs:60000,...options});bridge.start();client.emit('connect');t.after(()=>bridge.stop());
  return {bridge,client,now:()=>time,setTime:value=>{time=value;},cap(token=TOKEN,uptimeMs=5000,id='boat-01',packet={}){return bridge.acceptMessage('boats/'+id+'/parameter-capability',Buffer.from(JSON.stringify({version:1,token,uptimeMs})),packet);},live(id='boat-01'){bridge.acceptMessage('boats/'+id+'/telemetry',telemetry());},response(command=client.sent.at(-1),{status=0,sequence,token,uptimeMs,values=VALUES}={}){
    const result=Buffer.from(command.payload);const frame=Buffer.from(P.encodeParameterWriteRequest(sequence??command.payload.readUInt32LE(22),values));frame[3]=0x90;frame[5]=status;frame.writeUInt16LE(P.crc16CcittFalse(frame,2,52),54);frame.copy(result,16);if(token)Buffer.from(token,'hex').copy(result,4);if(uptimeMs!==undefined)result.writeUInt32LE(uptimeMs,12);return result;
  }};
}
function request(port,route,{method='GET',cookie,origin='https://boat.test',body,raw,headers={}}={}){const data=raw!==undefined?raw:body===undefined?undefined:JSON.stringify(body);return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...(data!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...(cookie?{cookie}:{}),...(origin?{origin}:{}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,json,raw,headers:res.headers});});});req.on('error',reject);req.end(data);});}
async function apiFixture(t,{accounts=true,accountOptions={},...bridgeOptions}={}){
  const f=bridgeFixture(t,bridgeOptions),env=accounts?ACCOUNT_ENV:ENV;
  const server=createServer({env,cloud:f.bridge,accountOptions:{now:f.now,...accountOptions},apiOptions:{now:f.now}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;return {...f,port,server,call:(route,options)=>request(port,route,options),async login(role='admin'){const response=await request(port,accounts?'/api/auth/login':'/api/cloud/login',{method:'POST',body:accounts?{username:role==='admin'?'test-admin':'test-guest',password:role==='admin'?'test admin password':'654321'}:{password:ENV.BOAT_CLOUD_PASSWORD}});assert.equal(response.status,200,response.raw);return response.headers['set-cookie'][0].split(';')[0];},operate:(cookie,body={deviceId:'boat-01',kind:'read'},extra={})=>request(port,'/api/cloud/parameters',{method:'POST',cookie,body,...extra})};
}
async function until(predicate){const end=Date.now()+1000;while(!predicate()){if(Date.now()>end)throw Error('Timed out');await new Promise(resolve=>setTimeout(resolve,2));}}

test('BPC1 protocol validates exact capability, complete typed ranges and CRC response',()=>{
  const cap=Buffer.from(JSON.stringify({version:1,token:TOKEN,uptimeMs:0xffffffff}));assert.deepEqual(PP.capability(cap),{token:TOKEN,uptimeMs:0xffffffff});
  for(const value of [{version:2,token:TOKEN,uptimeMs:1},{version:1,token:TOKEN.toUpperCase(),uptimeMs:1},{version:1,token:[TOKEN],uptimeMs:1},{version:1,token:TOKEN,uptimeMs:-1},{version:1,token:TOKEN,uptimeMs:2**32},{version:1,token:TOKEN,uptimeMs:1,extra:true}])assert.equal(PP.capability(Buffer.from(JSON.stringify(value))),null);
  for(const values of [{}, {...VALUES,kpX2PerMps:'1'}, {...VALUES,motor1Reversed:2},{...VALUES,maxTargetMmS:99},{...VALUES,targetSlewStepMmS:401},{...VALUES,extra:1}])assert.throws(()=>PP.commandFrame('write',1,values));
  assert.throws(()=>PP.commandFrame('read',1,VALUES));assert.throws(()=>PP.commandFrame('control',1));
  const frame=PP.commandFrame('write',0x12345678,VALUES),packet=PP.envelope(TOKEN,123,frame);assert.equal(packet.length,72);assert.equal(packet.toString('ascii',0,4),'BPC1');assert.equal(packet.subarray(4,12).toString('hex'),TOKEN);assert.equal(packet.readUInt32LE(12),123);assert.equal(packet.readUInt32LE(22),0x12345678);assert.equal(PP.response(packet),null);
});

test('only fresh nonretained telemetry and capabilities make a device parameter-ready',async t=>{
  const f=bridgeFixture(t);f.live();assert.equal(f.bridge.get('boat-01').parametersReady,false);assert.equal(f.cap(TOKEN,1,'boat-01',{retain:true}),false);assert.equal(f.bridge.get('boat-01').parametersReady,false);
  f.cap();assert.equal(f.bridge.get('boat-01').parametersReady,true);f.setTime(f.now()+2500);assert.equal(f.bridge.get('boat-01').parametersReady,true);f.setTime(f.now()+1);assert.equal(f.bridge.get('boat-01').parametersReady,false);
  await assert.rejects(f.bridge.requestParameters('boat-01','read'),{status:503});assert.equal(f.client.sent.length,0);
});

test('single-device transactions use server sequence and require exact device/token/uptime/CRC response',async t=>{
  const f=bridgeFixture(t);f.live();f.cap();const promise=f.bridge.requestParameters('boat-01','read'),command=f.client.sent[0];
  assert.equal(command.topic,'boats/boat-01/parameter-command');assert.deepEqual(command.options,{qos:0,retain:false});assert.equal(command.payload.length,72);assert.equal(command.payload[19],0x10);assert.equal(f.bridge.get('boat-01').parametersReady,false);
  await assert.rejects(f.bridge.requestParameters('boat-01','read'),{status:409});assert.equal(f.client.sent.length,1);
  const response=f.response(command);assert.equal(f.bridge.acceptMessage('boats/other/parameter-response',response),false);assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',response,{retain:true}),false);
  for(const invalid of [f.response(command,{token:NEXT}),f.response(command,{uptimeMs:1}),f.response(command,{sequence:command.payload.readUInt32LE(22)+1}),Buffer.from(response.subarray(1))])assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',invalid),false);
  const bad=Buffer.from(response);bad[30]^=1;assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',bad),false);
  const badRange=Buffer.from(response);badRange.writeUInt16LE(201,16+14);badRange.writeUInt16LE(P.crc16CcittFalse(badRange.subarray(16),2,52),70);assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',badRange),false);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',response),true);assert.deepEqual(await promise,response.subarray(16));assert.equal(f.bridge.get('boat-01').parametersReady,false);
  f.cap(TOKEN,5100);assert.equal(f.bridge.get('boat-01').parametersReady,false);f.cap(NEXT,5200);assert.equal(f.bridge.get('boat-01').parametersReady,true);
});

test('write/Flash use full values, preserve device rejection and never claim MQTT publish success as completion',async t=>{
  const f=bridgeFixture(t);f.live();f.cap();const promise=f.bridge.requestParameters('boat-01','write',VALUES);let done=false;promise.then(()=>{done=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.equal(f.client.sent[0].payload[19],0x11);
  const denied=f.response(undefined,{status:3});f.bridge.acceptMessage('boats/boat-01/parameter-response',denied);assert.equal((await promise)[5],3);
  f.cap(NEXT,5200);const flash=f.bridge.requestParameters('boat-01','flash',VALUES);assert.equal(f.client.sent.at(-1).payload[19],0x12);f.bridge.acceptMessage('boats/boat-01/parameter-response',f.response());await flash;
});

test('timeouts consume their token, never retry, and late responses cannot finish a newer operation',async t=>{
  const f=bridgeFixture(t,{parameterTimeoutMs:15,flashTimeoutMs:70});f.live();f.cap();const timed=f.bridge.requestParameters('boat-01','read'),old=f.client.sent[0];await assert.rejects(timed,{status:504});assert.equal(f.client.sent.length,1);await assert.rejects(f.bridge.requestParameters('boat-01','read'),{status:503});
  f.cap(NEXT,5300);const current=f.bridge.requestParameters('boat-01','read');assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',f.response(old)),false);f.bridge.acceptMessage('boats/boat-01/parameter-response',f.response());await current;
  f.cap('0000000000000001',5500);const flash=f.bridge.requestParameters('boat-01','flash',VALUES);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.bridge.pendingParameters.size,1);f.bridge.acceptMessage('boats/boat-01/parameter-response',f.response());await flash;
});

test('disconnect, offline, token change, freshness loss and explicit cancellation abort pending operations',async t=>{
  for(const cause of ['disconnect','offline','token','stale','abort']){
    const f=bridgeFixture(t);f.live();f.cap();const controller=new AbortController(),pending=f.bridge.requestParameters('boat-01','read',undefined,{signal:controller.signal}),rejected=assert.rejects(pending,error=>[409,503].includes(error.status));
    if(cause==='disconnect')f.client.emit('close');else if(cause==='offline')f.bridge.acceptMessage('boats/boat-01/status',Buffer.from('offline'));else if(cause==='token')f.cap(NEXT,6000);else if(cause==='stale'){f.setTime(f.now()+2501);f.bridge.refresh();}else controller.abort();
    await rejected;assert.equal(f.bridge.pendingParameters.size,0);assert.equal(f.client.sent.length,1);
  }
});

test('publish failure consumes the token and a stale publish callback cannot cancel the next transaction',async t=>{
  const f=bridgeFixture(t);f.live();f.cap();f.client.publishError=Error('send failed');await assert.rejects(f.bridge.requestParameters('boat-01','read'),{status:503});assert.equal(f.bridge.get('boat-01').parametersReady,false);assert.equal(f.client.sent.length,1);
  f.client.publishError=null;const callbacks=[];f.client.publish=(topic,payload,options,callback)=>{f.client.sent.push({topic,payload:Buffer.from(payload),options});callbacks.push(callback);};
  f.cap(NEXT,5100);const first=f.bridge.requestParameters('boat-01','read');f.bridge.acceptMessage('boats/boat-01/parameter-response',f.response());await first;
  f.cap('0000000000000001',5200);const next=f.bridge.requestParameters('boat-01','read');callbacks[0](Error('late publish callback'));assert.equal(f.bridge.pendingParameters.size,1);f.bridge.acceptMessage('boats/boat-01/parameter-response',f.response());await next;
});

test('different devices may operate concurrently without exchanging responses',async t=>{
  const f=bridgeFixture(t);f.live();f.cap();f.live('boat-02');f.cap(NEXT,5100,'boat-02');
  const first=f.bridge.requestParameters('boat-01','read'),second=f.bridge.requestParameters('boat-02','read');assert.equal(f.client.sent.length,2);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',f.response(f.client.sent[1])),false);f.bridge.acceptMessage('boats/boat-02/parameter-response',f.response(f.client.sent[1]));await second;assert.equal(f.bridge.pendingParameters.size,1);f.bridge.acceptMessage('boats/boat-01/parameter-response',f.response(f.client.sent[0]));await first;
});

test('cloud parameter HTTP requires shared admin and same origin and validates body before MQTT',async t=>{
  const f=await apiFixture(t),admin=await f.login(),guest=await f.login('guest');f.live();f.cap();
  assert.equal((await f.operate(undefined)).status,401);assert.equal((await f.operate(guest)).status,403);assert.equal((await f.operate(admin,undefined,{origin:'https://evil.test'})).status,403);
  for(const body of [{deviceId:'../boat',kind:'read'},{deviceId:'boat-01',kind:'write',values:{...VALUES,kpX2PerMps:1001}},{deviceId:'boat-01',kind:'read',values:VALUES},{deviceId:'boat-01',kind:'read',command:'bad'}])assert.equal((await f.operate(admin,body)).status,400);
  assert.equal((await f.operate(admin,{padding:'x'.repeat(2100)})).status,413);assert.equal(f.client.sent.length,0);
  const legacy=await apiFixture(t,{accounts:false}),oldCookie=await legacy.login();assert.equal((await legacy.operate(oldCookie)).status,403);assert.equal(legacy.client.sent.length,0);
});

test('admin API returns only a real matching response and isolates another administrator',async t=>{
  const f=await apiFixture(t),first=await f.login(),second=await f.login();f.live();f.cap();
  const waiting=f.operate(first,{deviceId:'boat-01',kind:'write',values:VALUES});await until(()=>f.client.sent.length===1);assert.equal((await f.operate(second)).status,409);
  const response=f.response(undefined,{status:2});f.bridge.acceptMessage('boats/boat-01/parameter-response',response);const result=await waiting;assert.equal(result.status,200);assert.equal(result.json.serverTime,f.now());assert.deepEqual(Buffer.from(result.json.frame,'base64'),response.subarray(16));
  assert.equal((await f.call('/api/cloud/devices',{cookie:second})).json.devices[0].parametersReady,false);
});

test('logout cancels an in-flight HTTP transaction and blocks any late device response',async t=>{
  const f=await apiFixture(t),cookie=await f.login();f.live();f.cap();const pending=f.operate(cookie);await until(()=>f.client.sent.length===1);const response=f.response();
  await f.call('/api/auth/session',{method:'DELETE',cookie});const result=await pending;assert.equal(result.status,409);assert.equal(f.bridge.pendingParameters.size,0);assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',response),false);
});

test('session expiry while a body is arriving cannot publish a parameter command',async t=>{
  const f=await apiFixture(t,{accountOptions:{sessionMs:100}}),cookie=await f.login();f.live();f.cap();
  const result=await new Promise((resolve,reject)=>{const data=JSON.stringify({deviceId:'boat-01',kind:'read'}),req=http.request({host:'127.0.0.1',port:f.port,path:'/api/cloud/parameters',method:'POST',agent:false,headers:{origin:'https://boat.test',cookie,'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(data.slice(0,1));setTimeout(()=>{f.setTime(f.now()+101);req.end(data.slice(1));},20);});
  assert.equal(result,401);assert.equal(f.client.sent.length,0);
});
