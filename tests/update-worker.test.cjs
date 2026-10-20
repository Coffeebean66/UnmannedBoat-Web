'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {runUpdate,validateRequest,safeCopyTree,REPOSITORY,BRANCH}=require('../maintenance/update-worker.cjs');
const {sanitizeJob}=require('../server/update-api');
const OLD='1'.repeat(40),LATEST='a'.repeat(40),OTHER='b'.repeat(40);
const MARKER='unmanned-boat-web-v1';
function write(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
function json(file,value){write(file,JSON.stringify(value));}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function request(overrides={}){return {id:randomUUID(),expectedCommit:LATEST,requestedAt:Date.now(),...overrides};}
function app(directory,label='new-app'){
  write(path.join(directory,'public/index.html'),'<html>'+label+'</html>');write(path.join(directory,'server.js'),'// '+label);
  write(path.join(directory,'server/update-api.js'),'// update API');write(path.join(directory,'node_modules/dependency/index.js'),'module.exports={};');
  json(path.join(directory,'package.json'),{name:'unmanned-boat-monitor-web',version:'1.4.0'});json(path.join(directory,'package-lock.json'),{lockfileVersion:3});
}
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'boat-worker-test-')),target=path.join(base,'opt/unmanned-boat-web'),stateDir=path.join(base,'state'),configDir=path.join(base,'config'),helperDir=path.join(base,'helper');
  fs.mkdirSync(path.join(stateDir,'requests'),{recursive:true});fs.mkdirSync(path.join(stateDir,'state'));fs.mkdirSync(configDir);fs.mkdirSync(helperDir);
  app(target,'old-app');write(path.join(target,'.boat-web-deployment'),MARKER+'\n');json(path.join(target,'.boat-web-release.json'),{version:'1.3.0',commit:OLD});
  write(path.join(configDir,'runtime.env'),'BOAT_CLOUD_PASSWORD=fixture-secret-not-for-build\n');write(path.join(helperDir,'trusted.txt'),'root-maintained-helper');
  const requestFile=path.join(stateDir,'requests/update.json'),inflightFile=path.join(stateDir,'inflight.json'),statusFile=path.join(stateDir,'state/status.json'),transactionFile=path.join(stateDir,'transaction.json');
  json(statusFile,{status:'idle'});const events=[],errors=[];
  const adapters={
    async prepare(directory,value){events.push('prepare');app(directory);return value.expectedCommit;},
    async build(directory,commit){events.push('build');assert.equal(commit,LATEST);return '1.4.0';},
    async service(action){events.push(action);},async health(commit){events.push('health');assert.equal(read(path.join(target,'.boat-web-release.json')).commit,commit);},
    async stopBuild(){events.push('stopBuild');},async freeze(){events.push('freeze');},log:error=>errors.push(error)
  };
  t.after(()=>{
    assert.equal(path.dirname(base),fs.realpathSync(os.tmpdir()));assert.match(path.basename(base),/^boat-worker-test-/);
    fs.rmSync(base,{recursive:true,force:true});
  });
  return {base,target,stateDir,configDir,helperDir,requestFile,inflightFile,statusFile,transactionFile,events,errors,adapters,
    queue(value=request()){json(requestFile,value);return value;},
    run(overrides={}){return runUpdate({target,stateDir,configDir,helperDir,checkOwnership:false,adapters:{...adapters,...overrides}});},
    services:()=>events.filter(event=>event==='start'||event==='stop'),
    assertOld(){assert.match(fs.readFileSync(path.join(target,'public/index.html'),'utf8'),/old-app/);assert.equal(read(path.join(target,'.boat-web-release.json')).commit,OLD);},
    assertClean(){assert.equal(fs.existsSync(inflightFile),false);assert.equal(fs.existsSync(path.join(stateDir,'worker.lock')),false);assert.equal(fs.readdirSync(stateDir).some(name=>name.startsWith('work-')),false);assert.equal(fs.readdirSync(path.dirname(target)).some(name=>name.startsWith('.boat-web-update-stage-')),false);}
  };
}

