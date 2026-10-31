'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createMissionFixture,ORIGIN,CLIENT}=require('./mission-fixture.cjs');
const N=require('../public/utils/missionNavigation'),{MissionStore,normalizeRoute}=require('../server/mission-store'),{MissionService}=require('../server/mission-service');
const coords=require('../public/utils/mapCoordinates');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<120;n++){if(check())return;await wait(5);}throw Error('Mission condition timed out');}
function fixture(t,options){const f=createMissionFixture(options);t.after(()=>f.close());return f;}
async function running(f,route=f.route(),action='start'){f.mission.start('boat-01',route.id,action);await until(()=>f.mission.snapshot('boat-01').status==='running');return f.mission.jobs.get('boat-01');}
async function flush(f){await Promise.resolve();await Promise.resolve();f.mission.refresh();}

test('WGS84 geometry guides along a line, corrects cross track, wraps north, and reverses AMap conversion',()=>{
  const north=N.destination(ORIGIN,0,100),east=N.destination(ORIGIN,90,10),g=N.guide(east,ORIGIN,north,10);
  assert.ok(Math.abs(N.distance(ORIGIN,north)-100)<1e-6);assert.ok(N.bearing(ORIGIN,north)<0.001);
  assert.ok(g.crossM>9.9&&g.heading>300&&g.heading<330);assert.equal(N.angleError(1,359),2);
  for(const p of [ORIGIN,{latitude:23.1,longitude:113.2},{latitude:51,longitude:-1}]){
    const gcj=coords.wgs84ToGcj02(p.latitude,p.longitude),back=coords.gcj02ToWgs84(gcj.latitude,gcj.longitude);assert.ok(N.distance(p,back)<0.02);
  }
});
test('route library validates data, persists separately per boat, atomically revises, and fails closed on corruption',t=>{
  const f=fixture(t),r=f.route(),reopened=new MissionStore({env:f.env});assert.equal(reopened.error,'');assert.deepEqual(reopened.get('boat-01',r.id),r);
  assert.throws(()=>reopened.get('boat-02',r.id),{status:404});assert.equal(reopened.list('boat-02').length,0);
  assert.throws(()=>f.store.save('boat-01',{name:'x'},r.id,1),{status:400});
  const {name,speedMps,arrivalRadiusM,points}=r,definition={name,speedMps,arrivalRadiusM,points};
  assert.throws(()=>f.store.save('boat-01',definition,r.id,9),{status:409});
  assert.throws(()=>f.store.save('boat-01',definition,r.id,1,()=>{throw Object.assign(Error('expired'),{status:401});}),{status:401});assert.equal(f.store.get('boat-01',r.id).revision,1);
  const updated=f.store.save('boat-01',{...definition,name:'巡航 2'},r.id,1);assert.equal(updated.revision,2);
  assert.throws(()=>normalizeRoute({...definition,points:[ORIGIN,ORIGIN]}),{status:400});assert.throws(()=>normalizeRoute({...definition,speedMps:NaN}),{status:400});
  f.store.delete('boat-01',r.id,2);assert.equal(new MissionStore({env:f.env}).list('boat-01').length,0);
  fs.writeFileSync(f.store.file,'broken');const broken=new MissionStore({env:f.env});assert.match(broken.error,/读取失败/);assert.throws(()=>broken.save('boat-01',definition),{status:503});assert.equal(fs.readFileSync(f.store.file,'utf8'),'broken');
});
test('takeover requires a real MCU ACK, starts at zero, reads maximum once and maps speed to throttle',async t=>{
  const f=fixture(t,{autoAck:false}),r=f.route();f.mission.start('boat-01',r.id,'start');
  await until(()=>f.commands().length===1);assert.equal(f.mission.snapshot('boat-01').status,'acquiring');assert.equal(f.commands()[0].payload.readInt16LE(30),0);assert.equal(f.commands()[0].payload[29],2);
  f.advance(100);assert.equal(f.commands().length,1);f.ack();await until(()=>f.mission.snapshot('boat-01').status==='running');
  f.advance(100);assert.equal(f.mission.snapshot('boat-01').targetIndex,1);assert.equal(f.commands().at(-1).payload.readInt16LE(30),400);assert.equal(f.commands().at(-1).payload[36],0);
  assert.equal(f.client.sent.filter(p=>p.topic.endsWith('parameter-command')).length,1);
  assert.equal(f.control.snapshot('boat-01').source,'mission');assert.match(f.control.snapshot('boat-01').message,/航线任务/);
});
test('goto stops at start, requires two new samples, waits for stop ACK, and never auto-starts route',async t=>{
  const f=fixture(t),r=f.route();f.feed('boat-01',N.destination(ORIGIN,180,20));await running(f,r,'goto');
  f.advance(100,'boat-01',ORIGIN);await flush(f);assert.equal(f.mission.snapshot('boat-01').status,'running');
  // 同一个源样本重复上报不能被当作第二次到达。
  const tick=f.now();f.advance(100,'boat-01',{sourceTick:tick});assert.equal(f.mission.snapshot('boat-01').status,'running');
  f.autoAck=false;f.advance(100,'boat-01',{sourceTick:f.now()+100});assert.equal(f.mission.snapshot('boat-01').status,'stopping');assert.equal(f.commands().at(-1).payload.readInt16LE(30),0);
  f.ack();f.mission.refresh();const result=f.mission.snapshot('boat-01');assert.equal(result.status,'completed');assert.equal(result.stopConfirmed,true);assert.equal(f.control.jobs.size,0);
  f.advance(100);assert.equal(f.mission.snapshot('boat-01').status,'completed');
});
test('start requires being at start; ordered samples advance once per point, final point stops with confirmation',async t=>{
  const f=fixture(t),r=f.route();f.feed('boat-01',N.destination(ORIGIN,90,50));assert.throws(()=>f.mission.start('boat-01',r.id,'start'),{status:409});
  f.feed('boat-01',ORIGIN);await running(f,r);f.advance(100);await flush(f);assert.equal(f.mission.snapshot('boat-01').targetIndex,1);
  for(let index=1;index<r.points.length;index++){f.advance(100,'boat-01',{...r.points[index],heading:90});await flush(f);assert.equal(f.mission.snapshot('boat-01').targetIndex,index);f.advance(100);await flush(f);}
  assert.equal(f.mission.snapshot('boat-01').status,'completed');assert.equal(f.mission.snapshot('boat-01').stopConfirmed,true);
});
test('stale RTK, invalid position, missing motors and heading fail closed; unconfirmed stop never claims success',async t=>{
  for(const failure of [{age:1000},{fix:false},{motors:false},{heading:false}]){
    const f=fixture(t);await running(f);f.autoAck=false;f.flags.set('boat-01',failure);f.advance(100);assert.equal(f.mission.snapshot('boat-01').status,'stopping');assert.equal(f.commands().at(-1).payload.readInt16LE(30),0);
    f.advance(1300);f.control.refresh();f.mission.refresh();assert.equal(f.mission.snapshot('boat-01').status,'failed');assert.equal(f.mission.snapshot('boat-01').stopConfirmed,false);
  }
});
test('frozen source ticks stop; old samples do not keep a task moving',async t=>{
  const f=fixture(t);await running(f);const tick=f.now();
  for(let i=0;i<11;i++){f.advance(100,'boat-01',{sourceTick:tick});await flush(f);}
  assert.equal(f.mission.snapshot('boat-01').status,'failed');assert.match(f.mission.snapshot('boat-01').message,/未更新/);
});
test('missing telemetry, broker loss and boat reboot cancel control without automatic rearm',async t=>{
  for(const cause of ['telemetry','broker','reboot']){
    const f=fixture(t);await running(f);f.advance(100);await flush(f);const sent=f.commands().length;
    if(cause==='telemetry'){const device=f.bridge.devices.get('boat-01');device.lastReceivedAt=f.now()-1100;}
    if(cause==='broker')f.bridge.setBrokerConnected(false);
    if(cause==='reboot')f.publish('boat-01','control-state',{...f.control.cap('boat-01'),token:'fedcba9876543210',uptimeMs:1,receivedAt:undefined});
    f.control.refresh();f.mission.refresh();assert.ok(['stopping','failed'].includes(f.mission.snapshot('boat-01').status));
    await flush(f);assert.ok(f.commands().slice(sent).every(command=>command.payload.readInt16LE(30)===0),'No nonzero command after feedback/connection loss');
  }
});
test('excessive cross-track error, source tick rollback and no progress stop the task',async t=>{
  for(const cause of ['cross','rollback','progress']){
    const f=fixture(t,{missionOptions:{progressTimeoutMs:1000}});await running(f);f.advance(100);await flush(f);
    if(cause==='cross')f.advance(100,'boat-01',N.destination(ORIGIN,90,40));
    else if(cause==='rollback')f.advance(100,'boat-01',{sourceTick:1});
    else for(let i=0;i<11;i++){f.advance(100);await flush(f);}
    await flush(f);assert.equal(f.mission.snapshot('boat-01').status,'failed');
  }
});
test('server navigation survives browser/session loss, isolates boats and keeps manual/OTA/parameter locks',async t=>{
  const f=fixture(t),job=await running(f);f.feed('boat-02');const second=f.route('boat-02');f.mission.start('boat-02',second.id,'start');await until(()=>f.mission.snapshot('boat-02').status==='running');
  f.control.releaseOwner('browser-session');assert.equal(f.mission.active('boat-01'),true);
  assert.throws(()=>f.control.acquire('boat-01','browser-session',CLIENT,{mode:2,throttle:0,turn:0,targetHeading:0}),{status:409});
  assert.throws(()=>f.bridge.claimFirmware('boat-01'),{status:409});await assert.rejects(f.bridge.requestParameters('boat-01','read'),{status:409});
  f.mission.stop('boat-01');await flush(f);assert.equal(f.mission.snapshot(job).status,'stopped');assert.equal(f.mission.active('boat-02'),true);
});
test('cancel during parameter read or pending acquire cannot later arm a task',async t=>{
  const f=fixture(t),r=f.route();f.parameterDelay=50;f.mission.start('boat-01',r.id,'start');f.mission.stop('boat-01');await wait(70);assert.equal(f.commands().length,0);assert.equal(f.mission.active('boat-01'),false);
  f.parameterDelay=0;f.autoAck=false;f.advance(100);f.mission.start('boat-01',r.id,'start');await until(()=>f.commands().length===1);const acquire=f.commands()[0];f.mission.stop('boat-01');f.ack(acquire);await flush(f);assert.equal(f.mission.snapshot('boat-01').status,'stopping');assert.ok(f.commands().every(p=>p.payload.readInt16LE(30)===0));
});
test('server restart retains routes but never resumes commands; close sends a zero stop',async t=>{
  const f=fixture(t);await running(f);f.advance(100);await flush(f);f.mission.close();assert.equal(f.commands().at(-1).payload[28],4);assert.equal(f.commands().at(-1).payload.readInt16LE(30),0);
  const reopened=new MissionService({bridge:f.bridge,control:f.control,store:new MissionStore({env:f.env})});t.after(()=>reopened.close());assert.equal(reopened.list().length,0);assert.equal(reopened.store.list('boat-01').length,1);
});
test('task speed above the actual MCU maximum never acquires or sends movement',async t=>{
  const f=fixture(t),r=f.route('boat-01',{speedMps:3});f.mission.start('boat-01',r.id,'start');await until(()=>!f.mission.active('boat-01'));assert.match(f.mission.snapshot('boat-01').message,/超过船端/);assert.equal(f.commands().length,0);
});
test('mission HTTP enforces roles, origin, route ownership/revisions and preserves execution after logout',async t=>{
  const f=fixture(t,{server:true});await new Promise(resolve=>f.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+f.server.address().port;
  const call=async(route,{cookie,body,method='GET',origin=base}={})=>{const response=await fetch(base+route,{method,headers:{origin,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  const login=async(role)=>call('/api/auth/login',{method:'POST',body:{username:role==='admin'?'operator':'observer',password:role==='admin'?'browser-admin-test-only':'browser-guest-test-only'}});
  assert.equal((await call('/api/missions')).status,401);const admin=(await login('admin')).cookie,guest=(await login('guest')).cookie,r=f.route();
  assert.equal((await call('/api/missions?deviceId=boat-01',{cookie:guest})).data.routes.length,1);
  const start={deviceId:'boat-01',routeId:r.id,revision:r.revision,action:'start'};
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:guest,body:start})).status,403);
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:admin,body:start,origin:'https://evil.test'})).status,403);
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:admin,body:{...start,owner:'mission:fake'}})).status,400);
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:admin,body:{...start,revision:r.revision+1}})).status,409);
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:admin,body:{...start,deviceId:'boat-02'}})).status,404);
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:admin,body:start})).status,202);await until(()=>f.mission.snapshot('boat-01').status==='running');
  assert.equal((await call('/api/missions/route',{method:'DELETE',cookie:admin,body:{deviceId:'boat-01',id:r.id,revision:r.revision}})).status,409);
  await call('/api/auth/session',{method:'DELETE',cookie:admin});assert.equal(f.mission.active('boat-01'),true);
  const fresh=(await login('admin')).cookie,run=f.mission.snapshot('boat-01');
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:fresh,body:{deviceId:'boat-01',action:'stop',runId:'0000000000000000'}})).status,409);
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:fresh,body:{deviceId:'boat-01',action:'stop',runId:run.runId}})).status,202);await flush(f);assert.equal(f.mission.snapshot('boat-01').status,'stopped');
});
