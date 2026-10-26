'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CloudBridge}=require('../server/cloud'),{createServer}=require('../server');
const P=require('../public/utils/uart4Protocol');
const ORIGIN='https://fleet.test',PASSWORD='fleet-test-password-fixture';
const ENV={BOAT_CLOUD_ENABLED:'1',BOAT_CLOUD_PASSWORD:PASSWORD,BOAT_CLOUD_ORIGIN:ORIGIN,BOAT_MQTT_URL:'mqtt://broker.test:1883'};

function payload({speed=1.25,target=2,heading=135,latitude=31.2,longitude=121.4,voltage=24.5,boatAge=10,rtkAge=20,motorAge=30,boatFlags=0x2f,rtkFlags=7}={}){
  const result=Buffer.alloc(176);
  for(const [offset,length,version,type]of [[0,64,1,1],[64,40,2,2],[104,36,2,3],[140,36,1,4]]){
    const frame=result.subarray(offset,offset+length);frame.set([0xa5,0x5a,version,type,length,3]);
    if(type===1)for(const base of [14,38]){frame[base]=7;frame.writeUInt16LE(Math.round(voltage*100),base+2);frame.writeUInt16LE(motorAge,base+20);}
    if(type===2){frame.writeInt16LE(Math.round(speed*1000),14);frame.writeUInt16LE(rtkAge,20);frame.writeInt32LE(Math.round(latitude*1e7),26);frame.writeInt32LE(Math.round(longitude*1e7),30);frame.writeUInt16LE(Math.round(heading*100),34);frame[36]=rtkFlags;}
    if(type===3){frame[5]=boatFlags;frame.writeInt16LE(Math.round(target*1000),14);frame.writeUInt16LE(Math.round(speed*1000),16);frame.writeUInt16LE(boatAge,20);frame.writeUInt16LE(Math.round(heading*100),28);frame[32]=2;frame[33]=3;}
    frame.writeUInt16LE(P.crc16CcittFalse(frame,2,length-4),length-2);
  }
  return result;
}
class FakeMQTT extends EventEmitter{subscribe(topics,options,callback){callback(null);}end(){}}
function fixture(t,options={}){
  let time=10000;const client=new FakeMQTT(),bridge=new CloudBridge({env:ENV,now:()=>time,connect:()=>client,tickMs:60000,...options});
  bridge.start();client.emit('connect');t.after(()=>bridge.stop());
  return {bridge,client,now:()=>time,setTime:value=>{time=value;},telemetry:(id,options)=>bridge.acceptMessage('boats/'+id+'/telemetry',payload(options))};
}
function request(port,route,{method='GET',body,cookie}={}){
  const data=body===undefined?undefined:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{origin:ORIGIN,...(cookie?{cookie}:{}),...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,headers:res.headers,raw,json});});
    });req.on('error',reject);req.end(data);
  });
}
async function apiFixture(t,{accountMode=false,apiOptions={},maxDevices,...options}={}){
  const f=fixture(t,maxDevices===undefined?{}:{maxDevices});let directory;
  const env={...ENV};
  if(accountMode){directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-fleet-test-'));Object.assign(env,{BOAT_ACCOUNTS_ENABLED:'1',BOAT_ACCOUNTS_ORIGIN:ORIGIN,BOAT_ADMIN_USERNAME:'fleet-admin',BOAT_ADMIN_PASSWORD:'fleet administrator fixture',BOAT_GUEST_USERNAME:'fleet-guest',BOAT_GUEST_PASSWORD:'654321',BOAT_ACCOUNTS_FILE:path.join(directory,'accounts.json')});}
  const server=createServer({env,cloud:f.bridge,apiOptions:{now:f.now,heartbeatMs:25,...apiOptions},accountOptions:{now:f.now},...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));if(directory)fs.rmSync(directory,{recursive:true,force:true});});
  const port=server.address().port,call=(route,options)=>request(port,route,options);
  return {...f,server,port,call,async login(role='admin',previous){const response=await call(accountMode?'/api/auth/login':'/api/cloud/login',{method:'POST',cookie:previous,body:accountMode?{username:role==='guest'?'fleet-guest':'fleet-admin',password:role==='guest'?'654321':'fleet administrator fixture'}:{password:PASSWORD}});assert.equal(response.status,200,response.raw);return response.headers['set-cookie'][0].split(';')[0];}};
}
function stream(port,cookie,route='/api/cloud/fleet/events'){
  return new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:route,agent:false,headers:{cookie}},res=>{
      const result={req,res,status:res.statusCode,events:[]};let raw='';
      res.on('data',chunk=>{raw+=chunk.toString();let boundary;while((boundary=raw.indexOf('\n\n'))>=0){const block=raw.slice(0,boundary);raw=raw.slice(boundary+2);const name=block.match(/^event: (.+)$/m),data=block.match(/^data: (.+)$/m);if(name&&data)result.events.push({event:name[1],data:JSON.parse(data[1])});}});
      resolve(result);
    });req.on('error',reject);
  });
}
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('Fleet stream timeout');await new Promise(resolve=>setTimeout(resolve,5));}}
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));

