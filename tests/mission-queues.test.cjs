'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createMissionFixture,ORIGIN}=require('./mission-fixture.cjs');
const N=require('../public/utils/missionNavigation'),{MissionStore,normalizeQueue,routeDefinition}=require('../server/mission-store'),{MissionService}=require('../server/mission-service');
const P=require('../public/utils/missionPath');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let n=0;n<120;n++){if(check())return;await wait(5);}throw Error('Queue condition timed out');}
function fixture(t,options){const f=createMissionFixture(options);t.after(()=>f.close());return f;}
async function flush(f){await Promise.resolve();await Promise.resolve();f.mission.refresh();}
async function at(f,point){for(let n=0;n<2;n++){const old=f.positions.get('boat-01'),heading=(Math.round(N.bearing(old,point)*100)%36000)/100;f.advance(100,'boat-01',{...point,heading,sourceTick:undefined});await flush(f);}}
function pair(f,first={},second={}){
  return [f.route('boat-01',{name:'轨迹一',points:[ORIGIN,N.destination(ORIGIN,0,20)],...first}),
    f.route('boat-01',{name:'轨迹二',speedMps:1.5,arrivalRadiusM:2,points:[N.destination(ORIGIN,90,20),N.destination(ORIGIN,90,45)],...second})];
}
function queue(f,routes,extra={}){return f.store.saveQueue('boat-01',{name:'组合巡航',routeIds:routes.map(r=>r.id),loopEnabled:false,loopCount:1,...extra});}
async function start(f,routes,q=queue(f,routes),action='start'){
  f.mission.startQueue('boat-01',q.id,action,q.revision,q.routes.map(()=>q.revision));await until(()=>f.mission.snapshot('boat-01').status==='running');return q;
}

test('任务队列按船保存顺序和重复航线副本，v4迁移v6，原航线与返航点保留',t=>{
  const f=fixture(t),routes=pair(f);const home=f.store.saveHome('boat-01',ORIGIN,0);
  fs.writeFileSync(f.store.file,JSON.stringify({version:4,routes,homes:[home]}));
  const store=new MissionStore({env:f.env});assert.equal(store.error,'');assert.equal(store.listQueues('boat-01').length,0);
  const q=store.saveQueue('boat-01',{name:'队列 A',routeIds:[routes[1].id,routes[0].id,routes[1].id],loopEnabled:true,loopCount:2});
  assert.equal(JSON.parse(fs.readFileSync(store.file,'utf8')).version,6);
  const reopened=new MissionStore({env:f.env});assert.equal(reopened.error,'');assert.deepEqual(reopened.getQueue('boat-01',q.id),q);
  assert.deepEqual(reopened.getHome('boat-01'),home);assert.deepEqual(reopened.list('boat-01'),routes);
  assert.deepEqual(reopened.listQueues('boat-02'),[]);assert.throws(()=>reopened.getQueue('boat-02',q.id),{status:404});
  reopened.delete('boat-01',routes[0].id,1);assert.deepEqual(reopened.getQueue('boat-01',q.id),q,'删除来源不改变副本');
  const before=fs.readFileSync(store.file,'utf8');
  assert.throws(()=>store.saveQueue('boat-01',{name:'改变',routeIds:[routes[0].id]},q.id,q.revision,()=>{throw Object.assign(Error('expired'),{status:401});}),{status:401});
  assert.equal(fs.readFileSync(store.file,'utf8'),before);assert.deepEqual(store.getQueue('boat-01',q.id),q);
  assert.throws(()=>store.saveQueue('boat-01',{name:'改变',routeIds:[routes[0].id]},q.id,8),{status:409});
  store.deleteQueue('boat-01',q.id,q.revision);store.delete('boat-01',routes[0].id,1);assert.equal(store.listQueues('boat-01').length,0);
});