test('worker validates strict fixed request types, bounded freshness and no caller source/command',()=>{
  const now=Date.now(),value=request({requestedAt:now});assert.deepEqual(validateRequest(value,now),value);assert.equal(REPOSITORY,'https://github.com/Coffeebean66/UnmannedBoat-Web');assert.equal(BRANCH,'main');
  for(const invalid of [{...value,id:[value.id]},{...value,expectedCommit:[LATEST]},{...value,expectedCommit:LATEST.toUpperCase()},{...value,requestedAt:String(now)},{...value,requestedAt:now-15*60*1000-1},{...value,requestedAt:now+60001},{...value,url:'https://evil.test'}, {...value,branch:'dev'}, {...value,command:'echo no'}])assert.throws(()=>validateRequest(invalid,now));
});

test('successful worker update freezes build artifacts, switches runtime only and preserves a recovery copy',async t=>{
  const f=fixture(t),queued=f.queue(),result=await f.run();assert.equal(result.status,'succeeded');assert.equal(result.id,queued.id);
  assert.deepEqual(f.services(),['stop','start']);assert.ok(f.events.indexOf('stopBuild')<f.events.indexOf('prepare'));assert.ok(f.events.indexOf('freeze')>f.events.indexOf('build'));assert.ok(f.events.indexOf('freeze')<f.events.indexOf('stop'));
  assert.match(fs.readFileSync(path.join(f.target,'public/index.html'),'utf8'),/new-app/);assert.equal(read(path.join(f.target,'.boat-web-release.json')).commit,LATEST);
  const status=read(f.statusFile);assert.equal(sanitizeJob(status).status,'succeeded');assert.equal(status.targetCommit,LATEST);assert.equal(status.previousCommit,OLD);
  const backup=fs.readdirSync(path.dirname(f.target)).find(name=>name.startsWith('unmanned-boat-web.update-backup-'));assert.ok(backup);assert.match(fs.readFileSync(path.join(path.dirname(f.target),backup,'app/public/index.html'),'utf8'),/old-app/);
  assert.equal(fs.readFileSync(path.join(f.configDir,'runtime.env'),'utf8'),'BOAT_CLOUD_PASSWORD=fixture-secret-not-for-build\n');assert.equal(fs.readFileSync(path.join(f.helperDir,'trusted.txt'),'utf8'),'root-maintained-helper');
  assert.equal(fs.existsSync(f.requestFile),false);assert.equal(fs.existsSync(f.transactionFile),false);assert.equal(read(path.join(f.stateDir,'history',queued.id+'.json')).status,'succeeded');f.assertClean();
});

test('prepare or candidate validation failure never stops the working old site',async t=>{
  for(const phase of ['prepare','build']){
    const f=fixture(t);f.queue();const result=await f.run({[phase]:async()=>{throw Error('simulated '+phase+' failure');}});
    assert.equal(result.status,'failed');assert.deepEqual(f.services(),[]);f.assertOld();assert.equal(sanitizeJob(read(f.statusFile)).status,'failed');assert.ok(f.events.includes('stopBuild'));f.assertClean();
  }
});

test('unquiesced build processes prohibit copying, switching and unsafe work cleanup',async t=>{
  const f=fixture(t);f.queue();let stops=0;
  const result=await f.run({stopBuild:async()=>{if(++stops>1)throw Error('build account remains active');}});
  assert.equal(result.status,'failed');assert.deepEqual(f.services(),[]);assert.equal(f.events.includes('freeze'),false);f.assertOld();
  assert.equal(fs.readdirSync(f.stateDir).some(name=>name.startsWith('work-')),true);assert.equal(fs.existsSync(path.join(f.stateDir,'worker.lock')),false);
});