test('fleet summaries isolate two vessels and preserve independent source validity and expiry',t=>{
  const f=fixture(t);f.telemetry('boat-01',{speed:1.25,target:2,heading:135,boatAge:800,rtkAge:100,motorAge:200});
  f.telemetry('boat-02',{speed:2.4,target:2.8,heading:359.99,latitude:-20,longitude:-70,voltage:25.1});
  const first=f.bridge.fleetList().devices[0].summary,second=f.bridge.fleetList().devices[1].summary;
  assert.equal(first.speedMps,1.25);assert.equal(second.speedMps,2.4);assert.equal(first.headingDegrees,135);assert.equal(second.headingDegrees,359.99);assert.equal(second.latitude,-20);
  assert.equal(first.voltageV,24.5);assert.equal(second.voltageV,25.1);assert.equal(first.targetSpeedMps,2);assert.equal(first.controlMode,2);
  assert.equal(first.validUntil.speedMps,10200);assert.equal(first.validUntil.position,10900);assert.equal(first.validUntil.voltageV,10800);
  f.setTime(10200);const fallback=f.bridge.fleetList().devices[0].summary;
  assert.equal(fallback.speedMps,1.25);assert.equal(fallback.validUntil.speedMps,10900);assert.equal(fallback.validUntil.headingDegrees,10900);
  f.setTime(10800);assert.equal(f.bridge.fleetList().devices[0].summary.voltageV,null);
  f.setTime(10900);const expired=f.bridge.fleetList().devices[0].summary;assert.equal(expired.speedMps,null);assert.equal(expired.latitude,null);assert.equal(expired.headingDegrees,null);assert.equal(expired.targetSpeedMps,2);
  f.setTime(11000);assert.equal(f.bridge.fleetList().devices[0].summary,null);assert.equal(f.bridge.get('boat-01').online,true);
  f.setTime(13001);assert.equal(f.bridge.get('boat-01').online,false);
});

test('invalid RTK speed does not hide valid position or heading, invalid sources never become zero',t=>{
  const f=fixture(t);f.telemetry('partial',{boatFlags:0x20,rtkFlags:5,boatAge:0xffff,motorAge:0xffff});
  const summary=f.bridge.fleetList().devices[0].summary;
  assert.equal(summary.speedMps,null);assert.equal(summary.latitude,31.2);assert.equal(summary.headingDegrees,135);assert.equal(summary.voltageV,null);
  f.telemetry('partial',{boatFlags:0,rtkFlags:0,boatAge:0xffff,motorAge:0xffff});
  const invalid=f.bridge.fleetList().devices[0].summary;assert.equal(invalid.speedMps,null);assert.equal(invalid.headingDegrees,null);assert.equal(invalid.latitude,null);
});

test('offline and Broker loss discard summaries; retained and malformed data cannot restore them',t=>{
  const f=fixture(t);f.telemetry('boat-01');f.telemetry('boat-02');
  f.bridge.acceptMessage('boats/boat-01/status',Buffer.from('offline'));
  assert.equal(f.bridge.fleetList().devices[0].summary,null);assert.ok(f.bridge.fleetList().devices[1].summary);
  f.client.emit('close');assert.ok(f.bridge.fleetList().devices.every(device=>!device.online&&device.summary===null));
  f.client.emit('connect');assert.ok(f.bridge.fleetList().devices.every(device=>!device.online&&device.summary===null));
  f.bridge.acceptMessage('boats/boat-02/telemetry',payload(),{retain:true});f.bridge.acceptMessage('boats/boat-01/telemetry',Buffer.alloc(176));
  assert.ok(f.bridge.fleetList().devices.every(device=>device.summary===null));f.telemetry('boat-02');assert.ok(f.bridge.fleetList().devices[1].summary);
});

test('fleet snapshot and stream require authentication; guests may monitor all vessels',async t=>{
  const f=await apiFixture(t,{accountMode:true});
  for(const route of ['/api/cloud/fleet','/api/cloud/fleet/events'])assert.equal((await f.call(route)).status,401);
  const cookie=await f.login('guest');f.telemetry('boat-01');f.telemetry('boat-02',{speed:2.1});
  const snapshot=await f.call('/api/cloud/fleet',{cookie});assert.equal(snapshot.status,200);assert.equal(snapshot.json.devices.length,2);assert.equal(snapshot.json.serverTime,10000);assert.doesNotMatch(snapshot.raw,/payload|password|token/);
  const sse=await stream(f.port,cookie);t.after(()=>sse.req.destroy());await until(()=>sse.events.length===1);
  assert.equal(sse.events[0].event,'fleet');assert.equal(sse.events[0].data.devices.length,2);assert.equal(f.server.boatCloudApi.getClientCount(),1);
  const ended=new Promise(resolve=>sse.res.once('end',resolve));await f.call('/api/auth/session',{method:'DELETE',cookie});await ended;assert.equal(f.server.boatCloudApi.getClientCount(),0);
});

