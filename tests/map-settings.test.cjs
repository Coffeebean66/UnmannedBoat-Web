'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createServer}=require('../server'),{resolveMapConfigFile}=require('../server/map-config');
const KEY='1234567890abcdef1234567890abcdef',CODE='abcdef1234567890abcdef1234567890';
const ENV_KEY='1'.repeat(32),ENV_CODE='2'.repeat(32),ORIGIN='https://map-settings.test';
const ADMIN={username:'map-admin',password:'map-admin-test-password'},GUEST={username:'map-guest',password:'map-guest-test-password'};

function request(port,route,{method='GET',body,raw,cookie,origin=ORIGIN,headers={}}={}){
  const data=raw!==undefined?raw:body!==undefined?JSON.stringify(body):undefined;
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...(origin?{origin}:{}),...(cookie?{cookie}:{}),
      ...(data!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,headers:res.headers,raw,json});});
    });req.on('error',reject);req.end(data);
  });
}

async function fixture(t,{env:extra={},mapOptions={},accountOptions={},beforeBoot}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-map-settings-')),file=mapOptions.file||path.join(directory,'settings','map-settings.json');
  const env={BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:ADMIN.username,BOAT_ADMIN_PASSWORD:ADMIN.password,BOAT_GUEST_USERNAME:GUEST.username,
    BOAT_GUEST_PASSWORD:GUEST.password,BOAT_ACCOUNTS_ORIGIN:ORIGIN,...extra};
  let server,time=100000;
  if(beforeBoot)beforeBoot({directory,file,env});
  async function boot(){server=createServer({env,mapOptions:{...mapOptions,file},accountOptions:{now:()=>time,...accountOptions}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
  await boot();
  t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));assert.match(path.basename(directory),/^boat-map-settings-/);fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,file,env,get server(){return server;},get port(){return server.address().port;},setTime:value=>{time=value;},
    call:(route,options)=>request(server.address().port,route,options),
    async login(role='admin'){const response=await request(server.address().port,'/api/auth/login',{method:'POST',body:role==='admin'?ADMIN:GUEST});assert.equal(response.status,200,response.raw);return response.headers['set-cookie'][0].split(';')[0];},
    async restart(){await new Promise(resolve=>server.close(resolve));await boot();}
  };
}

test('地图管理仅启用账户的管理员可读写；游客和匿名请求拒绝，公共配置仍可读',async t=>{
  const f=await fixture(t);
  for(const method of ['GET','PUT'])assert.equal((await f.call('/api/map/settings',{method,body:method==='PUT'?{key:KEY,securityJsCode:CODE}:undefined})).status,401);
  const guest=await f.login('guest');
  for(const method of ['GET','PUT'])assert.equal((await f.call('/api/map/settings',{method,cookie:guest,body:method==='PUT'?{key:KEY,securityJsCode:CODE}:undefined})).status,403);
  const admin=await f.login(),settings=await f.call('/api/map/settings',{cookie:admin});
  assert.equal(settings.status,200);assert.equal(settings.json.source,'none');assert.equal(settings.headers['cache-control'],'no-store');
  assert.equal((await f.call('/api/map/config')).status,200);
  const legacy=await fixture(t,{env:{BOAT_ACCOUNTS_ENABLED:'0'}});
  for(const method of ['GET','PUT'])assert.equal((await legacy.call('/api/map/settings',{method,body:method==='PUT'?{key:KEY,securityJsCode:CODE}:undefined})).status,503);
});

test('管理员原子保存覆盖环境变量，并在服务重启后保留；空值持久停用高德',async t=>{
  const f=await fixture(t,{env:{BOAT_AMAP_KEY:ENV_KEY,BOAT_AMAP_SECURITY_CODE:ENV_CODE}}),admin=await f.login();
  const inherited=await f.call('/api/map/settings',{cookie:admin});assert.equal(inherited.json.source,'environment');assert.equal(inherited.json.key,ENV_KEY);
  const saved=await f.call('/api/map/settings',{method:'PUT',cookie:admin,body:{key:KEY,securityJsCode:CODE}});
  assert.equal(saved.status,200,saved.raw);assert.equal(saved.json.source,'saved');assert.equal(saved.json.configured,true);assert.equal(saved.json.key,KEY);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),{version:1,key:KEY,securityJsCode:CODE});
  if(process.platform!=='win32')assert.equal(fs.statSync(f.file).mode&0o777,0o640);
  assert.equal(fs.readdirSync(path.dirname(f.file)).length,1);
  assert.equal((await f.call('/api/map/config')).json.key,KEY);
  await f.restart();assert.equal((await f.call('/api/map/config')).json.key,KEY);
  assert.equal((await f.call('/api/map/settings',{cookie:admin})).status,401);
  const again=await f.login(),disabled=await f.call('/api/map/settings',{method:'PUT',cookie:again,body:{key:'',securityJsCode:''}});
  assert.equal(disabled.status,200);assert.equal(disabled.json.configured,false);assert.equal(disabled.json.source,'saved');assert.match(disabled.json.reason,/停用/);
  await f.restart();const publicConfig=await f.call('/api/map/config');assert.equal(publicConfig.json.enabled,false);assert.equal(publicConfig.json.key,'');
  assert.equal('source' in publicConfig.json,false);assert.equal('file' in publicConfig.json,false);
});

test('写入必须同源，拒绝无Origin、跨站Origin与伪造Sec-Fetch-Site',async t=>{
  const f=await fixture(t),cookie=await f.login();
  for(const override of [{origin:null},{origin:'https://evil.test'},{headers:{'sec-fetch-site':'cross-site'}}]){
    const result=await f.call('/api/map/settings',{method:'PUT',cookie,body:{key:KEY,securityJsCode:CODE},...override});assert.equal(result.status,403);
  }
  assert.equal(fs.existsSync(f.file),false);
});

