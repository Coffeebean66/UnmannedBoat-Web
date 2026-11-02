/* 使用本地模拟船实际走参数、接管和任务接口，不连接实船或生产服务器。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createMissionFixture,CLIENT}=require('./mission-fixture.cjs');
async function fixture(t){
  const f=createMissionFixture({server:true,algorithmControl:true});t.after(()=>f.close());
  await new Promise(resolve=>f.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+f.server.address().port;
  const call=async(route,{cookie,body,method='GET',origin=base}={})=>{
    const response=await fetch(base+route,{method,headers:{origin,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(username,password)=>(await call('/api/auth/login',{method:'POST',body:{username,password}})).cookie;
  const admin=await login('operator','browser-admin-test-only');
  assert.equal((await call('/api/auth/users',{cookie:admin,method:'POST',body:{username:'pilot',password:'driver-test-only',role:'driver'}})).status,201);
  const driver=await login('pilot','driver-test-only');
  return {f,call,admin,driver};
}

test('driver reads parameters, switches algorithm, acquires real control and loses its lease when demoted',async t=>{
  const {f,call,admin,driver}=await fixture(t);
  let result=await call('/api/cloud/parameters',{cookie:driver,method:'POST',body:{deviceId:'boat-01',kind:'read'}});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(Buffer.from(result.data.frame,'base64').length);
  f.feed();result=await call('/api/cloud/parameters',{cookie:driver,method:'POST',body:{deviceId:'boat-01',kind:'algorithm',values:{algorithm:1}}});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(f.algorithms.get('boat-01'),1);
  assert.equal((await call('/api/firmware/config',{cookie:driver})).status,200);
  assert.equal((await call('/api/firmware/boats/boat-01',{cookie:driver})).status,200);
  const input={deviceId:'boat-01',clientId:CLIENT,mode:2,throttle:0,turn:0,targetHeading:0};
  assert.equal((await call('/api/cloud/control',{cookie:driver,method:'POST',body:{...input,action:'acquire'},origin:'https://foreign.test'})).status,403);
  result=await call('/api/cloud/control',{cookie:driver,method:'POST',body:{...input,action:'acquire'}});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.active,true);
  const id=(await call('/api/auth/users',{cookie:admin})).data.users.find(user=>user.role==='driver').id;
  assert.equal((await call('/api/auth/users/'+id,{cookie:admin,method:'PATCH',body:{username:'pilot',role:'guest'}})).status,200);
  assert.equal((await call('/api/cloud/control?deviceId=boat-01&clientId='+CLIENT,{cookie:driver})).status,401);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.control.jobs.has('boat-01'),false);
  assert.equal(f.commands().at(-1).payload.readInt16LE(30),0);
});

test('driver saves, starts and stops a server mission while platform configuration stays inaccessible',async t=>{
  const {f,call,driver}=await fixture(t),draft=f.route();
  let result=await call('/api/missions/route',{cookie:driver,method:'POST',body:{deviceId:'boat-01',route:{name:'驾驶员航线',speedMps:1,arrivalRadiusM:3,points:draft.points}}});
  assert.equal(result.status,200,JSON.stringify(result.data));const route=result.data.route;
  result=await call('/api/missions/run',{cookie:driver,method:'POST',body:{deviceId:'boat-01',routeId:route.id,revision:route.revision,action:'start'}});
  assert.equal(result.status,202,JSON.stringify(result.data));
  for(let i=0;i<20&&f.mission.snapshot('boat-01').status!=='running';i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.mission.snapshot('boat-01').status,'running');
  const runId=f.mission.snapshot('boat-01').runId;
  assert.equal((await call('/api/missions/run',{cookie:driver,method:'POST',body:{deviceId:'boat-01',action:'stop',runId}})).status,202);
  for(const path of ['/api/auth/users','/api/auth/online','/api/map/settings','/api/mqtt/devices'])assert.equal((await call(path,{cookie:driver})).status,403,path);
  for(const [path,body] of [['/api/map/settings',{amapKey:'x',amapSecurityCode:'x'}],['/api/video/recording/config',{directory:'/var/lib/unmanned-boat-video/driver'}]])
    assert.equal((await call(path,{cookie:driver,method:'PATCH',body})).status,403,path);
});