test('队列严格校验循环、引用归属、数量、转场距离和单轮长度，损坏文件禁止执行',t=>{
  const f=fixture(t),routes=pair(f),base={name:'x',routeIds:routes.map(r=>r.id)};
  for(const change of [{name:''},{routeIds:[]},{routeIds:Array(33).fill(routes[0].id)},{routeIds:['bad']},{loopCount:0},{loopCount:1.5},{loopCount:1000},{loopCount:null},{loopEnabled:null},{loopEnabled:1},{extra:true}])assert.throws(()=>normalizeQueue({...base,...change}),{status:400});
  const foreign=f.route('boat-02');assert.throws(()=>f.store.saveQueue('boat-01',{...base,routeIds:[foreign.id]}),{status:404});
  const remote=f.route('boat-01',{points:[N.destination(ORIGIN,90,25000),N.destination(ORIGIN,90,25020)]});
  assert.throws(()=>f.store.saveQueue('boat-01',{...base,routeIds:[routes[0].id,remote.id]}),/转场距离/);
  const long=f.route('boat-01',{loopEnabled:true,loopCount:999,points:[ORIGIN,N.destination(ORIGIN,0,60)]});
  assert.throws(()=>f.store.saveQueue('boat-01',{...base,routeIds:[long.id]}),/单轮总长/);
  const q=queue(f,routes),data=JSON.parse(fs.readFileSync(f.store.file,'utf8'));data.queues[0].routes.pop();fs.writeFileSync(f.store.file,JSON.stringify(data));
  const broken=new MissionStore({env:f.env});assert.match(broken.error,/文件读取失败/);assert.throws(()=>broken.saveQueue('boat-01',base),{status:503});assert.equal(q.routeIds.length,2);
});

for(const algorithm of [0,1])test('算法 '+algorithm+' 顺序执行两条不同航速航线，自动转场且共用租约与参数读取',async t=>{
  const f=fixture(t,{algorithmControl:true}),startPoint=N.destination(ORIGIN,90,20),endPoint=N.destination(ORIGIN,90,45);
  const routes=pair(f,{}, {segments:[{type:'curve',control:P.defaultControl(startPoint,endPoint)}]});f.algorithms.set('boat-01',algorithm);f.feed();const q=await start(f,routes);
  const run=f.mission.snapshot('boat-01'),lease=f.mission.jobs.get('boat-01').leaseId;await at(f,ORIGIN);await at(f,routes[0].points[1]);
  let state=f.mission.snapshot('boat-01');assert.equal(state.phase,'transit');assert.equal(state.routeId,routes[1].id);assert.equal(state.queue.routeIndex,1);assert.equal(state.queue.completedLoops,0);
  assert.ok(N.distance(state.transitionFrom,routes[0].points[1])<.02);assert.equal(f.mission.jobs.get('boat-01').transitSpeed,1);assert.equal(f.mission.jobs.get('boat-01').leaseId,lease);
  assert.equal(f.mission.jobs.get('boat-01').geometry.segments[0].curved,true,'下一条航线继续采用实际曲线');
  const oldTick=f.now();for(let n=0;n<2;n++){f.advance(100,'boat-01',{...routes[1].points[0],sourceTick:oldTick});await flush(f);}
  assert.equal(f.mission.snapshot('boat-01').phase,'transit','重复同一定位不能完成转场');
  await at(f,routes[1].points[0]);assert.equal(f.mission.snapshot('boat-01').phase,'route');assert.equal(f.mission.snapshot('boat-01').targetIndex,1);
  await at(f,routes[1].points[1]);state=f.mission.snapshot('boat-01');
  assert.equal(state.status,'completed');assert.equal(state.stopConfirmed,true);assert.equal(state.queue.id,q.id);assert.equal(state.queue.completedLoops,1);assert.equal(state.runId,run.runId);
  assert.equal(f.commands().filter(p=>p.payload[28]===1).length,1);assert.equal(f.client.sent.filter(p=>p.topic.endsWith('parameter-command')).length,1);
  assert.equal(state.commandSpeedMps,0);const sent=f.commands().length;f.advance(500);assert.equal(f.commands().length,sent);
});

test('整组两轮各自走完全部航线并返回首条起点，最后一轮也确认返回后才完成',async t=>{
  const f=fixture(t),routes=pair(f),q=queue(f,routes,{loopEnabled:true,loopCount:2});await start(f,routes,q);await at(f,ORIGIN);
  for(let lap=1;lap<=2;lap++){
    await at(f,routes[0].points[1]);await at(f,routes[1].points[0]);await at(f,routes[1].points[1]);
    let s=f.mission.snapshot('boat-01');assert.equal(s.phase,'queueReturning');assert.equal(s.queue.completedLoops,lap-1);assert.equal(s.queue.currentLoop,lap);
    f.advance(100,'boat-01',{...ORIGIN,heading:N.bearing(routes[1].points[1],ORIGIN)});await flush(f);
    assert.equal(f.mission.snapshot('boat-01').status,'running','到达第一份样本不能算完整一轮');
    f.advance(100);await flush(f);s=f.mission.snapshot('boat-01');assert.equal(s.queue.completedLoops,lap);
    if(lap===1){assert.equal(s.phase,'route');assert.equal(s.targetIndex,1);assert.equal(s.queue.routeIndex,0);}
    else{assert.equal(s.status,'completed');assert.equal(s.stopConfirmed,true);assert.match(s.message,/完成 2 轮并返回/);}
  }
  assert.equal(f.commands().filter(p=>p.payload[28]===1).length,1);
});

