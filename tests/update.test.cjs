'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),https=require('node:https');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {createServer}=require('../server');
const {readCurrentRelease,sanitizeJob,fetchLatestCommit,GITHUB_URL,REPOSITORY}=require('../server/update-api');
const PASSWORD='independent-update-admin-test-password';
const ORIGIN='https://boat.test';
const OLD='1'.repeat(40),LATEST='a'.repeat(40),OTHER='b'.repeat(40);

function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value),{mode:0o644});}
function request(port,route,{method='GET',body,raw,cookie,origin=ORIGIN,ticket,headers={}}={}){
  const data=raw!==undefined?raw:body!==undefined?JSON.stringify(body):undefined;
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{
      ...(data!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),
      ...(cookie?{cookie}:{}),...(origin?{origin}:{}),...(ticket?{'x-boat-update-ticket':ticket}:{}),...headers
    }},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(raw);}catch(_){}
        resolve({status:res.statusCode,headers:res.headers,raw,json});
      });
    });req.on('error',reject);req.end(data);
  });
}
async function fixture(t,{env:overrides={},updateOptions={},release={version:'1.4.0-test',commit:OLD},latest=async()=>LATEST}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'boat-update-test-'));
  const requestDir=path.join(base,'requests'),statusDir=path.join(base,'state');fs.mkdirSync(requestDir);fs.mkdirSync(statusDir);
  const configFile=path.join(base,'config.json'),statusFile=path.join(statusDir,'status.json'),requestFile=path.join(requestDir,'update.json'),inflightFile=path.join(base,'inflight.json'),releasePath=path.join(base,'release.json');
  writeJson(configFile,{apiVersion:1,repository:REPOSITORY.url,branch:'main'});writeJson(statusFile,{status:'idle'});writeJson(releasePath,release);
  let time=1000000,server;
  const env={BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_PASSWORD:PASSWORD,BOAT_UPDATE_ORIGIN:ORIGIN,BOAT_UPDATE_STATE_DIR:base,...overrides};
  async function boot(){
    server=createServer({env,updateOptions:{releasePath,now:()=>time,checkLatest:latest,helperOwnerUid:process.getuid?.()||0,...updateOptions}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  }
  await boot();
  t.after(async()=>{
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    // 仅删除本测试通过 mkdtemp 创建的确切目录，不处理任何配置给出的外部路径。
    assert.equal(path.dirname(base),fs.realpathSync(os.tmpdir()));assert.match(path.basename(base),/^boat-update-test-/);
    fs.rmSync(base,{recursive:true,force:true});
  });
  const f={base,configFile,statusFile,requestFile,inflightFile,releasePath,env,get server(){return server;},get port(){return server.address().port;},now:()=>time,setTime:value=>{time=value;},
    call:(route,options)=>request(server.address().port,route,options),
    async login(extra={}){
      const response=await this.call('/api/update/login',{method:'POST',body:{password:PASSWORD},...extra});assert.equal(response.status,200,response.raw);
      return response.headers['set-cookie'][0].split(';')[0];
    },
    check:cookie=>request(server.address().port,'/api/update/check',{method:'POST',cookie,body:{}}),
    start:(cookie,expectedCommit=LATEST)=>request(server.address().port,'/api/update/start',{method:'POST',cookie,body:{expectedCommit}}),
    async restart(){await new Promise(resolve=>server.close(resolve));await boot();}
  };
  return f;
}
function job(status='running',fields={}){return {id:randomUUID(),status,expectedCommit:LATEST,phase:status,message:'测试进度',startedAt:1000000,...fields};}

test('updates default to disabled and leave cloud/health functional',async t=>{
  const f=await fixture(t,{env:{BOAT_UPDATE_ENABLED:'0'}});
  const config=await f.call('/api/update/config');assert.equal(config.status,200);assert.equal(config.json.enabled,false);assert.equal(config.json.requiresLogin,false);assert.equal(config.json.apiVersion,1);
  assert.equal((await f.call('/api/update/status')).status,503);assert.equal((await f.call('/api/cloud/config')).json.enabled,false);
  const health=await f.call('/healthz');assert.equal(health.json.app,'unmanned-boat-web');assert.equal(health.json.apiVersion,1);assert.equal(health.json.commit,OLD);
  assert.equal((await f.call('/healthz',{method:'HEAD'})).raw,'');
});

test('readiness requires independent password, exact origin and installed fixed-source helper',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/update/config')).json.enabled,true);
  f.env.BOAT_UPDATE_ENABLED='0';assert.equal((await f.call('/api/update/config')).json.enabled,false);f.env.BOAT_UPDATE_ENABLED='1';
  writeJson(f.configFile,{apiVersion:1,repository:'https://evil.test/repo',branch:'main'});assert.equal((await f.call('/api/update/config')).json.enabled,false);
  writeJson(f.configFile,{apiVersion:2,repository:REPOSITORY.url,branch:'main'});assert.equal((await f.call('/api/update/config')).json.enabled,false);
  fs.unlinkSync(f.configFile);assert.equal((await f.call('/api/update/config')).json.enabled,false);
  const short=await fixture(t,{env:{BOAT_UPDATE_PASSWORD:'short',BOAT_CLOUD_PASSWORD:PASSWORD}});assert.equal((await short.call('/api/update/config')).json.enabled,false);
  const origin=await fixture(t,{env:{BOAT_UPDATE_ORIGIN:ORIGIN+'/'}});assert.equal((await origin.call('/api/update/config')).json.enabled,false);
  const fallback=await fixture(t,{env:{BOAT_UPDATE_ORIGIN:'',BOAT_CLOUD_ORIGIN:ORIGIN}});assert.equal((await fallback.call('/api/update/config')).json.enabled,true);
});

