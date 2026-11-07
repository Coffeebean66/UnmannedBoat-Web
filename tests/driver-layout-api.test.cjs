'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createServer}=require('../server');
const {resolveDriverLayoutFile,PREFIX}=require('../server/driver-layout-api');
const {normalizeCloudLayout,normalizeProfiles}=require('../public/utils/driverLayout');
const ORIGIN='https://layout.test';
const layout=()=>({version:1,profiles:{'desktop:video':{map:{x:.6,y:.1,width:400,height:250,opacity:85},horizon:{x:.1,y:.2,width:180,height:180,opacity:70},motors:{floating:true,width:350,height:200},emergency:{x:.8,y:.9,opacity:100}},'mobile:map':{video:{x:.4,y:.1,width:170,height:125}}},preferences:{overlayOpacity:80,instrumentsVisible:true,primary:'video'}});
function request(port,route,{method='GET',body,raw,cookie,origin=ORIGIN,headers={}}={}){
  const data=raw!==undefined?raw:body!==undefined?JSON.stringify(body):undefined;
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),...(data!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...headers}},res=>{
      const chunks=[];res.on('data',data=>chunks.push(data));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,headers:res.headers,raw,data});});
    });req.on('error',reject);req.end(data);
  });
}
async function fixture(t,{beforeBoot,env:extra={},file:explicit}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-driver-layout-')),file=explicit||path.join(directory,'state','driver-layout.json');
  const env={BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'admin',BOAT_ADMIN_PASSWORD:'layout-admin-test',BOAT_GUEST_USERNAME:'guest',BOAT_GUEST_PASSWORD:'layout-guest-test',BOAT_ACCOUNTS_ORIGIN:ORIGIN,BOAT_ACCOUNTS_FILE:path.join(directory,'accounts.json'),...extra};
  let server;
  const boot=async()=>{server=createServer({env,driverLayoutOptions:{file,bodyTimeoutMs:100},mapOptions:{file:path.join(directory,'map.json')}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
  if(beforeBoot)beforeBoot({directory,file});await boot();
  t.after(async()=>{if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}assert.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));assert.match(path.basename(directory),/^boat-driver-layout-/);fs.rmSync(directory,{recursive:true,force:true});});
  const call=(route,options)=>request(server.address().port,route,options);
  return {directory,file,call,get server(){return server;},async restart(){await new Promise(resolve=>server.close(resolve));await boot();},
    async login(username='admin',password=username==='admin'?'layout-admin-test':'layout-guest-test'){const result=await call('/api/auth/login',{method:'POST',body:{username,password}});assert.equal(result.status,200,result.raw);return result.headers['set-cookie'][0].split(';')[0];},
    upload:(cookie,revision=0,value=layout())=>call(PREFIX,{method:'PUT',cookie,body:{revision,layout:value}}),
    enabled:(cookie,revision,enabled)=>call(PREFIX,{method:'PATCH',cookie,body:{revision,enabled}})};
}
test('云端布局只允许管理员上传和启停；驾驶员与访客可读，匿名与跨站写入拒绝',async t=>{
  const f=await fixture(t);assert.equal((await f.call(PREFIX)).status,401);
  const admin=await f.login(),guest=await f.login('guest');
  assert.equal((await f.call('/api/auth/users',{method:'POST',cookie:admin,body:{username:'pilot',password:'pilot-layout-test',role:'driver'}})).status,201);
  const pilot=await f.login('pilot','pilot-layout-test');
  for(const cookie of [guest,pilot]){
    assert.equal((await f.call(PREFIX,{cookie})).status,200);
    assert.equal((await f.upload(cookie)).status,403);assert.equal((await f.enabled(cookie,0,true)).status,403);
  }
  for(const origin of [null,'https://evil.test'])assert.equal((await f.call(PREFIX,{method:'PUT',cookie:admin,origin,body:{revision:0,layout:layout()}})).status,403);
  assert.equal(fs.existsSync(f.file),false);
  const legacy=await fixture(t,{env:{BOAT_ACCOUNTS_ENABLED:'0'}});assert.equal((await legacy.call(PREFIX)).status,503);
});
test('上传不自动启用，所有用户读取同一布局；启停与整套屏幕分组在服务重启后保留',async t=>{
  const f=await fixture(t),admin=await f.login();
  assert.equal((await f.enabled(admin,0,true)).status,409);
  const saved=await f.upload(admin);assert.equal(saved.status,200,saved.raw);assert.equal(saved.data.enabled,false);assert.equal(saved.data.revision,1);assert.deepEqual(saved.data.layout,layout());
  const published=await f.enabled(admin,1,true);assert.equal(published.status,200,published.raw);assert.equal(published.data.enabled,true);
  assert.deepEqual((await f.call(PREFIX,{cookie:await f.login('guest')})).data,published.data);
  const stored=fs.readFileSync(f.file,'utf8');assert.doesNotMatch(stored,/password|lease|clientId|mode/);
  await f.restart();const owner=await f.login(),current=await f.call(PREFIX,{cookie:owner});assert.equal(current.headers['cache-control'],'no-store');assert.deepEqual(current.data,published.data);
  const disabled=await f.enabled(owner,2,false);assert.equal(disabled.data.enabled,false);assert.deepEqual(disabled.data.layout,layout());
  await f.restart();assert.equal((await f.call(PREFIX,{cookie:await f.login()})).data.enabled,false);
});
test('旧版本请求无法覆盖新布局；启用时先停用再上传，未确认的保存不影响已发布配置',async t=>{
  const f=await fixture(t),admin=await f.login();await f.upload(admin);await f.enabled(admin,1,true);
  const previous=fs.readFileSync(f.file,'utf8');
  assert.equal((await f.upload(admin,0)).status,409);assert.equal((await f.enabled(admin,1,false)).status,409);assert.equal((await f.upload(admin,2)).status,409);
  assert.equal(fs.readFileSync(f.file,'utf8'),previous);
  await f.enabled(admin,2,false);const replacement=layout();replacement.preferences.primary='map';
  const result=await f.upload(admin,3,replacement);assert.equal(result.status,200,result.raw);assert.equal(result.data.enabled,false);assert.equal(result.data.layout.preferences.primary,'map');
});
test('只接受显示字段，拒绝任意样式、接管数据、非法布局和超大请求；本机旧档仍可归一化',async t=>{
  const f=await fixture(t),admin=await f.login();
  const invalid=[];let value;
  value=layout();value.leaseId='fake-lease';invalid.push(value);
  value=layout();value.profiles['desktop:video'].map.style='position:fixed';invalid.push(value);
  value=layout();value.profiles['desktop:video'].emergency.opacity=0;invalid.push(value);
  value=layout();delete value.profiles['desktop:video'].map.y;invalid.push(value);
  value=layout();value.preferences.instrumentsVisible='true';invalid.push(value);
  value=layout();value.profiles['__proto__']={polluted:true};value=JSON.parse(JSON.stringify(value));value.profiles.unknown={map:{}};invalid.push(value);
  for(const input of invalid){assert.equal(normalizeCloudLayout(input),null);assert.equal((await f.upload(admin,0,input)).status,400);}
  assert.equal((await f.call(PREFIX,{cookie:admin,method:'PUT',raw:'x'.repeat(33000)})).status,413);
  assert.equal((await f.call(PREFIX,{cookie:admin,method:'PUT',raw:'{}',headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await f.call(PREFIX,{cookie:admin,method:'PATCH',body:{revision:0,enabled:'true'}})).status,400);
  assert.equal((await f.call(PREFIX,{cookie:admin,method:'PUT',raw:'{'})).status,400);
  assert.equal((await f.call(PREFIX,{cookie:admin,method:'DELETE'})).status,405);
  assert.equal((await f.call(PREFIX+'/unknown',{cookie:admin})).status,404);
  assert.equal(fs.existsSync(f.file),false);assert.equal({}.polluted,undefined);
  assert.deepEqual(normalizeProfiles({'desktop:video':{emergency:{opacity:5},map:{x:4,y:-2,width:'300',height:180}}}),{'desktop:video':{emergency:{opacity:100},map:{x:1,y:0}}});
});
test('状态目录写入失败不确认发布，修复后可重试；文件损坏可以由管理员重新上传修复',async t=>{
  const f=await fixture(t,{beforeBoot:({file})=>fs.writeFileSync(path.dirname(file),'blocked')});const admin=await f.login();
  assert.equal((await f.upload(admin)).status,503);assert.equal((await f.call(PREFIX,{cookie:admin})).data.revision,0);
  fs.unlinkSync(path.dirname(f.file));assert.equal((await f.upload(admin)).status,200);await f.restart();
  await new Promise(resolve=>f.server.close(resolve));fs.writeFileSync(f.file,'{"version":1,"enabled":true,"private":"must-not-leak"}');await f.restart();
  const owner=await f.login(),broken=await f.call(PREFIX,{cookie:owner});assert.equal(broken.data.enabled,false);assert.match(broken.data.error,/无法读取/);assert.doesNotMatch(broken.raw,/must-not-leak/);
  assert.equal((await f.upload(owner)).status,200);assert.equal((await f.call(PREFIX,{cookie:owner})).data.error,null);
});
test('异步落盘期间管理员退出不能发布，临时文件会清理',async t=>{
  const f=await fixture(t),admin=await f.login();let entered,release;
  const reached=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),original=fs.promises.open;
  fs.promises.open=async function(file,...args){
    const handle=await original.call(this,file,...args);
    if(typeof file==='string'&&file.startsWith(path.join(path.dirname(f.file),'.driver-layout.json.'))){const sync=handle.sync.bind(handle);handle.sync=async()=>{entered();await gate;return sync();};}
    return handle;
  };
  try{
    const saving=f.upload(admin);await reached;
    assert.equal((await f.call('/api/auth/session',{cookie:admin,method:'DELETE'})).status,200);release();assert.equal((await saving).status,401);
  }finally{release();fs.promises.open=original;}
  assert.equal(fs.existsSync(f.file),false);assert.deepEqual(fs.readdirSync(path.dirname(f.file)),[]);
});
test('持久化路径使用源码外目录，支持显式路径、更新请求目录与systemd状态目录',()=>{
  assert.equal(resolveDriverLayoutFile({BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_STATE_DIR:path.resolve('test-layout-update')}),path.resolve('test-layout-update/requests/driver-layout.json'));
  assert.equal(resolveDriverLayoutFile({STATE_DIRECTORY:path.resolve('test-layout-state')}),path.resolve('test-layout-state/driver-layout.json'));
  const explicit=path.resolve('explicit-layout.json');assert.equal(resolveDriverLayoutFile({BOAT_DRIVER_LAYOUT_FILE:explicit}),explicit);
  assert.throws(()=>resolveDriverLayoutFile({},'relative-layout.json'));assert.ok(path.isAbsolute(resolveDriverLayoutFile({})));
});
