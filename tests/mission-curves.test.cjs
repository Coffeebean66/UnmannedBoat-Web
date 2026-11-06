'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const N=require('../public/utils/missionNavigation'),P=require('../public/utils/missionPath');
const {MissionStore,normalizeRoute}=require('../server/mission-store');
const {createMissionFixture,ORIGIN}=require('./mission-fixture.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<120;i++){if(check())return;await wait(5);}throw Error('Curve mission condition timed out');}
function fixture(t,options){const f=createMissionFixture(options);t.after(()=>f.close());return f;}
function definition(origin=ORIGIN){
  const end=N.destination(origin,0,100),control=N.destination(N.destination(origin,0,50),90,140);
  return {name:'弯曲巡航',speedMps:1,arrivalRadiusM:1,points:[origin,end],segments:[{type:'curve',control}]};
}

test('quadratic path uses metre geometry, preserves anchors and bounds approximation away from its control point',()=>{
  for(const origin of [ORIGIN,{latitude:80,longitude:179.9995},{latitude:-25,longitude:-179.9995}]){
    const d=definition(origin),geometry=P.compile(d),segment=geometry.segments[0];
    assert.deepEqual(geometry.points[0],origin);assert.deepEqual(geometry.points.at(-1),d.points[1]);
    assert.ok(geometry.points.length>10&&geometry.points.length<300);
    const exactLength=(Math.hypot(280,100)+10000/280*Math.asinh(2.8))/2;
    assert.ok(Math.abs(geometry.lengthM-exactLength)<.2,'Sampled length agrees with the independent analytic arc length');
    const halfway=P.at(segment,segment.lengthM/2),g=P.guide(halfway,segment,8);
    assert.ok(N.distance(halfway,d.segments[0].control)>60,'The control point is not a compulsory waypoint');
    assert.ok(Math.abs(g.crossM)<.01);assert.ok(Math.abs(g.remainingM-segment.lengthM/2)<.1);
    assert.ok(g.heading>300||g.heading<60,'At the middle, navigation follows the curve tangent northwards');
    for(let i=0;i<=100;i++){
      const t=i/100,east=280*t*(1-t),north=100*t;
      const truePoint=N.destination(origin,N.wrap(Math.atan2(east,north)*180/Math.PI),Math.hypot(east,north));
      assert.ok(P.guide(truePoint,segment,0).away<.16,'Preview approximation must stay within 0.15m plus geographic rounding');
    }
  }
  const straight={points:[ORIGIN,N.destination(ORIGIN,0,20),N.destination(ORIGIN,90,30)]};
  assert.deepEqual(P.compile(straight).points,straight.points,'Legacy straight paths retain their original coordinates');
});

test('curve metadata validates strictly and persists in v5; v1/v2/v3 libraries and home points migrate without rewriting on read',t=>{
  const f=fixture(t),d=definition(),r=f.route('boat-01',d),reopened=new MissionStore({env:f.env});
  assert.equal(reopened.error,'');assert.deepEqual(reopened.get('boat-01',r.id),r);
  assert.equal(JSON.parse(fs.readFileSync(f.store.file,'utf8')).version,5);
  for(const segments of [[],[null],[{type:'spline'}],[{type:'line',control:ORIGIN}],[{type:'curve',control:{...ORIGIN,height:1}}],[{type:'curve',control:{latitude:NaN,longitude:0}}],[{type:'curve',control:N.destination(ORIGIN,180,10)}]]){
    assert.throws(()=>normalizeRoute({...d,segments}),{status:400});
  }
  const far={...d,points:[ORIGIN,N.destination(ORIGIN,0,15000)],segments:[{type:'curve',control:N.destination(N.destination(ORIGIN,0,7500),90,18000)}]};
  assert.throws(()=>normalizeRoute(far),/实际长度/);
  const normal=f.route('boat-02'),home=f.store.saveHome('boat-02',ORIGIN,0);
  for(const version of [1,2,3]){
    const route=structuredClone(normal);if(version===1){delete route.loopEnabled;delete route.loopCount;}
    const library={version,routes:[route],...(version===3?{homes:[home]}:{})};
    fs.writeFileSync(f.store.file,JSON.stringify(library));const old=new MissionStore({env:f.env});
    assert.equal(old.error,'');assert.deepEqual(old.get('boat-02',normal.id),normal);assert.equal(JSON.parse(fs.readFileSync(f.store.file,'utf8')).version,version);
    old.save('boat-01',d);const migrated=new MissionStore({env:f.env});assert.equal(migrated.error,'');assert.deepEqual(migrated.list('boat-01')[0].segments,d.segments);
    if(version===3)assert.deepEqual(migrated.getHome('boat-02'),home);
  }
});

for(const algorithm of [0,1])test('server follows an actual curve with '+(algorithm?'LQR':'PID')+', keeps anchor numbering and resumes the same curved route',async t=>{
  const f=fixture(t,{algorithmControl:true}),d=definition(),r=f.route('boat-01',d);
  f.algorithms.set('boat-01',algorithm);f.feed('boat-01',{heading:70});f.mission.start('boat-01',r.id,'start');
  await until(()=>f.mission.snapshot('boat-01').status==='running');f.advance(100);
  let state=f.mission.snapshot('boat-01');assert.equal(state.targetIndex,1);assert.equal(state.pointCount,2);assert.ok(state.targetHeading>35&&state.targetHeading<100,'Initial desired course turns into the curve instead of taking its chord');
  const geometry=P.compile(r).segments[0];
  for(const progress of [.15,.3,.5]){
    const p=P.at(geometry,geometry.lengthM*progress),g=P.guide(p,geometry,5);
    f.advance(100,'boat-01',{...p,heading:g.courseHeading});await Promise.resolve();
    state=f.mission.snapshot('boat-01');assert.equal(state.status,'running');assert.equal(state.targetIndex,1);assert.ok(Math.abs(state.crossTrackM)<.3);assert.ok(state.commandSpeedMps>.5,'Sample vertices do not cause stop/start pulses');
  }
  const oldLease=f.mission.jobs.get('boat-01').leaseId;f.mission.pause('boat-01');await Promise.resolve();f.mission.refresh();assert.equal(f.mission.snapshot('boat-01').status,'paused');
  f.mission.resume('boat-01',f.mission.snapshot('boat-01').runId);await until(()=>f.mission.snapshot('boat-01').status==='running');
  assert.notEqual(f.mission.jobs.get('boat-01').leaseId,oldLease);assert.equal(f.mission.jobs.get('boat-01').geometry.segments[0].curved,true);
  for(const progress of [.7,.9]){const p=P.at(geometry,geometry.lengthM*progress),g=P.guide(p,geometry,5);f.advance(100,'boat-01',{...p,heading:g.courseHeading});await Promise.resolve();assert.equal(f.mission.snapshot('boat-01').status,'running');}
  f.advance(100,'boat-01',{...d.points[1],heading:290});await Promise.resolve();assert.equal(f.mission.snapshot('boat-01').status,'running');
  f.advance(100);await Promise.resolve();f.mission.refresh();assert.equal(f.mission.snapshot('boat-01').status,'completed');assert.equal(f.mission.snapshot('boat-01').stopConfirmed,true);
});

test('curve tracking rejects chord shortcuts and stale feedback while overlapping endpoint radii cannot skip the bend',async t=>{
  const f=fixture(t),d=definition(),r=f.route('boat-01',d);f.mission.start('boat-01',r.id,'start');await until(()=>f.mission.snapshot('boat-01').status==='running');f.advance(100);
  f.advance(100,'boat-01',N.destination(ORIGIN,0,50));await Promise.resolve();f.mission.refresh();assert.equal(f.mission.snapshot('boat-01').status,'failed');assert.match(f.mission.snapshot('boat-01').message,/偏离/);
  f.feed('boat-01',{...ORIGIN,heading:90});const close=f.route('boat-01',{...d,points:[ORIGIN,N.destination(ORIGIN,0,1)],segments:[{type:'curve',control:N.destination(N.destination(ORIGIN,0,.5),90,50)}],arrivalRadiusM:3});
  f.mission.start('boat-01',close.id,'start');await until(()=>f.mission.snapshot('boat-01').status==='running');
  for(let i=0;i<4;i++){f.advance(100);await Promise.resolve();assert.equal(f.mission.snapshot('boat-01').status,'running');}
  assert.equal(f.mission.snapshot('boat-01').targetIndex,1);assert.ok(f.mission.snapshot('boat-01').distanceM>40);
  f.flags.set('boat-01',{fix:false});f.advance(100);await Promise.resolve();f.mission.refresh();assert.equal(f.mission.snapshot('boat-01').status,'failed');
});

test('curved loop finishes the bend, returns along the original straight closing leg and stops at its start',async t=>{
  const f=fixture(t),d={...definition(),loopEnabled:true,loopCount:1},r=f.route('boat-01',d);f.mission.start('boat-01',r.id,'start');await until(()=>f.mission.snapshot('boat-01').status==='running');f.advance(100);
  const curve=P.compile(r).segments[0];for(const fraction of [.25,.5,.75,1]){const p=P.at(curve,curve.lengthM*fraction);f.advance(100,'boat-01',{...p,heading:P.guide(p,curve,5).courseHeading});await Promise.resolve();}
  f.advance(100);await Promise.resolve();assert.equal(f.mission.snapshot('boat-01').phase,'returning');
  f.advance(100,'boat-01',{...N.destination(ORIGIN,0,50),heading:180});await Promise.resolve();const state=f.mission.snapshot('boat-01');assert.equal(state.status,'running');assert.ok(Math.abs(state.crossTrackM)<.1);assert.ok(Math.abs(N.angleError(state.targetHeading,180))<.1);
  f.advance(100,'boat-01',ORIGIN);await Promise.resolve();f.advance(100);await Promise.resolve();f.mission.refresh();assert.equal(f.mission.snapshot('boat-01').status,'completed');assert.equal(f.mission.snapshot('boat-01').completedLoops,1);
});
