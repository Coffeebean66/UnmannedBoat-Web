'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createServer}=require('../server');
const {PREFIX,resolveStartupSettingsFile}=require('../server/startup-settings-api');
const ORIGIN='https://startup.test';
function request(port,route,{method='GET',body,raw,cookie,origin=ORIGIN,headers={}}={}){
  const payload=raw!==undefined?raw:body!==undefined?JSON.stringify(body):undefined;
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),...(payload!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,headers:res.headers,raw,data});});
    });req.on('error',reject);req.end(payload);
  });
}
async function fixture(t,{env:extra={},beforeBoot}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-startup-')),file=path.join(directory,'state/startup-settings.json');
  const env={STATE_DIRECTORY:directory,BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'admin',BOAT_ADMIN_PASSWORD:'startup-admin-test',BOAT_GUEST_USERNAME:'guest',BOAT_GUEST_PASSWORD:'startup-guest-test',BOAT_ACCOUNTS_ORIGIN:ORIGIN,BOAT_ACCOUNTS_FILE:path.join(directory,'accounts.json'),...extra};
  let server;
  const boot=async()=>{server=createServer({env,startupOptions:{file,bodyTimeoutMs:100}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
  if(beforeBoot)beforeBoot({directory,file});await boot();
  t.after(async()=>{if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}assert.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));assert.match(path.basename(directory),/^boat-startup-/);fs.rmSync(directory,{recursive:true,force:true});});
  const call=(route,options)=>request(server.address().port,route,options);
  return {file,directory,call,get server(){return server;},async restart(){await new Promise(resolve=>server.close(resolve));await boot();},
    async login(username='admin',password=username==='admin'?'startup-admin-test':'startup-guest-test'){const result=await call('/api/auth/login',{method:'POST',body:{username,password}});assert.equal(result.status,200,result.raw);return result.headers['set-cookie'][0].split(';')[0];},
    save:(cookie,revision=0,enabled=false)=>call(PREFIX,{method:'PUT',cookie,body:{revision,enabled}})};
}
test('启动开关登录前可读，默认开启，禁用账户时仍可读但不可写',async t=>{
  const f=await fixture(t),result=await f.call(PREFIX,{origin:null});
  assert.equal(result.status,200);assert.equal(result.data.enabled,true);assert.equal(result.data.revision,0);assert.equal(result.headers['cache-control'],'no-store');
  assert.deepEqual(Object.keys(result.data).sort(),['enabled','error','persistent','revision','updatedAt','version']);
  assert.equal((await f.save()).status,401);
  const disabled=await fixture(t,{env:{BOAT_ACCOUNTS_ENABLED:'0'}});
  assert.equal((await disabled.call(PREFIX)).status,200);assert.equal((await disabled.save()).status,503);
});
test('仅管理员可修改，驾驶员、访客、跨站和退出会话均不可写',async t=>{
  const f=await fixture(t),admin=await f.login(),guest=await f.login('guest');
  assert.equal((await f.call('/api/auth/users',{method:'POST',cookie:admin,body:{username:'pilot',password:'startup-pilot-test',role:'driver'}})).status,201);
  const driver=await f.login('pilot','startup-pilot-test');
  for(const cookie of [guest,driver]){assert.equal((await f.call(PREFIX,{cookie})).status,200);assert.equal((await f.save(cookie)).status,403);}
  for(const origin of [null,'https://evil.test'])assert.equal((await f.call(PREFIX,{method:'PUT',cookie:admin,origin,body:{revision:0,enabled:false}})).status,403);
  assert.equal((await f.call('/api/auth/session',{method:'DELETE',cookie:admin})).status,200);
  assert.equal((await f.save(admin)).status,401);assert.equal(fs.existsSync(f.file),false);
});
test('开关原子保存，重启后恢复，旧版本冲突不覆盖，管理员可再次启用',async t=>{
  const f=await fixture(t),admin=await f.login(),saved=await f.save(admin);
  assert.equal(saved.status,200,saved.raw);assert.equal(saved.data.enabled,false);assert.equal(saved.data.revision,1);
  const original=fs.readFileSync(f.file,'utf8');assert.equal((await f.save(admin,0,true)).status,409);assert.equal(fs.readFileSync(f.file,'utf8'),original);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)),['startup-settings.json']);
  await f.restart();assert.deepEqual((await f.call(PREFIX)).data,saved.data);
  assert.equal((await f.save(await f.login(),1,true)).status,200);assert.equal(f.server.boatStartupApi.snapshot().enabled,true);
});
test('严格拒绝非法开关、版本、额外字段、请求格式和大包',async t=>{
  const f=await fixture(t),admin=await f.login(),valid={enabled:true,revision:0};
  for(const body of [null,[],{},...['false',1,null].map(enabled=>({...valid,enabled})),...[-1,1.2,'0'].map(revision=>({...valid,revision})),{...valid,role:'admin'}])assert.equal((await f.call(PREFIX,{method:'PUT',cookie:admin,body})).status,400);
  assert.equal((await f.call(PREFIX,{method:'PUT',cookie:admin,raw:'{'})).status,400);
  assert.equal((await f.call(PREFIX,{method:'PUT',cookie:admin,raw:'{}',headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await f.call(PREFIX,{method:'PUT',cookie:admin,raw:'x'.repeat(2000)})).status,413);
  assert.equal((await f.call(PREFIX,{method:'DELETE',cookie:admin})).status,405);
  assert.equal((await f.call(PREFIX+'/unknown')).status,404);assert.equal(fs.existsSync(f.file),false);
});
test('损坏配置回退默认值并提示管理员；保存后修复；写入失败不改变内存状态',async t=>{
  const f=await fixture(t,{beforeBoot({file}){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{');}});
  assert.equal((await f.call(PREFIX)).data.enabled,true);assert.match((await f.call(PREFIX)).data.error,/无法读取/);
  assert.equal((await f.save(await f.login())).data.error,null);
  const blocked=await fixture(t,{beforeBoot({file}){fs.writeFileSync(path.dirname(file),'file blocks directory');}});
  const before=(await blocked.call(PREFIX)).data;
  assert.equal((await blocked.save(await blocked.login())).status,503);assert.deepEqual((await blocked.call(PREFIX)).data,before);
});
test('默认状态目录与更新持久化目录，显式配置路径须为绝对路径',()=>{
  const root=path.join(os.tmpdir(),'boat-startup-path');
  assert.equal(resolveStartupSettingsFile({STATE_DIRECTORY:root}),path.join(root,'startup-settings.json'));
  assert.equal(resolveStartupSettingsFile({BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_STATE_DIR:root}),path.join(root,'requests/startup-settings.json'));
  assert.equal(resolveStartupSettingsFile({BOAT_STARTUP_SETTINGS_FILE:path.join(root,'custom.json')}),path.join(root,'custom.json'));
  assert.throws(()=>resolveStartupSettingsFile({},'relative.json'));
});
