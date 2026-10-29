'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),http=require('node:http');
const {CloudBridge,validateTelemetry}=require('../server/cloud');
const {createCloudApi}=require('../server/cloud-api');
const {createServer}=require('../server');
const P=require('../public/utils/uart4Protocol');
const PASSWORD='test-password-not-a-real-secret';
const ENV={BOAT_CLOUD_ENABLED:'1',BOAT_CLOUD_PASSWORD:PASSWORD,BOAT_CLOUD_ORIGIN:'https://boat.test',BOAT_MQTT_URL:'mqtt://broker.test:1883'};
function payload(sequence=1){
  const result=Buffer.alloc(176);
  for(const [offset,length,version,type]of [[0,64,1,1],[64,40,2,2],[104,36,2,3],[140,36,1,4]]){
    const frame=result.subarray(offset,offset+length);frame.set([0xa5,0x5a,version,type,length,3]);
    frame.writeUInt32LE(sequence,6);frame.writeUInt32LE(5000,10);
    if(type===2)frame.writeUInt16LE(1800,20); // 源数据已旧，云桥不得将年龄清零。
    if(type===4)frame.writeUInt16LE(1500,26);
    frame.writeUInt16LE(P.crc16CcittFalse(frame,2,length-4),length-2);
  }
  return result;
}
class FakeMQTT extends EventEmitter{
  subscribe(topics,options,callback){(this.subscriptions??=[]).push({topics,options});callback(null);}
  end(force){this.ended=force;}
}
function fixture(options={}){
  let time=10000;const client=new FakeMQTT();let connection;
  const bridge=new CloudBridge({env:ENV,now:()=>time,tickMs:60000,connect:(url,opts)=>{connection={url,opts};return client;},...options});
  return {bridge,client,now:()=>time,setTime:value=>{time=value;},get connection(){return connection;}};
}
function request(port,path,{method='GET',body,cookie,origin='https://boat.test',headers={}}={}){
  const data=body===undefined?undefined:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,method,headers:{...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...(cookie?{cookie}:{}),...(origin?{origin}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(raw);}catch(_){}
        resolve({status:res.statusCode,headers:res.headers,raw,json});
      });
    });req.on('error',reject);req.end(data);
  });
}
async function serverFixture(t,{apiOptions={},...options}={}){
  const f=fixture(options);const server=createServer({env:ENV,cloud:f.bridge,apiOptions:{now:f.now,...apiOptions}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.client.emit('connect');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  async function login(){const response=await request(port,'/api/cloud/login',{method:'POST',body:{password:PASSWORD}});assert.equal(response.status,200);return response.headers['set-cookie'][0].split(';')[0];}
  return {...f,server,port,login};
}
function openStream(port,cookie,device='boat-01'){
  return new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:'/api/cloud/events?device='+encodeURIComponent(device),headers:{cookie}},res=>{
      let raw='';const events=[];
      res.on('data',chunk=>{raw+=chunk.toString();let boundary;while((boundary=raw.indexOf('\n\n'))>=0){const block=raw.slice(0,boundary);raw=raw.slice(boundary+2);const event=block.match(/^event: (.+)$/m),data=block.match(/^data: (.+)$/m);if(event&&data)events.push({event:event[1],data:JSON.parse(data[1])});}});
      const stream={status:res.statusCode,headers:res.headers,events,req,res};resolve(stream);
    });req.on('error',reject);
  });
}
async function until(predicate){const end=Date.now()+1500;while(!predicate()){if(Date.now()>end)throw Error('Timed out waiting for stream event');await new Promise(resolve=>setTimeout(resolve,5));}}