test('先完成单条航线自身循环，再进入下一条；队列前往起点不会自动开始',async t=>{
  const f=fixture(t),routes=pair(f,{loopEnabled:true,loopCount:2}),q=queue(f,routes,{loopEnabled:true,loopCount:2});
  f.feed('boat-01',N.destination(ORIGIN,180,10));await start(f,routes,q,'goto');await at(f,ORIGIN);
  assert.equal(f.mission.snapshot('boat-01').status,'completed');assert.equal(f.mission.snapshot('boat-01').queue.completedLoops,0);
  await start(f,routes,q);await at(f,ORIGIN);
  for(let lap=1;lap<=2;lap++){
    await at(f,routes[0].points[1]);assert.equal(f.mission.snapshot('boat-01').phase,'returning');await at(f,ORIGIN);
    const s=f.mission.snapshot('boat-01');assert.equal(s.queue.routeIndex,lap===1?0:1);assert.equal(s.phase,lap===1?'route':'transit');
  }
  assert.equal(f.mission.snapshot('boat-01').queue.completedLoops,0,'单条轨迹循环不递增整组轮数');
});

test('暂停转场后保留队列位置和冻结航线，继续重新申请租约，异常或手动停止不继续下一条',async t=>{
  const f=fixture(t),routes=pair(f),q=await start(f,routes);await at(f,ORIGIN);await at(f,routes[0].points[1]);
  const old=f.mission.snapshot('boat-01'),lease=f.mission.jobs.get('boat-01').leaseId;f.mission.pause('boat-01');await flush(f);
  assert.equal(f.mission.snapshot('boat-01').status,'paused');
  const {name,speedMps,arrivalRadiusM,points}=routes[1];f.store.save('boat-01',{name,speedMps,arrivalRadiusM,points:[points[0],N.destination(points[1],90,5)]},routes[1].id,1);
  f.advance(100);f.mission.resume('boat-01',old.runId);await until(()=>f.mission.snapshot('boat-01').status==='running');
  const resumed=f.mission.snapshot('boat-01');assert.equal(resumed.phase,'transit');assert.equal(resumed.queue.routeIndex,1);assert.deepEqual(resumed.route.points,routes[1].points);assert.notEqual(f.mission.jobs.get('boat-01').leaseId,lease);
  f.flags.set('boat-01',{fix:false});f.advance(100);await flush(f);assert.equal(f.mission.snapshot('boat-01').status,'failed');assert.equal(f.mission.snapshot('boat-01').queue.completedLoops,0);
  f.flags.clear();f.feed('boat-01',ORIGIN);const updated=f.store.get('boat-01',routes[1].id);await start(f,[routes[0],updated],q);
  f.mission.stop('boat-01');await flush(f);assert.equal(f.mission.snapshot('boat-01').status,'stopped');
  const sent=f.commands().length;f.advance(500);assert.equal(f.commands().length,sent);
});

test('启动前核对整组速度与版本，未就绪不接管，重启只恢复队列定义',async t=>{
  const f=fixture(t),routes=pair(f,{}, {speedMps:3}),q=queue(f,routes);
  assert.throws(()=>f.mission.startQueue('boat-01',q.id,'start',2,[1,1]),{status:409});
  assert.throws(()=>f.mission.startQueue('boat-01',q.id,'start',1,[1,2]),{status:409});
  f.feed('boat-01',N.destination(ORIGIN,180,10));assert.throws(()=>f.mission.startQueue('boat-01',q.id,'start',1,[1,1]),/不在开始点/);
  f.feed('boat-01',ORIGIN);f.mission.startQueue('boat-01',q.id,'start',1,[1,1]);await until(()=>!f.mission.active('boat-01'));
  assert.match(f.mission.snapshot('boat-01').message,/超过船端/);assert.equal(f.commands().length,0);
  const reopened=new MissionService({bridge:f.bridge,control:f.control,store:new MissionStore({env:f.env})});t.after(()=>reopened.close());
  assert.equal(reopened.list().length,0);assert.deepEqual(reopened.store.getQueue('boat-01',q.id),q);
});