test('a moved main tip or missing update API is rejected before service stop',async t=>{
  const moved=fixture(t);moved.queue();assert.equal((await moved.run({prepare:async directory=>{app(directory);return OTHER;}})).status,'failed');assert.deepEqual(moved.services(),[]);moved.assertOld();moved.assertClean();
  const missing=fixture(t);missing.queue();assert.equal((await missing.run({build:async directory=>{fs.unlinkSync(path.join(directory,'server/update-api.js'));return '1.4.0';}})).status,'failed');assert.deepEqual(missing.services(),[]);missing.assertOld();missing.assertClean();
});

test('new service health failure restores old files and keeps the failed release for inspection',async t=>{
  const f=fixture(t);f.queue();const result=await f.run({health:async commit=>{if(commit===LATEST)throw Error('new release unhealthy');assert.equal(commit,OLD);}});
  assert.equal(result.status,'rolled_back');assert.deepEqual(f.services(),['stop','start','stop','start']);f.assertOld();assert.equal(sanitizeJob(read(f.statusFile)).status,'rolled_back');assert.equal(fs.existsSync(f.transactionFile),false);
  const backup=fs.readdirSync(path.dirname(f.target)).find(name=>name.startsWith('unmanned-boat-web.update-backup-'));assert.match(fs.readFileSync(path.join(path.dirname(f.target),backup,'failed-app/public/index.html'),'utf8'),/new-app/);f.assertClean();
});

test('service start failure also rolls back rather than leaving the candidate installed',async t=>{
  const f=fixture(t);f.queue();let starts=0;
  const result=await f.run({service:async action=>{f.events.push(action);if(action==='start'&&++starts===1)throw Error('start failed');}});
  assert.equal(result.status,'rolled_back');assert.equal(starts,2);f.assertOld();f.assertClean();
});

test('a failed rollback health check reports recovery-required and retains its transaction',async t=>{
  const f=fixture(t);f.queue();const result=await f.run({health:async()=>{throw Error('all health checks unavailable');}});
  assert.equal(result.status,'failed');assert.equal(result.phase,'recovery_required');assert.equal(fs.existsSync(f.transactionFile),true);f.assertOld();assert.deepEqual(f.services(),['stop','start','stop','start']);
  await f.run();assert.equal(fs.existsSync(f.transactionFile),false);assert.equal(sanitizeJob(read(f.statusFile)).status,'rolled_back');f.assertOld();f.assertClean();
});

test('recovery does not claim rollback success while the restored old app is still unhealthy',async t=>{
  const f=fixture(t);f.queue();
  await f.run({health:async()=>{throw Error('all health checks unavailable');}});
  f.assertOld();assert.equal(fs.existsSync(f.transactionFile),true);
  const attempts=[];
  await f.run({health:async commit=>{attempts.push(commit);throw Error('old service still unhealthy');}});
  assert.ok(attempts.length>=1);assert.ok(attempts.every(commit=>commit===OLD));
  const status=sanitizeJob(read(f.statusFile));assert.equal(status.status,'failed');assert.equal(status.phase,'recovery_required');
  assert.equal(fs.existsSync(f.transactionFile),true);f.assertOld();
  await f.run();assert.equal(sanitizeJob(read(f.statusFile)).status,'rolled_back');assert.equal(fs.existsSync(f.transactionFile),false);f.assertClean();
});

test('candidate symlinks/junctions and special file-copy overflow are rejected without switching',async t=>{
  const f=fixture(t);f.queue();const external=path.join(f.base,'external');fs.mkdirSync(external);write(path.join(external,'secret.txt'),'not public');
  const result=await f.run({build:async directory=>{fs.symlinkSync(external,path.join(directory,'public','linked'),process.platform==='win32'?'junction':'dir');return '1.4.0';}});
  assert.equal(result.status,'failed');assert.deepEqual(f.services(),[]);f.assertOld();f.assertClean();
  const source=path.join(f.base,'copy-source'),destination=path.join(f.base,'copy-destination');write(source,'x');await assert.rejects(safeCopyTree(source,destination,{files:30000,bytes:0}),/超出限制/);assert.equal(fs.existsSync(destination),false);
});