test('release metadata is validated and frozen for each running instance',async t=>{
  const f=await fixture(t),cookie=await f.login(),health=(await f.call('/healthz')).json;
  assert.match(health.instanceId,/^[0-9a-f-]{36}$/);assert.equal(health.version,'1.4.0-test');assert.equal(health.commit,OLD);
  writeJson(f.releasePath,{version:'next',commit:LATEST});
  const status=await f.call('/api/update/status',{cookie});assert.deepEqual(status.json.current,{version:health.version,commit:OLD,instanceId:health.instanceId});assert.deepEqual(status.json.repository,REPOSITORY);assert.equal(status.json.job,null);
  await f.restart();const restarted=(await f.call('/healthz')).json;assert.equal(restarted.commit,LATEST);assert.notEqual(restarted.instanceId,health.instanceId);
  writeJson(f.releasePath,{version:'bad version',commit:[OLD]});const fallback=readCurrentRelease({releasePath:f.releasePath,version:'fallback'});assert.equal(fallback.version,'fallback');assert.equal(fallback.commit,null);assert.equal(Object.isFrozen(fallback),true);
  fs.unlinkSync(f.releasePath);assert.equal(readCurrentRelease({releasePath:f.releasePath}).commit,null);
});

test('login is same-origin, independently authenticated, HttpOnly and CSRF protected',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/update/status')).status,401);
  for(const origin of ['https://evil.test',null])assert.equal((await f.call('/api/update/login',{method:'POST',body:{password:PASSWORD},origin})).status,403);
  assert.equal((await f.call('/api/update/login',{method:'POST',body:{password:PASSWORD},headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await f.call('/api/update/login',{method:'POST',body:{password:'wrong'}})).status,401);
  const response=await f.call('/api/update/login',{method:'POST',body:{password:PASSWORD}}),cookie=response.headers['set-cookie'][0];
  assert.match(cookie,/^boat_update_session=/);assert.match(cookie,/Path=\/api\/update/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Secure/);
  assert.equal((await f.call('/api/update/config',{cookie})).json.requiresLogin,false);
  assert.equal((await f.call('/api/update/status',{cookie:cookie.replace('boat_update_session','boat_cloud_session')})).status,401);
  for(const route of ['/api/update/check','/api/update/start'])assert.equal((await f.call(route,{method:'POST',cookie,origin:'https://evil.test',body:{}})).status,403);
  assert.equal((await f.call('/api/update/session',{method:'DELETE',cookie,origin:'https://evil.test'})).status,403);
  assert.equal((await f.call('/api/update/session',{method:'DELETE',cookie})).status,200);assert.equal((await f.call('/api/update/status',{cookie})).status,401);
});

test('login attempts are bounded by source IP and recover after one minute',async t=>{
  const f=await fixture(t);
  for(let i=0;i<8;i++)assert.equal((await f.call('/api/update/login',{method:'POST',body:{password:'wrong'}})).status,401);
  const limited=await f.call('/api/update/login',{method:'POST',body:{password:PASSWORD}});assert.equal(limited.status,429);assert.equal(limited.headers['retry-after'],'60');
  assert.equal((await f.call('/api/update/login',{method:'POST',body:{password:PASSWORD},headers:{'x-real-ip':'192.0.2.1'}})).status,200);
  f.setTime(f.now()+60000);await f.login();
});

test('session capacity, expiry and close cleanup are bounded',async t=>{
  const f=await fixture(t,{updateOptions:{maxSessions:1,sessionMs:100}}),cookie=await f.login();
  assert.equal((await f.call('/api/update/login',{method:'POST',body:{password:PASSWORD}})).status,503);
  f.setTime(f.now()+101);assert.equal((await f.call('/api/update/status',{cookie})).status,401);assert.equal(f.server.boatUpdateApi.getSessionCount(),0);
  await f.login();assert.equal(f.server.boatUpdateApi.getSessionCount(),1);f.server.boatUpdateApi.close();assert.equal(f.server.boatUpdateApi.getSessionCount(),0);
});

test('JSON bodies are small, explicit, strictly typed and cannot change update source',async t=>{
  const f=await fixture(t),cookie=await f.login();
  for(const input of [{repository:'https://evil.test'}, {branch:'dev'}, {command:'echo bad'}])assert.equal((await f.call('/api/update/check',{method:'POST',cookie,body:input})).status,400);
  for(const input of [{expectedCommit:[LATEST]}, {expectedCommit:LATEST,repository:REPOSITORY.url}, {expectedCommit:LATEST,branch:'main'}, {expectedCommit:LATEST,command:'echo bad'}, {expectedCommit:'A'.repeat(40)}])assert.equal((await f.call('/api/update/start',{method:'POST',cookie,body:input})).status,400);
  assert.equal((await f.call('/api/update/check',{method:'POST',cookie,body:{},headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await f.call('/api/update/check',{method:'POST',cookie,raw:'{broken'})).status,400);
  assert.equal((await f.call('/api/update/check',{method:'POST',cookie,body:[]})).status,400);
  assert.equal((await f.call('/api/update/check',{method:'POST',cookie,body:{padding:'x'.repeat(1100)}})).status,413);
  assert.equal(fs.existsSync(f.requestFile),false);
});

test('checking updates is fixed-source, coalesced and cached without creating a job',async t=>{
  let count=0,resolveLatest;const latest=()=>{count++;return new Promise(resolve=>{resolveLatest=resolve;});};
  const f=await fixture(t,{latest}),cookie=await f.login();
  const checks=[f.check(cookie),f.check(cookie)];
  while(!resolveLatest)await new Promise(resolve=>setTimeout(resolve,1));resolveLatest(LATEST);
  for(const response of await Promise.all(checks)){assert.equal(response.status,200);assert.deepEqual(response.json,{latestCommit:LATEST,available:true});}
  assert.equal(count,1);await f.check(cookie);assert.equal(count,1);assert.equal(fs.existsSync(f.requestFile),false);
});

test('failed or malformed GitHub responses cannot authorize a start',async t=>{
  for(const latest of [async()=>{throw Error('secret internal path');},async()=>[LATEST],async()=>'invalid']){
    const f=await fixture(t,{latest}),cookie=await f.login();const checked=await f.check(cookie);assert.equal(checked.status,502);assert.doesNotMatch(checked.raw,/secret internal path/);
    assert.equal((await f.start(cookie)).status,412);assert.equal(fs.existsSync(f.requestFile),false);
  }
});

test('failed checks also apply a bounded cooldown and never overload GitHub retries',async t=>{
  let calls=0;const f=await fixture(t,{latest:async()=>{calls++;throw Error('offline');}}),cookie=await f.login();
  assert.equal((await f.check(cookie)).status,502);assert.equal((await f.check(cookie)).status,502);assert.equal(calls,1);
  f.setTime(f.now()+15001);assert.equal((await f.check(cookie)).status,502);assert.equal(calls,2);
});

test('start requires a recent matching check from the same session',async t=>{
  const f=await fixture(t),first=await f.login(),second=await f.login();
  assert.equal((await f.start(first)).status,412);await f.check(first);
  assert.equal((await f.start(second)).status,412);assert.equal((await f.start(first,OTHER)).status,412);
  f.setTime(f.now()+5*60*1000+1);assert.equal((await f.start(first)).status,412);
  assert.equal(fs.existsSync(f.requestFile),false);
  const same=await fixture(t,{latest:async()=>OLD}),cookie=await same.login();assert.equal((await same.check(cookie)).json.available,false);assert.equal((await same.start(cookie,OLD)).status,409);
});

test('concurrent starts publish one complete request and one read-only job ticket',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.check(cookie);
  const starts=await Promise.all([f.start(cookie),f.start(cookie)]);assert.deepEqual(starts.map(value=>value.status).sort(),[202,409]);
  const started=starts.find(value=>value.status===202),stored=JSON.parse(fs.readFileSync(f.requestFile,'utf8'));
  assert.deepEqual(Object.keys(stored).sort(),['expectedCommit','id','requestedAt']);assert.equal(stored.id,started.json.job.id);assert.equal(stored.expectedCommit,LATEST);assert.equal(stored.requestedAt,f.now());
  assert.equal(started.json.job.status,'queued');assert.equal(typeof started.json.ticket,'string');assert.deepEqual(fs.readdirSync(path.dirname(f.requestFile)),['update.json']);
  const status=await f.call('/api/update/status',{ticket:started.json.ticket});assert.equal(status.status,200);assert.equal(status.json.job.id,stored.id);
  for(const route of ['/api/update/start','/api/update/check'])assert.equal((await f.call(route,{method:'POST',ticket:started.json.ticket,body:{expectedCommit:LATEST}})).status,401);
});

test('active status, any final request and worker inflight file prevent a second task',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.check(cookie);
  const active=job();writeJson(f.statusFile,active);assert.equal((await f.start(cookie)).status,409);
  writeJson(f.statusFile,{...active,status:'succeeded',finishedAt:f.now()});writeJson(f.inflightFile,{id:active.id,expectedCommit:LATEST,requestedAt:f.now()});assert.equal((await f.start(cookie)).status,409);
  fs.unlinkSync(f.inflightFile);writeJson(f.requestFile,{id:active.id,expectedCommit:LATEST,requestedAt:f.now()});assert.equal((await f.start(cookie)).status,409);
  fs.unlinkSync(f.requestFile);assert.equal((await f.start(cookie)).status,202);
});

test('malformed/unknown worker state fails closed; missing state alone is idle',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.check(cookie);
  for(const value of [{status:'unknown'}, {...job(),status:'unexpected'}, {...job(),expectedCommit:[LATEST]}, {...job(),finishedAt:'nonsense'}, {status:'idle',extra:'bad'}]){
    writeJson(f.statusFile,value);assert.equal((await f.call('/api/update/status',{cookie})).status,503);assert.equal((await f.start(cookie)).status,503);
  }
  writeJson(f.statusFile,{status:'idle'});writeJson(f.requestFile,{id:randomUUID(),expectedCommit:LATEST,requestedAt:f.now(),command:'ignored?'});assert.equal((await f.start(cookie)).status,503);fs.unlinkSync(f.requestFile);
  fs.unlinkSync(f.statusFile);assert.equal((await f.call('/api/update/status',{cookie})).json.job,null);assert.equal((await f.start(cookie)).status,202);
});

