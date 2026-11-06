'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createMissionFixture,ORIGIN}=require('./mission-fixture.cjs');
const {MissionTracks}=require('../server/mission-tracks'),{MissionStore,normalizeRoute,routeDefinition}=require('../server/mission-store');
const N=require('../public/utils/missionNavigation'),P=require('../public/utils/missionPath');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<150;i++){if(check())return;await wait(5);}throw Error('Mission track condition timed out');}
function fixture(t,options){const f=createMissionFixture(options);t.after(()=>f.close());return f;}
async function flush(f){await Promise.resolve();await Promise.resolve();f.mission.refresh();}
async function tick(f,p={}){f.advance(100,'boat-01',p);await flush(f);}
async function arrive(f,p){await tick(f,p);await tick(f,p);}
function route(f,extra={}){return f.route('boat-01',{points:[0,30,60,90].map(m=>N.destination(ORIGIN,0,m)),segments:[{type:'line'},{type:'line',record:false},{type:'line'}],...extra});}
async function start(f,r,record=true){f.mission.start('boat-01',r.id,'start',r.revision,record);await until(()=>f.mission.snapshot('boat-01').status==='running');await tick(f);return f.mission.jobs.get('boat-01');}
async function travel(f,from,to){for(let i=1;i<=12;i++)await tick(f,{...N.destination(from,N.bearing(from,to),N.distance(from,to)*i/12),heading:N.bearing(from,to)});await tick(f,to);}

test('记录属性与直线/曲线独立，旧航线默认实线，严格校验并保存纯直线的跳过标记',t=>{
  const f=fixture(t),r=route(f),definition=routeDefinition(r);
  assert.equal(P.routeLines(r).length,3);assert.deepEqual(P.routeLines(r).map(line=>line.dashed),[false,true,false]);
  assert.equal(normalizeRoute({...definition,segments:[{type:'line',record:true},{type:'line'},{type:'line'}]}).segments,undefined);
  assert.equal(P.routeLines({...r,segments:undefined}).length,1);
  assert.equal(P.routeLines({...r,segments:undefined})[0].points.length,4);
  for(const record of [0,1,'false',null,[],{}])assert.throws(()=>normalizeRoute({...definition,segments:[{type:'line'},{type:'line',record},{type:'line'}]}),{status:400});
  const control=P.defaultControl(r.points[0],r.points[1]),curve=normalizeRoute({...definition,segments:[{type:'curve',control,record:false},{type:'line',record:false},{type:'line'}]});
  assert.ok(P.routeLines(curve)[0].points.length>3);assert.equal(P.routeLines(curve)[0].dashed,true);
  const reopened=new MissionStore({env:f.env});assert.equal(reopened.error,'');assert.deepEqual(reopened.get('boat-01',r.id),r);
  const q=f.store.saveQueue('boat-01',{name:'独立记录设置',routeIds:[r.id,r.id],loopEnabled:false,loopCount:1}),copies=structuredClone(q.routes);
  copies[0].segments[0].record=false;f.store.saveQueue('boat-01',{name:q.name,routeIds:q.routeIds,routes:copies,loopEnabled:false,loopCount:1},q.id,q.revision);
  const saved=new MissionStore({env:f.env});assert.equal(saved.error,'');assert.equal(saved.getQueue('boat-01',q.id).routes[0].segments[0].record,false);
  assert.equal(saved.getQueue('boat-01',q.id).routes[1].segments[0].record,undefined);assert.deepEqual(saved.get('boat-01',r.id),r);
});

test('普通开始不创建专用轨迹，记录操作仅允许从有效起点开始',async t=>{
  const f=fixture(t),r=route(f);for(const flag of [null,1,'true'])assert.throws(()=>f.mission.start('boat-01',r.id,'start',r.revision,flag),{status:400});
  assert.throws(()=>f.mission.start('boat-01',r.id,'goto',r.revision,true),{status:400});
  f.feed('boat-01',N.destination(ORIGIN,180,10));assert.throws(()=>f.mission.start('boat-01',r.id,'start',r.revision,true),{status:409});
  assert.equal(f.mission.tracks.list('boat-01').length,0);f.feed('boat-01',ORIGIN);await start(f,r,false);
  assert.equal(f.mission.snapshot('boat-01').recordTrack,false);assert.equal(f.mission.tracks.list('boat-01').length,0);
  assert.equal(f.commands().at(-1).payload[29],2);assert.ok(f.commands().at(-1).payload.readInt16LE(30)>0);
});