test('one fleet SSE coalesces vessel changes while selected detail remains isolated; offline is immediate',async t=>{
  const f=await apiFixture(t),cookie=await f.login();f.telemetry('boat-01');f.telemetry('boat-02');
  const all=await stream(f.port,cookie),detail=await stream(f.port,cookie,'/api/cloud/events?device=boat-01');t.after(()=>{all.req.destroy();detail.req.destroy();});
  await until(()=>all.events.length===1&&detail.events.length===1);
  f.setTime(10100);f.telemetry('boat-02',{speed:2.4});f.setTime(10200);f.telemetry('boat-02',{speed:2.5});await tick();
  assert.equal(all.events.length,1);assert.equal(detail.events.length,1);
  f.setTime(10250);f.telemetry('boat-02',{speed:2.6});await until(()=>all.events.length===2);
  assert.equal(all.events[1].event,'fleet-device');assert.equal(all.events[1].data.device.id,'boat-02');assert.equal(all.events[1].data.device.summary.speedMps,2.6);
  f.setTime(10260);f.telemetry('boat-02',{speed:2.7});f.bridge.acceptMessage('boats/boat-02/status',Buffer.from('offline'));
  await until(()=>all.events.length===3);assert.equal(all.events[2].data.device.summary,null);assert.equal(all.events[2].data.device.online,false);assert.equal(detail.events.length,1);
  f.client.emit('close');await until(()=>all.events.some(event=>event.event==='fleet'&&!event.data.brokerConnected));
  assert.ok(all.events.at(-1).data.devices.every(device=>device.summary===null));
});

test('fleet initial/reconnect snapshots remove evicted boats instead of accumulating old identities',async t=>{
  const f=await apiFixture(t,{maxDevices:2}),cookie=await f.login();f.telemetry('boat-01');f.telemetry('boat-02');
  const all=await stream(f.port,cookie);t.after(()=>all.req.destroy());await until(()=>all.events.length===1);
  f.setTime(14000);f.telemetry('boat-03',{speed:2.1});await until(()=>all.events.some(event=>event.event==='fleet'&&event.data.devices.some(device=>device.id==='boat-03')));
  const replacement=all.events.filter(event=>event.event==='fleet').at(-1).data;
  assert.equal(replacement.devices.length,2);assert.deepEqual(replacement.devices.map(device=>device.id),['boat-02','boat-03']);
  assert.equal(replacement.devices[0].summary,null);assert.equal(replacement.devices[1].summary.speedMps,2.1);
  const fresh=await stream(f.port,cookie);t.after(()=>fresh.req.destroy());await until(()=>fresh.events.length===1);assert.deepEqual(fresh.events[0].data.devices.map(device=>device.id),['boat-02','boat-03']);
});

test('fleet includes 64 vessels in one bounded initial SSE snapshot without high-water reconnect loops',async t=>{
  const f=await apiFixture(t),cookie=await f.login();for(let i=0;i<64;i++)f.telemetry('boat-'+String(i).padStart(2,'0')+'x'.repeat(50));
  const all=await stream(f.port,cookie);t.after(()=>all.req.destroy());await until(()=>all.events.length===1);
  assert.equal(all.events[0].data.devices.length,64);assert.ok(Buffer.byteLength(JSON.stringify(all.events[0].data))>16384);
  await tick();assert.equal(f.server.boatCloudApi.getClientCount(),1);assert.equal(all.res.complete,false);
});

test('fleet and detail share stream quotas and account switches invalidate the old fleet',async t=>{
  const f=await apiFixture(t,{accountMode:true,apiOptions:{maxClientsPerSession:1}}),cookie=await f.login();
  const all=await stream(f.port,cookie);t.after(()=>all.req.destroy());await until(()=>all.events.length===1);
  assert.equal((await f.call('/api/cloud/events?device=boat-01',{cookie})).status,503);assert.equal((await f.call('/api/cloud/fleet/events',{cookie})).status,503);
  const ended=new Promise(resolve=>all.res.once('end',resolve));const guest=await f.login('guest',cookie);await ended;
  assert.equal(f.server.boatCloudApi.getClientCount(),0);assert.equal((await f.call('/api/cloud/fleet',{cookie})).status,401);assert.equal((await f.call('/api/cloud/fleet',{cookie:guest})).status,200);
});

test('fleet fallback supports injected bridge implementations with only the original list API',async t=>{
  const bridge=new EventEmitter();Object.assign(bridge,{enabled:true,start(){},stop(){},list:()=>({brokerConnected:true,devices:[{id:'injected',online:true}]}),state:()=>({brokerConnected:true,device:null})});
  const server=createServer({env:ENV,cloud:bridge});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port,login=await request(port,'/api/cloud/login',{method:'POST',body:{password:PASSWORD}}),cookie=login.headers['set-cookie'][0].split(';')[0];
  const response=await request(port,'/api/cloud/fleet',{cookie});assert.equal(response.status,200);assert.deepEqual(response.json.devices,[{id:'injected',online:true,summary:null}]);
});
