'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {EventEmitter}=require('node:events');
const {createServer}=require('../server'),{createAccountApi}=require('../server/account-api');
const ORIGIN='https://accounts.test',ADMIN='test.admin',GUEST='test-guest',ADMIN_PASSWORD='test administrator only',GUEST_PASSWORD='654321';
const OLD='1'.repeat(40),LATEST='a'.repeat(40),UPDATE_PASSWORD='independent-random-update-key-fixture';
function request(port,route,{method='GET',body,raw,cookie,origin=ORIGIN,ticket,headers={}}={}){
  const data=raw!==undefined?raw:body!==undefined?JSON.stringify(body):undefined;
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...(data!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...(origin?{origin}:{}),...(cookie?{cookie}:{}),...(ticket?{'x-boat-update-ticket':ticket}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,headers:res.headers,json,raw});});
    });req.on('error',reject);req.end(data);
  });
}
async function fixture(t,{accountOptions={},env:extra={}}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'boat-accounts-test-'));fs.mkdirSync(path.join(base,'requests'));fs.mkdirSync(path.join(base,'state'));
  fs.writeFileSync(path.join(base,'config.json'),JSON.stringify({apiVersion:1,repository:'https://github.com/Coffeebean66/UnmannedBoat-Web',branch:'main'}),{mode:0o644});fs.writeFileSync(path.join(base,'state/status.json'),JSON.stringify({status:'idle'}));
  const releasePath=path.join(base,'release.json');fs.writeFileSync(releasePath,JSON.stringify({version:'1.4.1',commit:OLD}));
  const env={BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:ADMIN,BOAT_ADMIN_PASSWORD:ADMIN_PASSWORD,BOAT_GUEST_USERNAME:GUEST,BOAT_GUEST_PASSWORD:GUEST_PASSWORD,BOAT_ACCOUNTS_ORIGIN:ORIGIN,
    BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_PASSWORD:UPDATE_PASSWORD,BOAT_UPDATE_ORIGIN:ORIGIN,BOAT_UPDATE_STATE_DIR:base,...extra};
  let time=1000000,server;const bridge=new EventEmitter();Object.assign(bridge,{enabled:true,start(){},stop(){},list:()=>({brokerConnected:true,devices:[{id:'boat-01',online:true}]}),state:device=>({brokerConnected:true,device:{id:device}})});
  async function boot(){server=createServer({env,cloud:bridge,accountOptions:{now:()=>time,...accountOptions},apiOptions:{now:()=>time,heartbeatMs:10},updateOptions:{now:()=>time,checkLatest:async()=>LATEST,releasePath,helperOwnerUid:process.getuid?.()||0}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
  await boot();t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(base),fs.realpathSync(os.tmpdir()));assert.match(path.basename(base),/^boat-accounts-test-/);fs.rmSync(base,{recursive:true,force:true});});
  return {base,env,bridge,get server(){return server;},get port(){return server.address().port;},now:()=>time,setTime:value=>{time=value;},call:(route,options)=>request(server.address().port,route,options),
    async login(role='admin',options={}){const response=await request(server.address().port,'/api/auth/login',{method:'POST',body:{username:role==='admin'?ADMIN:GUEST,password:role==='admin'?ADMIN_PASSWORD:GUEST_PASSWORD},...options});assert.equal(response.status,200,response.raw);return response.headers['set-cookie'][0].split(';')[0];},
    async restart(){await new Promise(resolve=>server.close(resolve));await boot();}
  };
}
function stream(port,cookie){return new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:'/api/cloud/events?device=boat-01',agent:false,headers:{cookie}},res=>{const output={req,res,status:res.statusCode,events:[]};let raw='';res.on('data',chunk=>{raw+=chunk.toString();let end;while((end=raw.indexOf('\n\n'))>=0){const block=raw.slice(0,end);raw=raw.slice(end+2);const data=block.match(/^data: (.+)$/m);if(data)output.events.push(JSON.parse(data[1]));}});resolve(output);});req.on('error',reject);});}
async function until(predicate){const end=Date.now()+1500;while(!predicate()){if(Date.now()>end)throw Error('Stream timeout');await new Promise(resolve=>setTimeout(resolve,5));}}