test('请求限制JSON类型、大小、字段与成对Key；错误不能创建持久化设置',async t=>{
  const f=await fixture(t),cookie=await f.login();
  for(const body of [{key:KEY},{key:KEY,securityJsCode:''},{key:'https://evil.test',securityJsCode:CODE},
    {key:KEY,securityJsCode:CODE,url:'https://evil.test'},{key:KEY,securityJsCode:CODE,source:'saved'},[],null]){
    assert.equal((await f.call('/api/map/settings',{method:'PUT',cookie,body})).status,400);
  }
  assert.equal((await f.call('/api/map/settings',{method:'PUT',cookie,raw:'{broken'})).status,400);
  assert.equal((await f.call('/api/map/settings',{method:'PUT',cookie,body:{key:KEY,securityJsCode:CODE},headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await f.call('/api/map/settings',{method:'PUT',cookie,raw:JSON.stringify({key:'x'.repeat(2100),securityJsCode:CODE})})).status,413);
  assert.equal((await f.call('/api/map/settings',{method:'POST',cookie,body:{}})).status,405);
  assert.equal(fs.existsSync(f.file),false);assert.equal((await f.call('/healthz')).status,200);
});

function incompleteRequest(f,cookie,{length=120}={}){
  let resolve,reject;const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const req=http.request({host:'127.0.0.1',port:f.port,path:'/api/map/settings',method:'PUT',agent:false,headers:{cookie,origin:ORIGIN,'content-type':'application/json','content-length':length}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,raw:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);req.flushHeaders();
  return {req,result};
}

test('慢速请求有读取超时，不能一直占用连接或修改配置',async t=>{
  const f=await fixture(t,{mapOptions:{bodyTimeoutMs:80}}),cookie=await f.login();
  const pending=incompleteRequest(f,cookie);pending.req.write('{');
  const response=await pending.result;pending.req.destroy();assert.equal(response.status,408,response.raw);assert.equal(fs.existsSync(f.file),false);
});

test('管理员在请求体读完前登出或会话过期时不能提交设置',async t=>{
  const f=await fixture(t,{accountOptions:{sessionMs:2000}}),cookie=await f.login(),body=JSON.stringify({key:KEY,securityJsCode:CODE});
  const pending=incompleteRequest(f,cookie,{length:Buffer.byteLength(body)});pending.req.write(body.slice(0,5));
  await f.call('/api/auth/session',{method:'DELETE',cookie});pending.req.end(body.slice(5));
  assert.equal((await pending.result).status,401);assert.equal(fs.existsSync(f.file),false);
  const again=await f.login(),expired=incompleteRequest(f,again,{length:Buffer.byteLength(body)});expired.req.write(body.slice(0,5));
  await new Promise(resolve=>setImmediate(resolve));f.setTime(103000);expired.req.end(body.slice(5));
  assert.equal((await expired.result).status,401);assert.equal(fs.existsSync(f.file),false);
});

test('落盘或原子替换失败不报告成功且保留当前运行设置',async t=>{
  const f=await fixture(t,{env:{BOAT_AMAP_KEY:ENV_KEY,BOAT_AMAP_SECURITY_CODE:ENV_CODE}}),cookie=await f.login();
  // 在启动读取结束后制造不可替换目标目录，跨平台验证失败路径而非依赖管理员文件权限。
  fs.mkdirSync(f.file,{recursive:true});
  const response=await f.call('/api/map/settings',{method:'PUT',cookie,body:{key:KEY,securityJsCode:CODE}});
  assert.equal(response.status,503);assert.match(response.json.error,/未更改/);assert.equal((await f.call('/api/map/config')).json.key,ENV_KEY);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)),['map-settings.json']);assert.doesNotMatch(response.raw,new RegExp(f.directory.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('无保存文件时回退环境配置，损坏文件停止高德并允许管理员修复',async t=>{
  const f=await fixture(t,{env:{BOAT_AMAP_KEY:ENV_KEY,BOAT_AMAP_SECURITY_CODE:ENV_CODE},beforeBoot({file}){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{broken');}});
  assert.equal((await f.call('/api/map/config')).json.enabled,false);
  const cookie=await f.login();assert.equal((await f.call('/api/map/settings',{cookie})).json.source,'saved');
  assert.equal((await f.call('/api/map/settings',{method:'PUT',cookie,body:{key:KEY,securityJsCode:CODE}})).status,200);
  assert.equal((await f.call('/api/map/config')).json.key,KEY);
  fs.unlinkSync(f.file);await f.restart();assert.equal((await f.call('/api/map/config')).json.key,ENV_KEY);
});

test('存储路径优先显式绝对路径，然后更新队列、systemd状态目录和用户配置目录',()=>{
  const base=path.resolve(os.tmpdir(),'boat-map-path-test'),explicit=path.join(base,'explicit.json');
  assert.equal(resolveMapConfigFile({BOAT_MAP_CONFIG_FILE:explicit,BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_STATE_DIR:base}),explicit);
  assert.equal(resolveMapConfigFile({BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_STATE_DIR:base,STATE_DIRECTORY:path.join(base,'state')}),path.join(base,'requests','map-settings.json'));
  assert.equal(resolveMapConfigFile({STATE_DIRECTORY:path.join(base,'state')}),path.join(base,'state','map-settings.json'));
  assert.equal(resolveMapConfigFile({APPDATA:base,XDG_CONFIG_HOME:base}),path.join(base,'unmanned-boat-web','map-settings.json'));
  assert.throws(()=>resolveMapConfigFile({BOAT_MAP_CONFIG_FILE:'relative/settings.json'}),/绝对路径/);
});