test('cloud disabled starts without importing mqtt and exposes no protected data',async t=>{
  const server=createServer({env:{}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port,config=await request(port,'/api/cloud/config');
  assert.equal(config.json.enabled,false);assert.equal(config.json.requiresLogin,false);assert.equal(typeof config.json.serverTime,'number');
  assert.equal((await request(port,'/api/cloud/devices')).status,503);
  assert.equal((await request(port,'/healthz')).json.app,'unmanned-boat-web');
});

test('strict 176-byte UART4 layout validates all frame CRCs and types',()=>{
  const original=payload();assert.equal(validateTelemetry(original),true);
  for(const offset of [0,64,104,140]){const broken=Buffer.from(original);broken[offset+14]^=1;assert.equal(validateTelemetry(broken),false);}
  const duplicate=Buffer.from(original);original.copy(duplicate,140,104,140);assert.equal(validateTelemetry(duplicate),false);
  assert.equal(validateTelemetry(original.subarray(1)),false);assert.equal(validateTelemetry(Buffer.concat([original,Buffer.from([0])])),false);
});

test('bridge ignores retained/malformed telemetry, preserves source ages and bounds device memory',()=>{
  const f=fixture({maxDevices:2});f.bridge.start();f.client.emit('connect');
  assert.deepEqual(f.client.subscriptions.map(item=>item.topics),[
    ['boats/+/telemetry','boats/+/status','boats/+/parameter-capability','boats/+/parameter-response'],
    ['boats/+/video']
  ]);
  for(const subscription of f.client.subscriptions)assert.deepEqual(subscription.options,{qos:0,rap:true});
  assert.equal(f.connection.opts.protocolVersion,5);
  assert.equal(f.connection.opts.queueQoSZero,false);
  const events=[];f.bridge.on('telemetry',value=>events.push(value));
  assert.equal(f.bridge.acceptMessage('boats/boat-01/telemetry',payload(),{retain:true}),false);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/telemetry',Buffer.alloc(176)),false);
  assert.equal(f.bridge.acceptMessage('boats/invalid.id/telemetry',payload()),false);
  assert.equal(f.bridge.list().devices.length,0);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/telemetry',payload()),true);
  const raw=Buffer.from(events[0].payload,'base64');
  assert.deepEqual(raw,payload());assert.equal(P.decodeVelocityFrame(raw.subarray(64,104)).velocity.ageMs,1800);
  assert.equal(P.decodeImuFrame(raw.subarray(140)).imu.ageMs,1500);assert.equal(events[0].ageMs,0);
  f.bridge.acceptMessage('boats/boat-02/telemetry',payload());
  assert.equal(f.bridge.acceptMessage('boats/boat-03/telemetry',payload()),false);assert.equal(f.bridge.list().devices.length,2);
  f.setTime(14001);f.bridge.refresh();f.bridge.acceptMessage('boats/boat-03/telemetry',payload());
  assert.equal(f.bridge.list().devices.length,2);assert.ok(f.bridge.get('boat-03').online);
  f.bridge.stop();assert.equal(f.client.ended,true);
});

test('retained online cannot make an old device live, broker reconnection requires new telemetry',()=>{
  const f=fixture();f.bridge.start();f.client.emit('connect');
  f.bridge.acceptMessage('boats/boat-01/status',Buffer.from('online'),{retain:true});assert.equal(f.bridge.get('boat-01').online,false);
  f.bridge.acceptMessage('boats/boat-01/telemetry',payload());assert.equal(f.bridge.get('boat-01').online,true);
  f.client.emit('close');assert.equal(f.bridge.get('boat-01').online,false);
  f.client.emit('connect');assert.equal(f.bridge.get('boat-01').online,false);
  f.bridge.acceptMessage('boats/boat-01/telemetry',payload(2));assert.equal(f.bridge.get('boat-01').online,true);
  f.setTime(13001);f.bridge.refresh();assert.equal(f.bridge.get('boat-01').online,false);
  f.bridge.stop();
});

test('rejected subscriptions and callbacks from an old connection never mark broker ready',()=>{
  const f=fixture(),callbacks=[];
  f.client.subscribe=(topics,options,callback)=>callbacks.push(callback);
  f.bridge.start();f.client.emit('connect');
  callbacks[0](null,[{qos:128}]);assert.equal(f.bridge.brokerConnected,false);
  callbacks[0](null,[{qos:0x87}]);assert.equal(f.bridge.brokerConnected,false);
  f.client.emit('connect');f.client.emit('close');callbacks[1](null,[{qos:0}]);
  assert.equal(f.bridge.brokerConnected,false);
  f.client.emit('connect');callbacks[2](null,[{qos:0}]);assert.equal(f.bridge.brokerConnected,true);
  f.bridge.stop();
});

test('optional video subscription rejection preserves telemetry and stale video callbacks cannot change readiness',()=>{
  const f=fixture(),subscriptions=[];
  f.client.subscribe=(topics,options,callback)=>subscriptions.push({topics,callback});
  f.bridge.start();f.client.emit('connect');
  assert.equal(subscriptions.length,1);assert.equal(f.bridge.brokerConnected,false);
  subscriptions[0].callback(null,[{qos:0},{qos:0},{qos:0},{qos:0}]);
  assert.equal(f.bridge.brokerConnected,true);assert.deepEqual(subscriptions[1].topics,['boats/+/video']);
  for(const rejection of [128,0x87]){
    subscriptions[1].callback(null,[{qos:rejection}]);assert.equal(f.bridge.brokerConnected,true);
  }
  subscriptions[1].callback(Error('video subscription denied'));assert.equal(f.bridge.brokerConnected,true);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/telemetry',payload()),true);
  assert.equal(f.bridge.get('boat-01').online,true);
  f.client.emit('close');f.client.emit('connect');
  subscriptions[1].callback(null,[{qos:0}]);assert.equal(f.bridge.brokerConnected,false);
  subscriptions[1].callback(null,[{qos:128}]);assert.equal(f.bridge.brokerConnected,false);
  subscriptions[2].callback(null,[{qos:0}]);assert.equal(f.bridge.brokerConnected,true);
  subscriptions[1].callback(Error('old video callback'));assert.equal(f.bridge.brokerConnected,true);
  f.bridge.stop();subscriptions[3].callback(null,[{qos:0}]);assert.equal(f.bridge.brokerConnected,false);
});

test('optional video subscription throwing synchronously does not disconnect the required topics',()=>{
  const f=fixture();
  f.client.subscribe=(topics,options,callback)=>{
    if(topics[0]==='boats/+/video')throw Error('video subscription unavailable');
    callback(null,[{qos:0}]);
  };
  f.bridge.start();assert.doesNotThrow(()=>f.client.emit('connect'));assert.equal(f.bridge.brokerConnected,true);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/telemetry',payload()),true);
  assert.equal(f.bridge.get('boat-01').online,true);f.bridge.stop();
});

test('same-origin password login, HttpOnly secure cookie, logout and rate limit',async t=>{
  const f=await serverFixture(t);
  assert.equal((await request(f.port,'/api/cloud/devices')).status,401);
  assert.equal((await request(f.port,'/api/cloud/login',{method:'POST',body:{password:PASSWORD},origin:'https://evil.test'})).status,403);
  assert.equal((await request(f.port,'/api/cloud/login',{method:'POST',body:{password:'wrong'}})).status,401);
  const login=await request(f.port,'/api/cloud/login',{method:'POST',body:{password:PASSWORD}});
  const cookie=login.headers['set-cookie'][0];assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Secure/);
  assert.equal((await request(f.port,'/api/cloud/config',{cookie})).json.requiresLogin,false);
  const devices=await request(f.port,'/api/cloud/devices',{cookie});assert.equal(devices.status,200);assert.equal(devices.json.serverTime,f.now());
  assert.equal((await request(f.port,'/api/cloud/session',{method:'DELETE',cookie,origin:'https://evil.test'})).status,403);
  assert.equal((await request(f.port,'/api/cloud/session',{method:'DELETE',cookie})).status,200);
  assert.equal((await request(f.port,'/api/cloud/devices',{cookie})).status,401);
  for(let i=0;i<6;i++)await request(f.port,'/api/cloud/login',{method:'POST',body:{password:'wrong'}});
  assert.equal((await request(f.port,'/api/cloud/login',{method:'POST',body:{password:PASSWORD}})).status,429);
});

test('SSE never replays cached telemetry, isolates device events and stops on logout',async t=>{
  const f=await serverFixture(t),cookie=await f.login();
  f.bridge.acceptMessage('boats/boat-01/telemetry',payload());
  const stream=await openStream(f.port,cookie);t.after(()=>stream.req.destroy());
  assert.equal(stream.status,200);assert.equal(stream.headers['x-accel-buffering'],'no');
  await until(()=>stream.events.length>0);assert.deepEqual(stream.events.map(event=>event.event),['state']);
  f.bridge.acceptMessage('boats/boat-02/telemetry',payload());
  f.bridge.acceptMessage('boats/boat-01/telemetry',payload(2));
  await until(()=>stream.events.some(event=>event.event==='telemetry'));
  const messages=stream.events.filter(event=>event.event==='telemetry');assert.equal(messages.length,1);assert.equal(messages[0].data.deviceId,'boat-01');
  assert.equal(Buffer.from(messages[0].data.payload,'base64').length,176);
  f.client.emit('close');await until(()=>stream.events.some(event=>event.event==='state'&&!event.data.brokerConnected));
  const ended=new Promise(resolve=>stream.res.once('end',resolve));
  await request(f.port,'/api/cloud/session',{method:'DELETE',cookie});await ended;
  assert.equal(f.server.boatCloudApi.getClientCount(),0);
});

test('SSE/session bounds, expiry and shutdown release all listeners',async t=>{
  const f=await serverFixture(t,{apiOptions:{maxClients:1,maxClientsPerSession:1,maxSessions:1,sessionMs:100,heartbeatMs:10}}),cookie=await f.login();
  const second=await request(f.port,'/api/cloud/login',{method:'POST',body:{password:PASSWORD}});assert.equal(second.status,503);
  const stream=await openStream(f.port,cookie);t.after(()=>stream.req.destroy());
  assert.equal((await request(f.port,'/api/cloud/events?device=boat-02',{cookie})).status,503);
  assert.equal((await request(f.port,'/api/cloud/events?device=invalid%2Ftopic',{cookie})).status,400);
  const ended=new Promise(resolve=>stream.res.once('end',resolve));f.setTime(f.now()+101);await ended;
  assert.equal(f.server.boatCloudApi.getClientCount(),0);assert.equal((await request(f.port,'/api/cloud/devices',{cookie})).status,401);
  f.server.boatCloudApi.close();assert.equal(f.bridge.listenerCount('telemetry'),0);assert.equal(f.bridge.listenerCount('state'),0);
});

test('SSE immediately disconnects backpressured clients instead of buffering telemetry',async()=>{
  const f=fixture();f.bridge.start();f.client.emit('connect');
  const api=createCloudApi({bridge:f.bridge,env:ENV});
  function exchange(method,path,cookie,body){
    const req=new EventEmitter();Object.assign(req,{method,headers:{origin:'https://boat.test',host:'boat.test',cookie,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'},setTimeout(){}});
    req[Symbol.asyncIterator]=async function*(){yield Buffer.from(JSON.stringify(body));};
    const res=new EventEmitter();Object.assign(res,{headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);},end(){this.writableEnded=true;},write(){return false;},flushHeaders(){},setTimeout(){}});
    return {req,res,url:new URL(path,'https://boat.test')};
  }
  const login=exchange('POST','/api/cloud/login',undefined,{password:PASSWORD});await api.handle(login.req,login.res,login.url);
  const sse=exchange('GET','/api/cloud/events?device=boat-01',login.res.headers['Set-Cookie']);await api.handle(sse.req,sse.res,sse.url);
  assert.equal(sse.res.writableEnded,true);assert.equal(api.getClientCount(),0);api.close();f.bridge.stop();
});

module.exports={payload};