test('account mode is optional, validates configuration and never exposes credential fields',async t=>{
  const disabled=createAccountApi({env:{}});assert.equal(disabled.enabled,false);disabled.close();
  for(const extra of [{BOAT_GUEST_PASSWORD:'short'},{BOAT_ADMIN_USERNAME:'bad name'},{BOAT_GUEST_USERNAME:ADMIN},{BOAT_ADMIN_USERNAME:['admin']},{BOAT_ACCOUNTS_ORIGIN:ORIGIN+'/'}])assert.throws(()=>createAccountApi({env:{BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:ADMIN,BOAT_ADMIN_PASSWORD:ADMIN_PASSWORD,BOAT_GUEST_USERNAME:GUEST,BOAT_GUEST_PASSWORD:GUEST_PASSWORD,...extra}}));
  const f=await fixture(t),config=await f.call('/api/auth/config');assert.deepEqual(config.json,{enabled:true,requiresLogin:true,user:null});assert.doesNotMatch(config.raw,/password|test.admin|654321/i);
});

test('admin and six-character guest passwords authenticate with one secure root-path cookie',async t=>{
  const f=await fixture(t);
  for(const role of ['admin','guest']){
    const response=await f.call('/api/auth/login',{method:'POST',body:{username:role==='admin'?ADMIN:GUEST,password:role==='admin'?ADMIN_PASSWORD:GUEST_PASSWORD}});assert.equal(response.status,200);assert.deepEqual(response.json.user,{username:role==='admin'?ADMIN:GUEST,role});
    const cookie=response.headers['set-cookie'][0];assert.match(cookie,/^boat_account_session=[0-9a-f]{64}; Path=\/;/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
    const config=await f.call('/api/auth/config',{cookie});assert.equal(config.json.requiresLogin,false);assert.equal(config.json.user.role,role);assert.equal((await f.call('/api/cloud/devices',{cookie})).status,200);
  }
});

test('anonymous/guest/admin permissions are enforced on APIs, independent of browser controls',async t=>{
  const f=await fixture(t);assert.equal((await f.call('/api/cloud/devices')).status,401);assert.equal((await f.call('/api/update/status')).status,401);
  const guest=await f.login('guest');assert.equal((await f.call('/api/cloud/config',{cookie:guest})).json.requiresLogin,false);assert.equal((await f.call('/api/cloud/devices',{cookie:guest})).status,200);assert.equal((await f.call('/api/update/config',{cookie:guest})).json.enabled,true);
  for(const [route,method,body]of [['/api/update/status','GET',undefined],['/api/update/check','POST',{}],['/api/update/start','POST',{expectedCommit:LATEST}]])assert.equal((await f.call(route,{method,body,cookie:guest})).status,403);
  const admin=await f.login();assert.equal((await f.call('/api/update/status',{cookie:admin})).status,200);assert.equal((await f.call('/api/update/check',{method:'POST',cookie:admin,body:{}})).status,200);assert.equal((await f.call('/api/update/start',{method:'POST',cookie:admin,body:{expectedCommit:LATEST}})).status,202);
});

test('old password-only cloud/update routes and forged role fields cannot bypass shared authentication',async t=>{
  const f=await fixture(t,{env:{BOAT_CLOUD_PASSWORD:'legacy-cloud-secret-fixture'}}),guest=await f.login('guest');
  for(const cookie of [undefined,guest])for(const route of ['/api/cloud/login','/api/update/login'])assert.equal((await f.call(route,{method:'POST',cookie,body:{password:route.includes('cloud')?'legacy-cloud-secret-fixture':UPDATE_PASSWORD}})).status,403);
  for(const cookie of [undefined,'boat_cloud_session='+'a'.repeat(64),'boat_update_session='+'b'.repeat(64)])assert.equal((await f.call('/api/cloud/devices',{cookie})).status,401);
  const forged=await f.call('/api/auth/login',{method:'POST',body:{username:GUEST,password:GUEST_PASSWORD,role:'admin'}});assert.equal(forged.status,401);
  assert.equal((await f.call('/api/update/check',{method:'POST',cookie:guest,body:{},headers:{'x-boat-role':'admin'}})).status,403);
});

test('account writes require exact same origin; login input and attempts are bounded',async t=>{
  const f=await fixture(t);
  for(const origin of [null,'https://evil.test'])assert.equal((await f.call('/api/auth/login',{method:'POST',origin,body:{username:ADMIN,password:ADMIN_PASSWORD}})).status,403);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:ADMIN,password:ADMIN_PASSWORD},headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:ADMIN,password:ADMIN_PASSWORD},headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await f.call('/api/auth/login',{method:'POST',raw:'{bad'})).status,400);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:ADMIN,password:'x'.repeat(1100)}})).status,413);
  for(let i=0;i<5;i++)await f.call('/api/auth/login',{method:'POST',body:{username:ADMIN,password:'wrong'}});
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:ADMIN,password:ADMIN_PASSWORD}})).status,429);f.setTime(f.now()+60000);await f.login();
});

