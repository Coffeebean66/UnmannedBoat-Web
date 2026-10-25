'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {EventEmitter}=require('node:events'),{createServer}=require('../server');
const {createAccountApi}=require('../server/account-api'),{resolveAccountFile,hashCredential,digest}=require('../server/account-store');
const ORIGIN='https://users.test',ADMIN='initial.admin',PASSWORD='initial administrator test only',GUEST='initial.guest',GUEST_PASSWORD='initial guest test only';
function request(port,route,{method='GET',body,cookie,origin=ORIGIN,headers={}}={}){
  const raw=body===undefined?undefined:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:route,method,agent:false,headers:{...(raw===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw)}),...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),...headers}},res=>{
      let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,data,raw,headers:res.headers});});
    });req.on('error',reject);req.end(raw);
  });
}
async function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-user-management-')),storeFile=path.join(directory,'accounts.json');
  const env={BOAT_ACCOUNTS_ENABLED:'1',BOAT_ACCOUNTS_ORIGIN:ORIGIN,BOAT_ADMIN_USERNAME:ADMIN,BOAT_ADMIN_PASSWORD:PASSWORD,BOAT_GUEST_USERNAME:GUEST,BOAT_GUEST_PASSWORD:GUEST_PASSWORD,...options.env};
  const bridge=new EventEmitter();Object.assign(bridge,{enabled:true,start(){},stop(){},list:()=>({brokerConnected:true,devices:[{id:'boat-01',online:true}]}),state:id=>({brokerConnected:true,device:{id,online:true}})});
  let server,time=10000;
  const boot=async()=>{server=createServer({env,cloud:bridge,accountOptions:{storeFile,now:()=>time,...options.accountOptions},apiOptions:{now:()=>time,heartbeatMs:10}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
  await boot();
  t.after(async()=>{if(server?.listening)await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
  const call=(route,options)=>request(server.address().port,route,options);
  const login=async(username=ADMIN,password=PASSWORD)=>{const result=await call('/api/auth/login',{method:'POST',body:{username,password}});assert.equal(result.status,200,result.raw);return result.headers['set-cookie'][0].split(';')[0];};
  return {directory,storeFile,env,call,login,get server(){return server;},get port(){return server.address().port;},advance:milliseconds=>time+=milliseconds,
    async restart(){await new Promise(resolve=>server.close(resolve));await boot();}};
}
const list=(f,cookie,options={})=>f.call('/api/auth/users',{cookie,...options});
const create=(f,cookie,values={})=>f.call('/api/auth/users',{method:'POST',cookie,body:{username:'operator.one',password:'new user password test only',role:'guest',...values}});
const edit=(f,cookie,id,values)=>f.call('/api/auth/users/'+id,{method:'PATCH',cookie,body:values});

test('user management requires an administrator, while same-origin browser GET needs no Origin header',async t=>{
  const f=await fixture(t),admin=await f.login(),guest=await f.login(GUEST,GUEST_PASSWORD);
  assert.equal((await list(f,undefined)).status,401);assert.equal((await list(f,guest)).status,403);
  assert.equal((await create(f,guest)).status,403);assert.equal((await create(f,undefined)).status,401);
  assert.equal((await list(f,admin,{origin:null})).status,200);
  assert.equal((await list(f,admin,{origin:'https://evil.test'})).status,403);
  assert.equal((await list(f,admin,{origin:null,headers:{'sec-fetch-site':'cross-site'}})).status,403);
  const data=(await list(f,admin)).data;assert.equal(data.users.length,2);assert.ok(data.users.some(user=>user.id===data.currentUserId&&user.username===ADMIN));
  assert.doesNotMatch(JSON.stringify(data),/password|credential|salt|key/i);
  for(const origin of [null,'https://evil.test'])assert.equal((await f.call('/api/auth/users',{method:'POST',cookie:admin,origin,body:{username:'bad',password:'valid password',role:'guest'}})).status,403);
});

test('new accounts persist salted hashes and survive restart ahead of environment credentials',async t=>{
  const f=await fixture(t),admin=await f.login(),result=await create(f,admin);
  assert.equal(result.status,201,result.raw);assert.equal(result.data.reauthenticate,false);
  const raw=fs.readFileSync(f.storeFile,'utf8'),stored=JSON.parse(raw);assert.equal(stored.users.length,3);assert.equal(stored.revision,1);
  for(const password of [PASSWORD,GUEST_PASSWORD,'new user password test only'])assert.ok(!raw.includes(password));
  for(const user of stored.users){assert.equal(user.credential.scheme,'scrypt-sha256-v1');assert.match(user.credential.salt,/^[0-9a-f]{32}$/);assert.match(user.credential.key,/^[0-9a-f]{128}$/);}
  assert.equal(new Set(stored.users.map(user=>user.credential.salt)).size,3);
  if(process.platform!=='win32')assert.equal(fs.statSync(f.storeFile).mode&0o777,0o640);
  f.env.BOAT_ADMIN_PASSWORD='new environment password is ignored';await f.restart();
  await f.login();const user=await f.login('operator.one','new user password test only');
  assert.equal((await f.call('/api/auth/config',{cookie:user})).data.user.role,'guest');assert.equal((await f.call('/api/cloud/devices',{cookie:user})).status,200);
});

test('editing another account revokes all its sessions and closes its live SSE without logging out the administrator',async t=>{
  const f=await fixture(t),admin=await f.login(),first=await f.login(GUEST,GUEST_PASSWORD),second=await f.login(GUEST,GUEST_PASSWORD);
  const opened=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:f.port,path:'/api/cloud/events?device=boat-01',agent:false,headers:{Cookie:first}},res=>resolve({req,res}));req.on('error',reject);});
  t.after(()=>opened.req.destroy());opened.res.resume();const ended=new Promise(resolve=>opened.res.once('end',resolve));
  const guest=(await list(f,admin)).data.users.find(user=>user.username===GUEST),result=await edit(f,admin,guest.id,{username:'renamed.guest',role:'guest',password:'replacement guest password'});
  assert.equal(result.status,200,result.raw);assert.equal(result.data.reauthenticate,false);await ended;
  for(const cookie of [first,second])assert.equal((await f.call('/api/cloud/devices',{cookie})).status,401);
  assert.equal((await list(f,admin)).status,200);await f.login('renamed.guest','replacement guest password');
});

