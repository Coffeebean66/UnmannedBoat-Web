/* 最优航线的数值模型与真实任务执行器回归，不连接实际船舶。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const L=require('../server/optimal-guidance'),N=require('../public/utils/missionNavigation');
const {createMissionFixture,ORIGIN}=require('./mission-fixture.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<120;++i){if(fn())return;await wait(5);}throw Error('Control condition timed out');}
function fixture(t){const f=createMissionFixture({algorithmControl:true});t.after(()=>f.close());return f;}
async function select(f,id,algorithm){await f.bridge.requestParameters(id,'algorithm',{algorithm});f.feed(id);}
async function flush(f){await Promise.resolve();await Promise.resolve();f.mission.refresh();}

test('route LQR corrects either side, damps heading, wraps north, limits offsets and captures the true endpoint',()=>{
  const end=N.destination(ORIGIN,0,100),l=L.create(1);
  assert.ok(l.gain.every(x=>x>0&&Number.isFinite(x)));
  const east={...N.destination(ORIGIN,90,10),heading:0},west={...N.destination(ORIGIN,270,10),heading:0};
  assert.ok(N.angleError(l.guide(east,ORIGIN,end,3).heading,0)<0);
  assert.ok(N.angleError(l.guide(west,ORIGIN,end,3).heading,0)>0);
  const p=N.destination(ORIGIN,0,30);
  const a=N.angleError(l.guide({...p,heading:359},ORIGIN,end,3).heading,0),b=N.angleError(l.guide({...p,heading:1},ORIGIN,end,3).heading,0);
  assert.ok(a>0&&b<0&&Math.abs(a+b)<.01);
  assert.ok(Math.abs(N.angleError(l.guide({...N.destination(ORIGIN,90,200),heading:90},ORIGIN,end,3).heading,0))<=60.001);
  const beyond={...N.destination(end,0,5),heading:0},terminal=l.guide(beyond,ORIGIN,end,3);
  assert.ok(Math.abs(N.angleError(terminal.heading,N.bearing(beyond,end)))<.001);
  for(const speed of [.1,1,3,20])assert.ok(L.create(speed).gain.every(Number.isFinite));
  for(const speed of [0,-1,21,NaN,Infinity])assert.throws(()=>L.create(speed));
  for(const extra of [{headingTauS:0},{crossWeight:-1},{inputWeight:NaN},{maxOffsetDeg:90}])assert.throws(()=>L.create(1,{...L.CONFIG,...extra}));
  assert.throws(()=>L.solve([1,.1,0,1],[0,0],[1,1],1));
});

test('route LQR converges with a delayed heading model from positive/negative cross-track and near-north headings',()=>{
  for(const [offset,heading] of [[15,0],[-15,359],[6,30]]){
    const l=L.create(1),end=N.destination(ORIGIN,0,1000);let p={...N.destination(ORIGIN,offset<0?270:90,Math.abs(offset)),heading};
    for(let i=0;i<2000;i++){
      const g=l.guide(p,ORIGIN,end,3),error=N.angleError(g.heading,p.heading);
      p={...N.destination(p,N.wrap(p.heading+error*(1-Math.exp(-.1/1.2))),.1),heading:N.wrap(p.heading+error*(1-Math.exp(-.1/1.2)))};
      assert.ok(Number.isFinite(p.latitude)&&Number.isFinite(p.heading));
    }
    assert.ok(Math.abs(l.guide(p,ORIGIN,end,3).crossM)<.03);
    assert.ok(Math.abs(N.angleError(p.heading,0))<.05);
  }
});

test('per-boat MCU selection chooses all mission guidance, preserves locks and stops on algorithm loss/change',async t=>{
  const f=fixture(t),r=f.route();f.feed('boat-02');const other=f.route('boat-02');
  await select(f,'boat-01',1);assert.equal(f.bridge.get('boat-02').controlAlgorithm.id,0);
  f.mission.start('boat-01',r.id,'start');f.mission.start('boat-02',other.id,'start');
  await until(()=>f.mission.jobs.get('boat-01')?.status==='running'&&f.mission.jobs.get('boat-02')?.status==='running');
  const lqr=f.mission.jobs.get('boat-01'),pid=f.mission.jobs.get('boat-02');
  assert.equal(lqr.algorithm,1);assert.ok(lqr.optimal);assert.equal(pid.algorithm,0);assert.equal(pid.optimal,undefined);
  await assert.rejects(f.bridge.requestParameters('boat-01','algorithm',{algorithm:0}),{status:409});
  f.advance(100);await flush(f);f.advance(100,'boat-02');await flush(f);
  const p={...N.destination(N.destination(ORIGIN,0,10),90,8),heading:0};f.advance(100,'boat-01',p);await flush(f);
  const g=L.create(r.speedMps).guide(p,r.points[0],r.points[1],r.arrivalRadiusM);
  assert.ok(Math.abs(N.angleError(f.mission.snapshot('boat-01').targetHeading,g.heading))<.001);
  assert.equal(f.mission.snapshot('boat-01').algorithm,1);
  f.algorithms.set('boat-01',0);f.advance(100);await flush(f);await flush(f);
  assert.equal(f.mission.snapshot('boat-01').status,'failed');assert.match(f.mission.snapshot('boat-01').message,/算法/);
  assert.equal(f.commands().filter(x=>x.topic.includes('/boat-01/')).at(-1).payload.readInt16LE(30),0);
  assert.equal(f.mission.active('boat-02'),true);
});

test('LQR goto and finite loop retain two-sample arrival, return leg and confirmed final stop',async t=>{
  const f=fixture(t),r=f.route('boat-01',{loopEnabled:true,loopCount:2});await select(f,'boat-01',1);
  f.feed('boat-01',N.destination(ORIGIN,180,20));f.mission.start('boat-01',r.id,'goto');
  await until(()=>f.mission.jobs.get('boat-01')?.status==='running');
  for(let i=0;i<2;++i){f.advance(100,'boat-01',ORIGIN);await flush(f);}await flush(f);
  assert.equal(f.mission.snapshot('boat-01').status,'completed');assert.equal(f.mission.snapshot('boat-01').stopConfirmed,true);
  f.feed();f.mission.start('boat-01',r.id,'start');await until(()=>f.mission.jobs.get('boat-01')?.status==='running');
  f.advance(100);await flush(f);
  for(let lap=0;lap<2;++lap)for(const p of [...r.points.slice(1),ORIGIN])for(let i=0;i<2;++i){f.advance(100,'boat-01',p);await flush(f);}
  await flush(f);const result=f.mission.snapshot('boat-01');
  assert.equal(result.status,'completed');assert.equal(result.completedLoops,2);assert.equal(result.algorithm,1);assert.equal(result.stopConfirmed,true);
});