test('logout and switching accounts immediately close their shared cloud SSE and discard update checks',async t=>{
  const f=await fixture(t),admin=await f.login(),sse=await stream(f.port,admin);t.after(()=>sse.req.destroy());assert.equal(sse.status,200);await until(()=>sse.events.length>0);
  await f.call('/api/update/check',{method:'POST',cookie:admin,body:{}});
  assert.equal((await f.call('/api/auth/session',{method:'DELETE',cookie:admin,origin:'https://evil.test'})).status,403);assert.equal(f.server.boatCloudApi.getClientCount(),1);
  const ended=new Promise(resolve=>sse.res.once('end',resolve));const guest=await f.login('guest',{cookie:admin});await ended;assert.equal(f.server.boatCloudApi.getClientCount(),0);assert.equal((await f.call('/api/cloud/devices',{cookie:admin})).status,401);
  const second=await stream(f.port,guest);t.after(()=>second.req.destroy());await until(()=>second.events.length>0);const secondEnded=new Promise(resolve=>second.res.once('end',resolve));await f.call('/api/auth/session',{method:'DELETE',cookie:guest});await secondEnded;assert.equal((await f.call('/api/cloud/devices',{cookie:guest})).status,401);
  const next=await f.login();assert.equal((await f.call('/api/update/start',{method:'POST',cookie:next,body:{expectedCommit:LATEST}})).status,412);
});

test('shared-session expiry closes streams and session capacity remains bounded',async t=>{
  const f=await fixture(t,{accountOptions:{sessionMs:100,maxSessions:1}}),cookie=await f.login(),sse=await stream(f.port,cookie);t.after(()=>sse.req.destroy());await until(()=>sse.events.length>0);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:GUEST,password:GUEST_PASSWORD}})).status,503);
  const ended=new Promise(resolve=>sse.res.once('end',resolve));f.setTime(f.now()+101);await ended;assert.equal(f.server.boatAccounts.getSessionCount(),0);assert.equal((await f.call('/api/update/status',{cookie})).status,401);await f.login('guest');
});

test('admin update candidates retain the five-minute limit and never transfer between account sessions',async t=>{
  const f=await fixture(t),first=await f.login(),second=await f.login();await f.call('/api/update/check',{method:'POST',cookie:first,body:{}});f.setTime(f.now()+4*60*1000);
  assert.equal((await f.call('/api/update/start',{method:'POST',cookie:second,body:{expectedCommit:LATEST}})).status,412);assert.equal((await f.call('/api/update/start',{method:'POST',cookie:first,body:{expectedCommit:LATEST}})).status,202);
  const stale=await fixture(t),cookie=await stale.login();await stale.call('/api/update/check',{method:'POST',cookie,body:{}});stale.setTime(stale.now()+5*60*1000+1);assert.equal((await stale.call('/api/update/start',{method:'POST',cookie,body:{expectedCommit:LATEST}})).status,412);
});

test('job tickets survive account restart with the existing update secret, but never authorize a guest',async t=>{
  const f=await fixture(t),admin=await f.login();await f.call('/api/update/check',{method:'POST',cookie:admin,body:{}});const started=await f.call('/api/update/start',{method:'POST',cookie:admin,body:{expectedCommit:LATEST}}),ticket=started.json.ticket;
  await f.restart();assert.equal((await f.call('/api/update/status',{cookie:admin})).status,401);assert.equal((await f.call('/api/update/status',{ticket})).status,200);
  const guest=await f.login('guest');assert.equal((await f.call('/api/update/status',{cookie:guest,ticket})).status,403);assert.equal((await f.call('/api/update/start',{method:'POST',ticket,body:{expectedCommit:LATEST}})).status,401);
  // Changing a login password does not rotate the separate job-ticket signing secret.
  f.env.BOAT_ADMIN_PASSWORD='different test administrator password';await f.restart();assert.equal((await f.call('/api/update/status',{ticket})).status,200);
});

test('account passwords retain exact whitespace; only explicitly enabled account mode replaces legacy APIs',async t=>{
  const f=await fixture(t,{env:{BOAT_GUEST_PASSWORD:' 654321 '}});
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:GUEST,password:'654321'}})).status,401);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:GUEST,password:' 654321 '}})).status,200);
  const disabled=await fixture(t,{env:{BOAT_ACCOUNTS_ENABLED:'0',BOAT_CLOUD_ORIGIN:ORIGIN,BOAT_CLOUD_PASSWORD:'legacy-cloud-password-fixture'}});assert.deepEqual((await disabled.call('/api/auth/config')).json,{enabled:false,requiresLogin:false,user:null});assert.equal((await disabled.call('/api/cloud/login',{method:'POST',origin:ORIGIN,body:{password:'legacy-cloud-password-fixture'}})).status,200);
});
