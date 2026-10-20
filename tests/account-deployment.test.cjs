'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');
const {health}=require('../maintenance/update-worker.cjs');
const COMMIT='c'.repeat(40),ORIGIN='https://accounts.test';
const ADMIN={username:'deployment-admin',password:'account-admin-test-only'};
function fixture(t,{accountMode=true,cloudEnabled=true}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-account-health-'));
  fs.writeFileSync(path.join(directory,'runtime.env'),`BOAT_CLOUD_ENABLED=${cloudEnabled?'1':'0'}\nBOAT_CLOUD_ORIGIN=https://legacy-origin.test\nBOAT_CLOUD_PASSWORD=legacy-test-password\n`);
  const accounts=path.join(directory,'accounts.env');
  if(accountMode)fs.writeFileSync(accounts,`BOAT_ACCOUNTS_ENABLED=1\nBOAT_ACCOUNTS_ORIGIN=${ORIGIN}\nBOAT_ADMIN_USERNAME=${ADMIN.username}\nBOAT_ADMIN_PASSWORD=${ADMIN.password}\nBOAT_GUEST_USERNAME=guest-fixture\nBOAT_GUEST_PASSWORD=guest-test-password\n`);
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,accounts};
}
async function fakeServer(t,{accountMode=true}={}){
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);let body;try{body=JSON.parse(Buffer.concat(parts).toString()||'null');}catch(_){}
    calls.push({path:req.url,origin:req.headers.origin,cookie:req.headers.cookie,body});res.setHeader('Content-Type','application/json');
    if(req.url==='/healthz')return res.end(JSON.stringify({ok:true,app:'unmanned-boat-web',apiVersion:1,commit:COMMIT}));
    const login=accountMode?'/api/auth/login':'/api/cloud/login';
    if(req.url===login&&req.method==='POST'){
      const valid=accountMode?body?.username===ADMIN.username&&body?.password===ADMIN.password&&req.headers.origin===ORIGIN:body?.password==='legacy-test-password'&&req.headers.origin==='https://legacy-origin.test';
      if(valid){res.setHeader('Set-Cookie','fixture_session=accepted; HttpOnly');return res.end('{"ok":true}');}
    }
    if(req.url==='/api/cloud/devices'&&req.headers.cookie==='fixture_session=accepted')return res.end('{"brokerConnected":true,"devices":[]}');
    res.statusCode=403;res.end('{"error":"wrong authentication route"}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));return {port:server.address().port,calls};
}
function runInline(script,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-',...args],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}});let stdout='',stderr='';
    child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end(script);
  });
}
test('worker health uses unified admin account login and preserves its shared cloud cookie',async t=>{
  const f=fixture(t),server=await fakeServer(t);await health({port:server.port,commit:COMMIT,configDir:f.directory,timeout:2000});
  assert.deepEqual(server.calls.map(call=>call.path),['/healthz','/api/auth/login','/api/cloud/devices']);
  assert.deepEqual(server.calls[1].body,ADMIN);assert.equal(server.calls[1].origin,ORIGIN);assert.equal(server.calls[2].cookie,'fixture_session=accepted');
  assert.equal(server.calls.some(call=>call.path==='/api/cloud/login'),false);
});
test('worker health still accepts legacy cloud-only deployments without accounts.env',async t=>{
  const f=fixture(t,{accountMode:false}),server=await fakeServer(t,{accountMode:false});await health({port:server.port,commit:COMMIT,configDir:f.directory,timeout:2000});
  assert.deepEqual(server.calls.map(call=>call.path),['/healthz','/api/cloud/login','/api/cloud/devices']);assert.deepEqual(server.calls[1].body,{password:'legacy-test-password'});
});
test('deploy.sh executes its real readiness code using accounts.env without leaking credentials',async t=>{
  const f=fixture(t),server=await fakeServer(t),source=fs.readFileSync(path.join(__dirname,'../deploy.sh'),'utf8');
  const script=source.match(/if node - "\$port" "\$config\/runtime\.env" "\$config\/accounts\.env" <<'NODE'\r?\n([\s\S]+?)\r?\nNODE/)[1];
  const result=await runInline(script,[String(server.port),path.join(f.directory,'runtime.env'),f.accounts]);
  assert.equal(result.code,0,result.stderr);assert.deepEqual(server.calls.map(call=>call.path),['/healthz','/api/auth/login','/api/cloud/devices']);assert.equal((result.stdout+result.stderr).includes(ADMIN.password),false);
  assert.match(source,/EnvironmentFile=-\$config\/accounts\.env/);
});
test('worker build environment never receives production account credentials',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../maintenance/update-worker.cjs'),'utf8');
  const buildRun=source.match(/const buildRun=([\s\S]+?);\r?\n  return/)[1];
  assert.match(buildRun,/'-i'/);assert.doesNotMatch(buildRun,/BOAT_ADMIN|BOAT_GUEST|accounts\.env|\.\.\.process\.env/);
});
test('trusted candidate smoke validates account support using disposable credentials',async t=>{
  const f=fixture(t),candidate=path.join(f.directory,'candidate'),project=path.join(__dirname,'..');fs.mkdirSync(candidate);
  for(const name of ['server.js','package.json'])fs.copyFileSync(path.join(project,name),path.join(candidate,name));
  fs.cpSync(path.join(project,'server'),path.join(candidate,'server'),{recursive:true});fs.mkdirSync(path.join(candidate,'public'));
  fs.cpSync(path.join(project,'public/utils'),path.join(candidate,'public/utils'),{recursive:true});fs.writeFileSync(path.join(candidate,'public/index.html'),'<html><body>candidate</body></html>');
  const validator=path.join(project,'maintenance/validate-release.cjs');
  const script=`process.argv=['node','validate',${JSON.stringify(candidate)},${JSON.stringify(COMMIT)},'--accounts'];require(${JSON.stringify(validator)});`;
  const result=await runInline(script,[]);assert.equal(result.code,0,result.stderr);assert.equal((result.stdout+result.stderr).includes(ADMIN.password),false);
});