test('self rename or password change requires login again, while unchanged edits do not revoke the session',async t=>{
  const f=await fixture(t),admin=await f.login(),snapshot=(await list(f,admin)).data;
  const unchanged=await edit(f,admin,snapshot.currentUserId,{username:ADMIN,role:'admin'});assert.equal(unchanged.data.reauthenticate,false);assert.equal(fs.existsSync(f.storeFile),false);
  const result=await edit(f,admin,snapshot.currentUserId,{username:'new.administrator',role:'admin',password:'new administrator password'});
  assert.equal(result.status,200,result.raw);assert.equal(result.data.reauthenticate,true);assert.match(result.headers['set-cookie'][0],/Max-Age=0/);
  assert.equal((await list(f,admin)).status,401);assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:ADMIN,password:PASSWORD}})).status,401);
  await f.login('new.administrator','new administrator password');await f.restart();await f.login('new.administrator','new administrator password');
});

test('user validation rejects duplicates, extra fields and the removal of the last administrator',async t=>{
  const f=await fixture(t),admin=await f.login(),snapshot=(await list(f,admin)).data;
  for(const input of [{username:'bad user'},{username:'x'.repeat(65)},{password:'short'},{password:123456},{role:'owner'},{extra:true}])assert.equal((await create(f,admin,input)).status,400);
  assert.equal((await create(f,admin,{username:ADMIN})).status,409);
  assert.equal((await edit(f,admin,snapshot.currentUserId,{username:ADMIN,role:'guest'})).status,409);
  const created=await create(f,admin,{username:'second.admin',role:'admin'});assert.equal(created.status,201);
  const demoted=await edit(f,admin,snapshot.currentUserId,{username:ADMIN,role:'guest'});assert.equal(demoted.status,200);assert.equal(demoted.data.reauthenticate,true);
  const next=await f.login('second.admin','new user password test only'),users=(await list(f,next)).data;assert.equal(users.users.filter(user=>user.role==='admin').length,1);
});

test('failed persistence leaves users, credentials and current sessions unchanged',async t=>{
  const f=await fixture(t),admin=await f.login();fs.mkdirSync(f.storeFile);
  const result=await create(f,admin);assert.equal(result.status,503);assert.equal((await list(f,admin)).data.users.length,2);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:'operator.one',password:'new user password test only'}})).status,401);
  assert.deepEqual(fs.readdirSync(f.directory),['accounts.json']);
});

test('a session expiring during password derivation cannot commit an account change',async t=>{
  const f=await fixture(t,{accountOptions:{sessionMs:50}}),admin=await f.login();
  const pending=create(f,admin);const timer=setTimeout(()=>f.advance(100),5);const result=await pending;clearTimeout(timer);
  assert.equal(result.status,401,result.raw);assert.equal(fs.existsSync(f.storeFile),false);await f.login();
});