test('前后航线到点半径不同，转场从实际到达位置开始，不误报横向偏航',async t=>{
  const f=fixture(t),end=N.destination(ORIGIN,0,100),next=N.destination(end,90,100),arrival=N.destination(ORIGIN,0,60);
  const routes=pair(f,{arrivalRadiusM:50,points:[ORIGIN,end]},{arrivalRadiusM:2,points:[next,N.destination(next,90,30)]});
  await start(f,routes);await at(f,ORIGIN);await at(f,arrival);
  const run=f.mission.snapshot('boat-01');assert.equal(run.status,'running');assert.equal(run.phase,'transit');assert.ok(N.distance(run.transitionFrom,arrival)<.02);
  assert.ok(Math.abs(run.crossTrackM)<.02);assert.ok(N.distance(run.transitionFrom,end)>39);
});

test('队列HTTP约束权限、同源与版本；运行锁定组副本而允许删除来源，关闭会话后继续',async t=>{
  const f=fixture(t,{server:true}),routes=pair(f);await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.server.address().port;
  const call=async(path,{cookie,body,method='GET',origin=base}={})=>{const response=await fetch(base+path,{method,headers:{origin,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  const login=async(role)=>call('/api/auth/login',{method:'POST',body:{username:role==='admin'?'operator':'observer',password:role==='admin'?'browser-admin-test-only':'browser-guest-test-only'}});
  const admin=(await login('admin')).cookie,guest=(await login('guest')).cookie,body={deviceId:'boat-01',queue:{name:'HTTP队列',routeIds:routes.map(r=>r.id)}};
  assert.equal((await call('/api/missions/queue',{method:'POST',cookie:guest,body})).status,403);
  assert.equal((await call('/api/missions/queue',{method:'POST',cookie:admin,body,origin:'https://evil.test'})).status,403);
  assert.equal((await call('/api/missions/queue',{method:'POST',cookie:admin,body:{...body,extra:1}})).status,400);
  const saved=await call('/api/missions/queue',{method:'POST',cookie:admin,body});assert.equal(saved.status,200);const q=saved.data.queue;
  const get=await call('/api/missions?deviceId=boat-01',{cookie:admin});assert.deepEqual(get.data.queues,[q]);
  const startBody={deviceId:'boat-01',action:'queueStart',queueId:q.id,revision:q.revision,routeRevisions:[1,1]};
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:admin,body:{...startBody,routeRevisions:[1,2]}})).status,409);
  assert.equal((await call('/api/missions/run',{method:'POST',cookie:admin,body:startBody})).status,202);await until(()=>f.mission.snapshot('boat-01').status==='running');
  for(const route of routes){const request={deviceId:'boat-01',id:route.id,revision:route.revision};assert.equal((await call('/api/missions/route',{method:'DELETE',cookie:admin,body:request})).status,200);}
  assert.deepEqual(f.mission.jobs.get('boat-01').queue.routes.map(routeDefinition),q.routes,'删除来源不改变活动任务几何');
  assert.equal((await call('/api/missions/queue',{method:'POST',cookie:admin,body:{...body,id:q.id,revision:q.revision}})).status,409);
  assert.equal((await call('/api/missions/queue',{method:'DELETE',cookie:admin,body:{deviceId:'boat-01',id:q.id,revision:q.revision}})).status,409);
  await call('/api/auth/session',{method:'DELETE',cookie:admin});assert.equal(f.mission.active('boat-01'),true);
});