test('服务器采样真实船位，跳过虚线仍下发运动指令，两段实线之间没有连接边',async t=>{
  const f=fixture(t),r=route(f),job=await start(f,r),id=job.trackId;
  await travel(f,r.points[0],r.points[1]);assert.equal(job.index,2);
  const first=f.mission.tracks.get('boat-01',id),count=first.pointCount;assert.ok(count>=2);assert.equal(first.recording,false);
  await travel(f,r.points[1],N.destination(r.points[1],0,20));
  assert.equal(job.index,2);assert.equal(f.mission.tracks.get('boat-01',id).pointCount,count);assert.ok(f.commands().at(-1).payload.readInt16LE(30)>0,'虚线段保持正常航行');
  await arrive(f,r.points[2]);await travel(f,r.points[2],r.points[3]);
  assert.equal(f.mission.snapshot('boat-01').status,'completed');
  const track=f.mission.tracks.get('boat-01',id);assert.equal(track.status,'completed');assert.equal(track.recording,false);
  assert.deepEqual(track.chunks.map(c=>c.segmentIndex),[0,2]);assert.ok(track.chunks.every(c=>c.points.length>=2));
  assert.ok(N.distance(track.chunks[0].points.at(-1),r.points[1])<3.01);assert.ok(N.distance(track.chunks[1].points[0],r.points[2])<3.01);
  assert.ok(track.chunks.flatMap(c=>c.points).every(p=>Number.isFinite(p.speedMps)&&Number.isFinite(p.receivedAt)));
  await f.mission.tracks.flush();const reopened=new MissionTracks({file:path.join(f.dir,'mission-tracks.json'),now:f.now});t.after(()=>reopened.close());
  assert.equal(reopened.error,'');assert.deepEqual(reopened.get('boat-01',id),track);assert.throws(()=>reopened.get('boat-02',id),{status:404});
});

test('全部虚线任务可正常完成但不记录任何坐标',async t=>{
  const f=fixture(t),r=route(f,{segments:[0,1,2].map(()=>({type:'line',record:false}))}),job=await start(f,r);
  for(const p of r.points.slice(1))await arrive(f,p);
  const track=f.mission.tracks.get('boat-01',job.trackId);assert.equal(track.status,'completed');assert.equal(track.pointCount,0);assert.deepEqual(track.chunks,[]);
});

test('曲线航段记录反馈坐标而不是计划折线或弯曲控制点',async t=>{
  const f=fixture(t),end=N.destination(ORIGIN,0,30),control=P.defaultControl(ORIGIN,end);
  const r=f.route('boat-01',{arrivalRadiusM:1,points:[ORIGIN,end],segments:[{type:'curve',control}]}),job=await start(f,r),segment=P.compile(r).segments[0];
  for(let i=1;i<=16;i++){
    const point=P.at(segment,segment.lengthM*i/16);await tick(f,{...point,heading:P.guide(point,segment,1).courseHeading});
  }
  await tick(f,end);const track=f.mission.tracks.get('boat-01',job.trackId);
  assert.equal(track.status,'completed');assert.equal(track.chunks.length,1);
  assert.ok(track.chunks[0].points.some(p=>Math.abs(N.guide(p,ORIGIN,end,0).crossM)>2),'实测点位于弯曲航程上');
  assert.ok(track.chunks[0].points.every(p=>N.distance(p,control)>2),'控制点不作为实测船位插入');
});