test('logout during an asynchronous password check cannot create a replacement session for the old cookie',async t=>{
  const f=await fixture(t),admin=await f.login();assert.equal((await create(f,admin)).status,201);
  const pending=f.call('/api/auth/login',{method:'POST',cookie:admin,body:{username:ADMIN,password:PASSWORD}});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal((await f.call('/api/auth/session',{method:'DELETE',cookie:admin})).status,200);
  const result=await pending;assert.equal(result.status,409,result.raw);assert.equal(result.headers['set-cookie'],undefined);assert.equal(f.server.boatAccounts.getSessionCount(),0);
});

test('concurrent management requests are rejected rather than overwriting each other',async t=>{
  const f=await fixture(t),admin=await f.login();
  let finish;
  const result=new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:f.port,path:'/api/auth/users',method:'POST',headers:{Cookie:admin,Origin:ORIGIN,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode,raw}));});req.on('error',reject);req.write('{"username":"slow.user",');finish=()=>req.end('"password":"slow user test password","role":"guest"}');});
  await new Promise(resolve=>setTimeout(resolve,15));const concurrent=await create(f,admin);assert.equal(concurrent.status,409);finish();assert.equal((await result).status,201);
  assert.equal((await list(f,admin)).data.users.length,3);
});

test('an externally changed store is not silently overwritten and corrupt persisted data cannot restore initial passwords',async t=>{
  const f=await fixture(t),admin=await f.login();assert.equal((await create(f,admin)).status,201);
  fs.appendFileSync(f.storeFile,' ');assert.equal((await create(f,admin,{username:'another.user'})).status,409);assert.equal((await list(f,admin)).data.users.length,3);
  await f.restart();await f.login();fs.writeFileSync(f.storeFile,'{broken');
  assert.throws(()=>createAccountApi({env:f.env,storeFile:f.storeFile}),/账户库读取失败/);
});

test('the 64-user limit is enforced without persisting an excessive account list',async t=>{
  const f=await fixture(t),credential=await hashCredential(digest(PASSWORD));
  const users=Array.from({length:64},(_,index)=>({id:index.toString(16).padStart(32,'0'),username:index?'guest'+index:ADMIN,role:index?'guest':'admin',credential}));
  fs.writeFileSync(f.storeFile,JSON.stringify({version:1,revision:1,users}));await f.restart();const admin=await f.login();assert.equal((await create(f,admin)).status,409);assert.equal((await list(f,admin)).data.users.length,64);
});

test('enabling the updater or adding StateDirectory never changes an existing account database',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-account-paths-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const state=path.join(directory,'state'),update=path.join(directory,'update');fs.mkdirSync(state);fs.mkdirSync(path.join(update,'requests'),{recursive:true});
  const stateFile=path.join(state,'accounts.json'),updateFile=path.join(update,'requests','accounts.json');
  assert.equal(resolveAccountFile({STATE_DIRECTORY:state}),stateFile);fs.writeFileSync(stateFile,'corrupt-is-still-present');
  assert.equal(resolveAccountFile({STATE_DIRECTORY:state,BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_STATE_DIR:update}),stateFile);
  fs.rmSync(stateFile);fs.writeFileSync(updateFile,'existing');assert.equal(resolveAccountFile({STATE_DIRECTORY:state,BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_STATE_DIR:update}),updateFile);
  assert.equal(resolveAccountFile({STATE_DIRECTORY:state,BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_STATE_DIR:update,BOAT_ACCOUNTS_FILE:path.join(directory,'custom.json')}),path.join(directory,'custom.json'));
});

test('a systemd-style linked StateDirectory supports persistence without allowing a linked account file',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-systemd-state-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const actual=path.join(directory,'private','boat-web'),state=path.join(directory,'boat-web');fs.mkdirSync(actual,{recursive:true});
  try{fs.symlinkSync(actual,state,process.platform==='win32'?'junction':'dir');}catch(error){if(error.code==='EPERM'){t.skip('Directory symlinks are unavailable');return;}throw error;}
  const f=await fixture(t,{env:{STATE_DIRECTORY:state},accountOptions:{storeFile:undefined}}),admin=await f.login();
  assert.equal((await create(f,admin)).status,201);assert.ok(fs.existsSync(path.join(actual,'accounts.json')));await f.restart();await f.login('operator.one','new user password test only');
  const link=path.join(directory,'linked-accounts.json');try{fs.symlinkSync(path.join(actual,'accounts.json'),link,'file');}catch(error){if(error.code==='EPERM')return;throw error;}
  assert.throws(()=>createAccountApi({env:f.env,storeFile:link}),/账户库读取失败/);
});