test('v5引用队列只在内存升级；首次写入v6保留曲线、重复副本和返航点',t=>{
  const f=fixture(t),routes=pair(f,{segments:[{type:'curve',control:P.defaultControl(ORIGIN,N.destination(ORIGIN,0,20))}]}),home=f.store.saveHome('boat-01',ORIGIN,0),saved=queue(f,[routes[0],routes[0],routes[1]]);
  const {routes:privateRoutes,...legacy}=saved;
  const old=JSON.stringify({version:5,routes,homes:[home],queues:[legacy]});fs.writeFileSync(f.store.file,old);
  const store=new MissionStore({env:f.env});assert.equal(store.error,'');assert.equal(fs.readFileSync(store.file,'utf8'),old,'读取不隐式写文件');
  const migrated=store.getQueue('boat-01',saved.id);assert.deepEqual(migrated.routes,privateRoutes);
  migrated.routes[0].points[1]=N.destination(ORIGIN,0,24);migrated.routes[0].segments[0].control=P.defaultControl(ORIGIN,migrated.routes[0].points[1]);
  const q=store.saveQueue('boat-01',{name:migrated.name,routeIds:migrated.routeIds,routes:migrated.routes},migrated.id,migrated.revision);
  assert.equal(JSON.parse(fs.readFileSync(store.file,'utf8')).version,6);assert.deepEqual(store.list('boat-01'),routes);assert.deepEqual(q.routes[1],privateRoutes[1]);
  const reload=new MissionStore({env:f.env});assert.equal(reload.error,'');assert.deepEqual(reload.getQueue('boat-01',q.id),q);assert.deepEqual(reload.getHome('boat-01'),home);
});

test('独立副本可编辑，重复来源互不影响，改删来源后仍可编辑保存和重启恢复',t=>{
  const f=fixture(t),routes=pair(f),q=queue(f,[routes[0],routes[0],routes[1]]),copies=structuredClone(q.routes);
  copies[0].points[1]=N.destination(ORIGIN,0,35);copies[0].name='单独调整';
  const edited=f.store.saveQueue('boat-01',{name:q.name,routeIds:q.routeIds,routes:copies},q.id,q.revision);
  assert.deepEqual(f.store.get('boat-01',routes[0].id),routes[0]);assert.deepEqual(edited.routes[1],q.routes[1]);assert.equal(edited.revision,2);
  f.store.save('boat-01',{...routeDefinition(routes[0]),points:[ORIGIN,N.destination(ORIGIN,90,50)]},routes[0].id,1);
  f.store.delete('boat-01',routes[1].id,1);assert.deepEqual(f.store.getQueue('boat-01',q.id).routes,copies);
  const again=f.store.saveQueue('boat-01',{name:'继续调整',routeIds:edited.routeIds,routes:copies},q.id,edited.revision);
  assert.deepEqual(new MissionStore({env:f.env}).getQueue('boat-01',q.id),again);assert.equal(f.store.resolveQueue('boat-01',again).length,3);
});

test('旧保存请求按出现顺序保留副本，新增来源复制当前定义，拒绝跨船和非法几何',t=>{
  const f=fixture(t),routes=pair(f),q=queue(f,[routes[0],routes[0]]),copies=structuredClone(q.routes);
  copies[0].points[1]=N.destination(ORIGIN,0,30);copies[1].points[1]=N.destination(ORIGIN,0,40);
  const saved=f.store.saveQueue('boat-01',{name:q.name,routeIds:q.routeIds,routes:copies},q.id,1);
  const next=f.store.saveQueue('boat-01',{name:q.name,routeIds:[routes[0].id,routes[1].id,routes[0].id]},q.id,saved.revision);
  assert.deepEqual(next.routes,[copies[0],routeDefinition(routes[1]),copies[1]]);
  const foreign=f.route('boat-02'),input={name:q.name,routeIds:[routes[0].id],routes:[copies[0]]};
  for(const routes of [[],[copies[0],copies[1]],[{...copies[0],id:q.id}],[{...copies[0],points:[ORIGIN,ORIGIN]}],[{...copies[0],segments:[{type:'curve',control:N.destination(ORIGIN,180,5)}]}]])assert.throws(()=>f.store.saveQueue('boat-01',{...input,routes}),{status:400});
  assert.throws(()=>f.store.saveQueue('boat-01',{...input,routeIds:[foreign.id]}),{status:404});
  assert.throws(()=>f.store.saveQueue('boat-01',{...input,routeIds:[foreign.id]},q.id,next.revision),{status:404});
  const before=fs.readFileSync(f.store.file,'utf8');
  assert.throws(()=>f.store.saveQueue('boat-01',input,q.id,next.revision,()=>{throw Object.assign(Error('expired'),{status:401});}),{status:401});assert.equal(fs.readFileSync(f.store.file,'utf8'),before);
});