test('暂停与继续复用同一份轨迹并断开暂停空窗，失效定位不记录',async t=>{
  const f=fixture(t),r=route(f),job=await start(f,r);await travel(f,ORIGIN,N.destination(ORIGIN,0,12));
  const id=job.trackId,before=f.mission.tracks.get('boat-01',id).pointCount;
  f.mission.pause('boat-01');await flush(f);assert.equal(f.mission.tracks.get('boat-01',id).status,'paused');
  await tick(f);assert.equal(f.mission.tracks.get('boat-01',id).pointCount,before);
  f.mission.resume('boat-01',job.runId);await until(()=>f.mission.snapshot('boat-01').status==='running');
  assert.equal(f.mission.snapshot('boat-01').trackId,id);assert.equal(f.mission.tracks.list('boat-01').length,1);
  await tick(f);const resumed=f.mission.tracks.get('boat-01',id);assert.equal(resumed.chunks.length,2);
  f.flags.set('boat-01',{fix:false});await tick(f);const stopped=f.mission.tracks.get('boat-01',id);
  assert.equal(stopped.pointCount,resumed.pointCount);assert.equal(stopped.status,'failed');assert.equal(stopped.recording,false);
});

test('循环返回段不记录，下一圈单独建段而且复用原控制租约',async t=>{
  const f=fixture(t),r=route(f,{loopEnabled:true,loopCount:2,segments:[0,1,2].map(()=>({type:'line'}))}),job=await start(f,r),lease=job.leaseId;
  for(let lap=1;lap<=2;lap++){
    for(const p of r.points.slice(1))await arrive(f,p);
    assert.equal(job.phase,'returning');const before=f.mission.tracks.get('boat-01',job.trackId).pointCount;
    await tick(f,{...N.destination(ORIGIN,0,45),heading:180});assert.equal(f.mission.tracks.get('boat-01',job.trackId).pointCount,before);
    await arrive(f,ORIGIN);
  }
  const track=f.mission.tracks.get('boat-01',job.trackId);assert.equal(track.status,'completed');assert.equal(job.leaseId,lease);
  assert.deepEqual(track.chunks.map(c=>c.loop),[1,1,1,2,2,2]);assert.ok(track.chunks.every(c=>c.segmentIndex>=0));
});

test('放弃暂停任务另开任务时结束旧记录，避免旧记录永久占用活动容量',async t=>{
  const f=fixture(t),r=route(f),job=await start(f,r);f.mission.pause('boat-01');await flush(f);
  assert.equal(f.mission.tracks.get('boat-01',job.trackId).status,'paused');
  await start(f,r,false);assert.equal(f.mission.tracks.get('boat-01',job.trackId).status,'stopped');
});

test('任务组独立副本的记录设置生效，转场和整组返回不记录',async t=>{
  const f=fixture(t),a=f.route('boat-01',{points:[ORIGIN,N.destination(ORIGIN,0,20)]}),b=f.route('boat-01',{points:[N.destination(ORIGIN,0,40),N.destination(ORIGIN,0,60)],segments:[{type:'line',record:false}]});
  const q=f.store.saveQueue('boat-01',{name:'连续作业',routeIds:[a.id,b.id],loopEnabled:true,loopCount:2});
  f.mission.startQueue('boat-01',q.id,'start',q.revision,q.routes.map(()=>q.revision),true);await until(()=>f.mission.snapshot('boat-01').status==='running');await tick(f);
  const job=f.mission.jobs.get('boat-01');
  for(let lap=0;lap<2;lap++){
    await arrive(f,a.points[1]);assert.equal(job.phase,'transit');const count=f.mission.tracks.get('boat-01',job.trackId).pointCount;
    await tick(f,N.destination(ORIGIN,0,30));assert.equal(f.mission.tracks.get('boat-01',job.trackId).pointCount,count);
    await arrive(f,b.points[0]);await arrive(f,b.points[1]);assert.equal(job.phase,'queueReturning');
    await tick(f,N.destination(ORIGIN,0,30));assert.equal(f.mission.tracks.get('boat-01',job.trackId).pointCount,count);
    await arrive(f,ORIGIN);
  }
  const record=f.mission.tracks.get('boat-01',job.trackId);assert.equal(record.status,'completed');assert.equal(record.chunks.length,2);assert.ok(record.chunks.every(c=>c.routeId===a.id));
  assert.deepEqual(record.chunks.map(c=>c.queueLoop),[1,2]);
});