test('a duplicate completed request is consumed without rebuilding or changing the site',async t=>{
  const f=fixture(t),queued=f.queue();assert.equal((await f.run()).status,'succeeded');f.events.length=0;f.queue({...queued,requestedAt:Date.now()});
  assert.equal((await f.run()).status,'duplicate');assert.deepEqual(f.services(),[]);assert.equal(f.events.includes('prepare'),false);assert.equal(fs.existsSync(f.requestFile),false);assert.equal(sanitizeJob(read(f.statusFile)).status,'succeeded');f.assertClean();
});

test('an active process lock returns busy without consuming a queued request',async t=>{
  const f=fixture(t);f.queue();const lock=path.join(f.stateDir,'worker.lock');fs.mkdirSync(lock);json(path.join(lock,'owner.json'),{pid:process.pid});
  assert.equal((await f.run()).status,'busy');assert.equal(fs.existsSync(f.requestFile),true);assert.deepEqual(f.services(),[]);f.assertOld();
});

test('interrupted rename transactions recover the old app from actual disk state',async t=>{
  for(const hasNewApp of [false,true]){
    const f=fixture(t),queued=request(),backup=fs.mkdtempSync(path.join(path.dirname(f.target),'unmanned-boat-web.update-backup-'));
    fs.renameSync(f.target,path.join(backup,'app'));if(hasNewApp)app(f.target,'interrupted-new-app');
    const oldJob={...queued,status:'running',phase:'restarting',previousCommit:OLD,targetCommit:LATEST,startedAt:Date.now()};
    json(f.transactionFile,{id:queued.id,target:f.target,backup,targetCommit:LATEST,oldMoved:false,newMoved:false,stopped:false,job:oldJob});json(f.inflightFile,queued);
    await f.run();f.assertOld();assert.equal(sanitizeJob(read(f.statusFile)).status,'rolled_back');assert.equal(fs.existsSync(f.transactionFile),false);assert.deepEqual(f.services(),['stop','start']);
    if(hasNewApp)assert.match(fs.readFileSync(path.join(backup,'failed-app/public/index.html'),'utf8'),/interrupted-new-app/);f.assertClean();
  }
});

test('an orphan inflight request records a valid interrupted job and remains retryable',async t=>{
  const f=fixture(t),queued=request();json(f.inflightFile,queued);await f.run();
  const status=sanitizeJob(read(f.statusFile));assert.equal(status.status,'failed');assert.equal(status.id,queued.id);assert.deepEqual(f.services(),[]);f.assertOld();f.assertClean();
  f.queue();assert.equal((await f.run()).status,'succeeded');
});

test('expired or malformed requests cannot poison API status or permanently block later requests',async t=>{
  for(const invalid of [request({requestedAt:Date.now()-16*60*1000}),{command:'ignored'},request({expectedCommit:[LATEST]})]){
    const f=fixture(t);f.queue(invalid);await f.run();assert.doesNotThrow(()=>sanitizeJob(read(f.statusFile)));assert.deepEqual(f.services(),[]);f.assertOld();f.assertClean();
    f.queue();assert.equal((await f.run()).status,'succeeded');
  }
});

test('trusted compatibility smoke rejects pre-update servers without touching a running service',t=>{
  const f=fixture(t),candidate=path.join(f.base,'old-candidate');app(candidate);
  write(path.join(candidate,'server.js'),"const http=require('node:http');exports.createServer=()=>http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,app:'unmanned-boat-web'}));});\n");
  const result=spawnSync(process.execPath,[path.join(__dirname,'../maintenance/validate-release.cjs'),candidate,LATEST],{encoding:'utf8',timeout:10000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/health contract is unsupported/);assert.deepEqual(f.services(),[]);f.assertOld();
});