test('status/request file content is bounded and symbolic-link state is never followed',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.check(cookie);
  fs.writeFileSync(f.statusFile,'x'.repeat(16385));assert.equal((await f.call('/api/update/status',{cookie})).status,503);assert.equal((await f.start(cookie)).status,503);
  fs.writeFileSync(f.statusFile,'{broken');assert.equal((await f.start(cookie)).status,503);
  writeJson(f.statusFile,{status:'idle'});fs.writeFileSync(f.requestFile,'x'.repeat(2049));assert.equal((await f.start(cookie)).status,503);fs.unlinkSync(f.requestFile);
  if(process.platform!=='win32'){
    fs.unlinkSync(f.statusFile);fs.symlinkSync(f.configFile,f.statusFile);assert.equal((await f.call('/api/update/status',{cookie})).status,503);assert.equal((await f.start(cookie)).status,503);
  }
  assert.equal(fs.existsSync(f.requestFile),false);
});

test('a ticket survives restart, reveals only its job and never treats old code as updated',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.check(cookie);const started=await f.start(cookie),ticket=started.json.ticket;
  fs.unlinkSync(f.requestFile);writeJson(f.statusFile,{...started.json.job,status:'succeeded',targetCommit:LATEST,finishedAt:f.now()});
  await f.restart();assert.equal((await f.call('/api/update/status',{cookie})).status,401);
  const status=await f.call('/api/update/status',{ticket});assert.equal(status.status,200);assert.equal(status.json.job.status,'succeeded');assert.equal(status.json.current.commit,OLD);assert.notEqual(status.json.current.commit,status.json.job.expectedCommit);
  for(const terminal of ['failed','rolled_back']){writeJson(f.statusFile,{...started.json.job,status:terminal,finishedAt:f.now()});assert.equal((await f.call('/api/update/status',{ticket})).json.job.status,terminal);}
  writeJson(f.statusFile,job());assert.equal((await f.call('/api/update/status',{ticket})).status,404);
  assert.equal((await f.call('/api/update/status',{ticket:ticket.slice(0,-1)+(ticket.endsWith('a')?'b':'a')})).status,401);
  f.setTime(f.now()+30*60*1000+1);assert.equal((await f.call('/api/update/status',{ticket})).status,401);
});