test('后台记录不需要浏览器，重启恢复轨迹但不恢复执行；损坏存储不覆盖或影响普通任务',async t=>{
  const f=fixture(t),r=route(f),job=await start(f,r);await tick(f);await f.mission.tracks.flush();
  const reopened=new MissionTracks({file:f.mission.tracks.file,now:f.now});assert.equal(reopened.get('boat-01',job.trackId).status,'interrupted');await reopened.close();
  const bad=path.join(f.dir,'broken-tracks.json');fs.writeFileSync(bad,'broken');const broken=new MissionTracks({file:bad,now:f.now});
  assert.ok(broken.error);assert.throws(()=>broken.start({id:'boat-01'}),{status:503});await broken.close();assert.equal(fs.readFileSync(bad,'utf8'),'broken');
  f.mission.stop('boat-01');await flush(f);f.mission.tracks.blocked=true;f.mission.tracks.error='storage fault';
  assert.throws(()=>f.mission.start('boat-01',r.id,'start',r.revision,true),{status:503});
  f.mission.start('boat-01',r.id,'start',r.revision,false);await until(()=>f.mission.snapshot('boat-01').status==='running');assert.equal(f.mission.snapshot('boat-01').recordTrack,false);
});

test('单份记录裁剪有界，采样间断和相同源样本不会跨缺失航程续线',async t=>{
  let now=10000;const tracks=new MissionTracks({now:()=>now});t.after(()=>tracks.close());
  const job={id:'boat-01',route:{id:'1234567890abcdef',name:'长时间记录',segments:[]},action:'start',status:'running',phase:'route',index:1,completedLoops:0};
  tracks.start(job);tracks.state(job,'running');
  const p={...ORIGIN,speedMps:1,sourceTick:1};tracks.sample(job,p);tracks.sample(job,p,{boundary:true});assert.equal(tracks.get('boat-01',job.trackId).pointCount,1);
  now+=2000;tracks.sample(job,{...p,sourceTick:2});assert.equal(tracks.get('boat-01',job.trackId).chunks.length,2);
  for(let i=0;i<10010;i++){now+=1000;tracks.sample(job,{...p,sourceTick:i+3});}
  const record=tracks.get('boat-01',job.trackId);assert.equal(record.pointCount,10000);assert.equal(record.truncated,true);assert.equal(record.chunks.reduce((s,c)=>s+c.points.length,0),10000);
});

test('任务轨迹 API 区分角色、船只、修订和同源请求，客户端不能为前往起点开启记录',async t=>{
  const f=fixture(t,{server:true});await new Promise(resolve=>f.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+f.server.address().port;
  const call=async(endpoint,body,cookie,origin=base)=>{const response=await fetch(base+endpoint,{method:body?'POST':'GET',headers:{origin,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  const admin=(await call('/api/auth/login',{username:'operator',password:'browser-admin-test-only'})).cookie,guest=(await call('/api/auth/login',{username:'observer',password:'browser-guest-test-only'})).cookie,r=route(f);
  const body={deviceId:'boat-01',routeId:r.id,revision:r.revision,action:'start',recordTrack:true};
  assert.equal((await call('/api/missions/run',body,guest)).status,403);assert.equal((await call('/api/missions/run',body,admin,'https://example.invalid')).status,403);
  assert.equal((await call('/api/missions/run',{...body,action:'goto'},admin)).status,400);assert.equal((await call('/api/missions/run',{...body,recordTrack:1},admin)).status,400);
  const result=await call('/api/missions/run',body,admin);assert.equal(result.status,202);await until(()=>f.mission.snapshot('boat-01').status==='running');await tick(f);
  const endpoint='/api/missions/tracks?deviceId=boat-01&id='+result.data.run.trackId;
  assert.equal((await call(endpoint)).status,401);assert.equal((await call(endpoint,null,guest)).status,403);assert.equal((await call(endpoint,null,admin,'https://example.invalid')).status,403);
  assert.equal((await call(endpoint.replace('boat-01','boat-02'),null,admin)).status,404);assert.equal((await call(endpoint+'&deviceId=boat-01',null,admin)).status,400);
  assert.equal((await call(endpoint,null,admin)).data.track.deviceId,'boat-01');
  const listed=(await call('/api/missions?deviceId=boat-01',null,admin)).data;assert.equal(listed.tracks.length,1);assert.equal(listed.tracks[0].chunks,undefined);assert.equal(listed.trackStorage.persistent,true);
});