for(const algorithm of [0,1])test('算法 '+algorithm+' 实际执行组内修改几何，来源修改删除不影响；暂停继续冻结旧副本',async t=>{
  const f=fixture(t,{algorithmControl:true}),routes=pair(f),q=queue(f,routes),copies=structuredClone(q.routes);
  copies[0].points[1]=N.destination(ORIGIN,0,40);copies[0].segments=[{type:'curve',control:P.defaultControl(ORIGIN,copies[0].points[1])}];
  const edited=f.store.saveQueue('boat-01',{name:q.name,routeIds:q.routeIds,routes:copies},q.id,1);
  f.store.delete('boat-01',routes[0].id,1);f.store.save('boat-01',{...routeDefinition(routes[1]),points:[routes[1].points[0],N.destination(ORIGIN,90,80)]},routes[1].id,1);
  assert.throws(()=>f.mission.startQueue('boat-01',q.id,'start',q.revision,[1,1]),{status:409});
  assert.throws(()=>f.mission.startQueue('boat-01',q.id,'start',edited.revision,[1,1]),{status:409});
  f.algorithms.set('boat-01',algorithm);f.feed();await start(f,routes,edited);await at(f,ORIGIN);
  assert.deepEqual(f.mission.snapshot('boat-01').route.points,copies[0].points);assert.equal(f.mission.jobs.get('boat-01').geometry.segments[0].curved,true);
  await at(f,routes[0].points[1]);assert.equal(f.mission.snapshot('boat-01').queue.routeIndex,0,'到达原终点不提前转场');
  f.mission.pause('boat-01');await flush(f);const paused=f.mission.snapshot('boat-01');
  const changed=structuredClone(copies);changed[0].points[1]=N.destination(ORIGIN,0,60);
  f.store.saveQueue('boat-01',{name:q.name,routeIds:q.routeIds,routes:changed},q.id,edited.revision);
  f.advance(100);f.mission.resume('boat-01',paused.runId);await until(()=>f.mission.snapshot('boat-01').status==='running');
  assert.deepEqual(f.mission.snapshot('boat-01').route.points,copies[0].points,'继续仍用暂停快照');
  await at(f,copies[0].points[1]);assert.equal(f.mission.snapshot('boat-01').phase,'transit');
  await at(f,copies[1].points[0]);await at(f,copies[1].points[1]);assert.equal(f.mission.snapshot('boat-01').status,'completed');
});

test('组起点改变后前往起点采用副本坐标；原起点不能直接启动',async t=>{
  const f=fixture(t),routes=pair(f),q=queue(f,routes),copies=structuredClone(q.routes);copies[0].points[0]=N.destination(ORIGIN,270,15);
  const edited=f.store.saveQueue('boat-01',{name:q.name,routeIds:q.routeIds,routes:copies},q.id,1);
  assert.throws(()=>f.mission.startQueue('boat-01',q.id,'start',edited.revision,[2,2]),/不在开始点/);
  await start(f,routes,edited,'goto');assert.deepEqual(f.mission.snapshot('boat-01').route.points[0],copies[0].points[0]);
  await at(f,copies[0].points[0]);assert.equal(f.mission.snapshot('boat-01').status,'completed');assert.equal(f.mission.snapshot('boat-01').queue.completedLoops,0);
});

test('HTTP可保存32条256点的完整组副本，独立限制2MiB且不放宽单航线请求',async t=>{
  const f=fixture(t,{server:true}),route=f.route('boat-01',{points:Array.from({length:256},(_,i)=>N.destination(ORIGIN,0,i))});
  await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.server.address().port;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'browser-admin-test-only'})}),cookie=login.headers.get('set-cookie').split(';')[0];
  const send=(path,body)=>fetch(base+path,{method:'POST',headers:{origin:base,'content-type':'application/json',cookie},body:JSON.stringify(body)});
  const input={deviceId:'boat-01',queue:{name:'完整组',routeIds:Array(32).fill(route.id),routes:Array.from({length:32},()=>routeDefinition(route))}};
  assert.ok(Buffer.byteLength(JSON.stringify(input))>100000);const response=await send('/api/missions/queue',input);assert.equal(response.status,200);const saved=(await response.json()).queue;
  assert.equal(saved.routes.length,32);assert.equal(saved.routes[31].points.length,256);assert.deepEqual(new MissionStore({env:f.env}).getQueue('boat-01',saved.id),saved);
  assert.equal((await send('/api/missions/queue',{...input,padding:'x'.repeat(2*1024*1024)})).status,413);
  assert.equal((await send('/api/missions/route',{deviceId:'boat-01',route:routeDefinition(route),padding:'x'.repeat(100001)})).status,413);
});