test('the worker claim window keeps the request ticket visible before running status exists',async t=>{
  const f=await fixture(t),cookie=await f.login();await f.check(cookie);const started=await f.start(cookie);
  fs.renameSync(f.requestFile,f.inflightFile);
  const claimed=await f.call('/api/update/status',{ticket:started.json.ticket});assert.equal(claimed.status,200);assert.equal(claimed.json.job.id,started.json.job.id);assert.equal(claimed.json.job.status,'queued');
  writeJson(f.statusFile,{...started.json.job,status:'running',startedAt:f.now()});assert.equal((await f.call('/api/update/status',{ticket:started.json.ticket})).json.job.status,'running');
});

test('status exposes only bounded public job fields',()=>{
  const original=job('rolled_back',{targetCommit:LATEST,previousCommit:OLD,targetVersion:'1.4.0',finishedAt:1000010,secret:'never expose'});
  const publicJob=sanitizeJob(original);assert.equal(publicJob.secret,undefined);assert.equal(publicJob.status,'rolled_back');assert.equal(publicJob.previousCommit,OLD);
  assert.throws(()=>sanitizeJob({...original,message:'x'.repeat(501)}));assert.throws(()=>sanitizeJob({...original,id:[original.id]}));assert.equal(sanitizeJob({status:'idle'}),null);
});

test('an expired session cannot start while its request body was in flight',async t=>{
  const f=await fixture(t,{updateOptions:{sessionMs:100}}),cookie=await f.login();await f.check(cookie);
  const result=await new Promise((resolve,reject)=>{
    const data=JSON.stringify({expectedCommit:LATEST});
    const req=http.request({host:'127.0.0.1',port:f.port,path:'/api/update/start',method:'POST',agent:false,headers:{origin:ORIGIN,cookie,'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });req.on('error',reject);req.write(data.slice(0,1));
    setTimeout(()=>{f.setTime(f.now()+101);req.end(data.slice(1));},20);
  });
  assert.equal(result,401);assert.equal(fs.existsSync(f.requestFile),false);
});

test('GitHub fetch is pinned, does not follow redirects and bounds response size/time',async()=>{
  const original=https.get;let scenario,seenURL,seenOptions;
  https.get=(url,options,callback)=>{
    seenURL=url;seenOptions=options;const req=new EventEmitter();req.destroy=()=>req.emit('error',Error('destroyed'));
    process.nextTick(()=>{
      if(scenario==='timeout')return;
      const res=new EventEmitter();res.statusCode=scenario==='redirect'?302:200;res.resume=()=>{};res.destroy=()=>{};callback(res);
      if(res.statusCode===200){res.emit('data',Buffer.from(scenario==='large'?'x'.repeat(100):JSON.stringify({ref:scenario==='wrong-ref'?'refs/heads/dev':'refs/heads/main',object:{type:scenario==='wrong-type'?'tag':'commit',sha:scenario==='invalid'?[LATEST]:LATEST}})));res.emit('end');}
    });return req;
  };
  try{
    scenario='success';assert.equal(await fetchLatestCommit(),LATEST);assert.equal(seenURL,GITHUB_URL);assert.match(seenURL,/\/git\/ref\/heads\/main$/);assert.equal(seenOptions.headers.Accept,'application/vnd.github+json');
    scenario='redirect';await assert.rejects(fetchLatestCommit(),/无法检查/);
    scenario='invalid';await assert.rejects(fetchLatestCommit(),/无法检查/);
    scenario='wrong-ref';await assert.rejects(fetchLatestCommit(),/无法检查/);
    scenario='wrong-type';await assert.rejects(fetchLatestCommit(),/无法检查/);
    scenario='large';await assert.rejects(fetchLatestCommit({maxBytes:10}),/无法检查/);
    scenario='timeout';const keepAlive=setTimeout(()=>{},50);try{await assert.rejects(fetchLatestCommit({timeoutMs:5}),/无法检查/);}finally{clearTimeout(keepAlive);}
  }finally{https.get=original;}
});
