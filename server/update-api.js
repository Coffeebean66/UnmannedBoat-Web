/* 网页更新管理入口：只创建固定格式请求，特权更新由独立 systemd worker 执行。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto');
const {isIP}=require('node:net');
const REPOSITORY=Object.freeze({url:'https://github.com/Coffeebean66/UnmannedBoat-Web',branch:'main'});
const GITHUB_URL='https://api.github.com/repos/Coffeebean66/UnmannedBoat-Web/git/ref/heads/main';
const COMMIT=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const JOB_STATUSES=new Set(['queued','running','succeeded','failed','rolled_back']);
const ACTIVE_STATUSES=new Set(['queued','running']);
const COOKIE='boat_update_session';
const digest=value=>crypto.createHash('sha256').update(value).digest();
const validCommit=value=>typeof value==='string'&&COMMIT.test(value);
const validId=value=>typeof value==='string'&&UUID.test(value);

function readJsonFile(file,limit){
  let fd;
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw Error('Invalid metadata');
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    const bytes=Buffer.alloc(limit+1),count=fs.readSync(fd,bytes,0,bytes.length,0);
    if(count>limit)throw Error('Metadata too large');
    return JSON.parse(bytes.subarray(0,count).toString('utf8'));
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}

function readCurrentRelease({releasePath=path.join(__dirname,'..','.boat-web-release.json'),version='unknown',instanceId=crypto.randomUUID()}={}){
  let release;
  try{release=readJsonFile(releasePath,4096);}catch(_){release=null;}
  return Object.freeze({version:typeof release?.version==='string'&&/^[A-Za-z0-9.+_-]{1,64}$/.test(release.version)?release.version:version,
    commit:validCommit(release?.commit)?release.commit:null,instanceId});
}

// 固定 GitHub API，不接受浏览器提供的 URL/分支，不追踪重定向。
function fetchLatestCommit({timeoutMs=10000,maxBytes=65536}={}){
  return new Promise((resolve,reject)=>{
    let settled=false,timer;
    const finish=(error,commit)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(Error('无法检查 GitHub 最新版本，请稍后重试'));else resolve(commit);};
    const request=https.get(GITHUB_URL,{headers:{'User-Agent':'UnmannedBoat-Web-Updater/1','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}},response=>{
      if(response.statusCode!==200){response.resume();finish(Error('HTTP error'));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){response.destroy();finish(Error('Response too large'));return;}chunks.push(chunk);});
      response.on('error',()=>finish(Error('Response error')));
      response.on('end',()=>{
        try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(data.ref!=='refs/heads/main'||data.object?.type!=='commit'||!validCommit(data.object.sha))throw Error('Invalid commit');finish(null,data.object.sha);}
        catch(_){finish(Error('Invalid response'));}
      });
    });
    timer=setTimeout(()=>{request.destroy();finish(Error('Timeout'));},timeoutMs);timer.unref?.();
    request.on('error',()=>finish(Error('Request error')));
  });
}

function validTime(value){return Number.isFinite(value)&&value>=0||typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));}
function sanitizeJob(value){
  if(value&&value.status==='idle'&&Object.keys(value).length===1)return null;
  if(!value||!validId(value.id)||!JOB_STATUSES.has(value.status)||!validCommit(value.expectedCommit))throw Error('Invalid update status');
  const result={id:value.id,status:value.status,expectedCommit:value.expectedCommit};
  for(const key of ['phase','message','targetVersion'])if(value[key]!==undefined){
    if(typeof value[key]!=='string'||value[key].length>(key==='message'?500:80))throw Error('Invalid update status');
    result[key]=value[key];
  }
  for(const key of ['requestedAt','startedAt','finishedAt'])if(value[key]!==undefined){if(!validTime(value[key]))throw Error('Invalid update status');result[key]=value[key];}
  for(const key of ['targetCommit','previousCommit'])if(value[key]!==undefined&&value[key]!==null){if(!validCommit(value[key]))throw Error('Invalid update status');result[key]=value[key];}
  return result;
}
function queuedJob(request){
  if(!request||!validId(request.id)||!validCommit(request.expectedCommit)||!validTime(request.requestedAt)||
      Object.keys(request).some(key=>!['id','expectedCommit','requestedAt'].includes(key)))throw Error('Invalid update request');
  return {...request,status:'queued',phase:'queued',message:'已提交更新请求，等待服务处理'};
}

function createUpdateApi({env=process.env,current=readCurrentRelease(),now=Date.now,checkLatest=fetchLatestCommit,
    maxSessions=32,sessionMs=30*60*1000,ticketMs=30*60*1000,checkMs,checkCacheMs=15000,helperOwnerUid=0,accounts}={}){
  const accountMode=!!accounts?.enabled,checkedMs=checkMs??(5*60*1000);
  const stateDir=env.BOAT_UPDATE_STATE_DIR||'/var/lib/unmanned-boat-web-update';
  const requestDir=path.join(stateDir,'requests'),requestFile=path.join(requestDir,'update.json');
  const statusFile=path.join(stateDir,'state','status.json'),configFile=path.join(stateDir,'config.json'),inflightFile=path.join(stateDir,'inflight.json');
  const secret=env.BOAT_UPDATE_PASSWORD||'',expectedPassword=digest(secret);
  const signingKey=crypto.createHmac('sha256',expectedPassword).update('boat-update-read-only-ticket-v1').digest();
  let configuredOrigin='',originValid=true;
  try{const value=env.BOAT_UPDATE_ORIGIN||env.BOAT_CLOUD_ORIGIN||'',parsed=new URL(value);
    if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==value||parsed.username||parsed.password)throw Error('Origin');configuredOrigin=value;
  }catch(_){originValid=false;}
  const sessions=new Map(),attempts=new Map();let closed=false,startBusy=false,checkInFlight=null,checkCache=null;
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const secure=req=>!!req.socket.encrypted||configuredOrigin.startsWith('https:')||(local(req)&&req.headers['x-forwarded-proto']==='https');
  const address=req=>local(req)&&isIP(req.headers['x-real-ip']||'')?req.headers['x-real-ip']:(req.socket.remoteAddress||'unknown');
  const sameOrigin=req=>accountMode?accounts.sameOrigin(req):req.headers.origin===configuredOrigin&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');
  const sessionKey=req=>{const token=String(req.headers.cookie||'').match(/(?:^|;\s*)boat_update_session=([a-f0-9]{64})(?:;|$)/)?.[1];return token?digest(token).toString('hex'):'';};
  const sessionFor=req=>{if(accountMode){const session=accounts.sessionFor(req);return session?.value.role==='admin'?session:null;}const key=sessionKey(req),value=sessions.get(key);if(!value)return null;if(value.expiresAt<=now()){sessions.delete(key);return null;}return {key,value};};
  const sessionActive=session=>!closed&&(accountMode?accounts.isActive(session)&&session.value.role==='admin':sessions.get(session.key)===session.value&&session.value.expiresAt>now());
  const cookie=(req,token,age)=>COOKIE+'='+token+'; Path=/api/update; HttpOnly; SameSite=Strict; Max-Age='+age+(secure(req)?'; Secure':'');
  function readiness(){
    if(closed||env.BOAT_UPDATE_ENABLED!=='1')return {enabled:false,reason:'服务器尚未启用网页更新'};
    if(secret.length<16||secret.length>256)return {enabled:false,reason:'管理员更新密码尚未正确配置'};
    if(!accountMode&&!originValid)return {enabled:false,reason:'网页更新访问来源尚未正确配置'};
    try{
      const config=readJsonFile(configFile,4096);
      if(config.apiVersion!==1||config.repository!==REPOSITORY.url||config.branch!==REPOSITORY.branch)throw Error('Helper config');
      const stat=fs.lstatSync(configFile);
      if(process.platform!=='win32'&&(stat.uid!==helperOwnerUid||(stat.mode&0o022)!==0))throw Error('Helper permissions');
      for(const dir of [stateDir,requestDir,path.dirname(statusFile)]){
        const entry=fs.lstatSync(dir);if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('Helper directory');
      }
      fs.accessSync(requestDir,fs.constants.W_OK);fs.accessSync(path.dirname(statusFile),fs.constants.R_OK);
      return {enabled:true};
    }catch(_){return {enabled:false,reason:'网页更新服务尚未安装或目录权限不正确'};}
  }
  function jobState(){
    let job=null,pending=null,inflight=null;
    try{job=sanitizeJob(readJsonFile(statusFile,16384));}catch(error){if(error.code!=='ENOENT')throw error;}
    try{pending=queuedJob(readJsonFile(requestFile,2048));}catch(error){if(error.code!=='ENOENT')throw error;}
    // 接管与 running 状态写入之间也保留同一个任务，轮询不会在重启前误报 404。
    try{inflight=queuedJob(readJsonFile(inflightFile,2048));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(pending&&inflight&&pending.id!==inflight.id)throw Error('Conflicting update requests');
    pending=pending||inflight;
    if(pending&&job?.id!==pending.id){if(job&&ACTIVE_STATUSES.has(job.status))throw Error('Conflicting update state');return pending;}
    return job||pending;
  }
  function requestExists(){
    // worker 接管请求后会移到 inflight；包括终态清理窗口在内始终只允许一个任务。
    for(const file of [requestFile,inflightFile]){
      try{fs.lstatSync(file);return true;}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return false;
  }
  function ticketFor(id){
    const payload=Buffer.from(JSON.stringify({jobId:id,expiresAt:now()+ticketMs})).toString('base64url');
    return payload+'.'+crypto.createHmac('sha256',signingKey).update(payload).digest('base64url');
  }
  function ticketJob(req){
    const token=req.headers['x-boat-update-ticket'];if(typeof token!=='string'||token.length>1024)return null;
    const parts=token.split('.');if(parts.length!==2||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))return null;
    const expected=crypto.createHmac('sha256',signingKey).update(parts[0]).digest(),actual=Buffer.from(parts[1],'base64url');
    if(actual.length!==expected.length||actual.toString('base64url')!==parts[1]||!crypto.timingSafeEqual(actual,expected))return null;
    try{const payload=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
      return validId(payload.jobId)&&Number.isFinite(payload.expiresAt)&&payload.expiresAt>now()?payload.jobId:null;
    }catch(_){return null;}
  }
  async function body(req){
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))throw {status:415};
    if(Number(req.headers['content-length'])>1024)throw {status:413};
    const chunks=[];let size=0;const timer=setTimeout(()=>req.destroy(),5000);timer.unref?.();
    try{for await(const chunk of req){size+=chunk.length;if(size>1024)throw {status:413};chunks.push(chunk);}const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!result||Array.isArray(result)||typeof result!=='object')throw Error('Invalid body');return result;
    }catch(error){throw {status:error.status||400};}finally{clearTimeout(timer);}
  }
  function createRequest(request){
    const temporary=path.join(requestDir,'.request-'+request.id+'.tmp');let fd;
    try{
      fd=fs.openSync(temporary,'wx',0o640);fs.writeFileSync(fd,JSON.stringify(request)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      // link 独占创建最终文件，worker 永远只看到完整 JSON，已有请求不会被覆盖。
      fs.linkSync(temporary,requestFile);
    }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(_){} }
  }
  async function latestCommit(){
    if(checkCache&&now()-checkCache.at<checkCacheMs){if(!checkCache.commit)throw Error('Check cooldown');return checkCache.commit;}
    if(!checkInFlight)checkInFlight=Promise.resolve().then(()=>checkLatest()).then(commit=>{
      if(!validCommit(commit))throw Error('Invalid GitHub commit');checkCache={commit,at:now()};return commit;
    }).catch(error=>{checkCache={commit:null,at:now()};throw error;}).finally(()=>{checkInFlight=null;});
    return checkInFlight;
  }
  async function handle(req,res,url){
    if(!url.pathname.startsWith('/api/update/'))return false;
    const ready=readiness();
    if(url.pathname==='/api/update/config'&&req.method==='GET'){
      json(res,200,{...ready,requiresLogin:ready.enabled&&!sessionFor(req),apiVersion:1});return true;
    }
    if(!ready.enabled){json(res,503,{error:ready.reason});return true;}
    if(accountMode){
      const shared=accounts.sessionFor(req);
      if(shared?.value.role==='guest'){json(res,403,{error:'访客账户仅可查看监测数据'});return true;}
      if(['/api/update/login','/api/update/session'].includes(url.pathname)){json(res,403,{error:'请使用平台账户登录或退出'});return true;}
    }
    if(url.pathname==='/api/update/login'&&req.method==='POST'){
      if(!sameOrigin(req)){json(res,403,{error:'请从本站发起更新操作'});return true;}
      const ip=address(req),time=now();let attempt=attempts.get(ip);
      if(!attempt||time-attempt.started>=60000){if(attempts.size>=1024)attempts.delete(attempts.keys().next().value);attempt={started:time,count:0};attempts.set(ip,attempt);}
      if(attempt.count>=8){res.setHeader('Retry-After','60');json(res,429,{error:'登录尝试过多，请一分钟后再试'});return true;}attempt.count++;
      let input;try{input=await body(req);}catch(error){json(res,error.status,{error:'登录请求格式不正确'});return true;}
      if(typeof input.password!=='string'||input.password.length>256||Object.keys(input).some(key=>key!=='password')||!crypto.timingSafeEqual(digest(input.password),expectedPassword)){
        json(res,401,{error:'管理员更新密码不正确'});return true;
      }
      if(closed){json(res,503,{error:'服务正在重启，请稍后重试'});return true;}
      const loginTime=now();for(const [key,value]of sessions)if(value.expiresAt<=loginTime)sessions.delete(key);
      sessions.delete(sessionKey(req));if(sessions.size>=maxSessions){json(res,503,{error:'管理员会话已满，请稍后再试'});return true;}
      const token=crypto.randomBytes(32).toString('hex');sessions.set(digest(token).toString('hex'),{expiresAt:loginTime+sessionMs,checked:null});
      res.setHeader('Set-Cookie',cookie(req,token,Math.floor(sessionMs/1000)));json(res,200,{ok:true});return true;
    }
    if(url.pathname==='/api/update/session'&&req.method==='DELETE'){
      if(!sameOrigin(req)){json(res,403,{error:'请从本站发起更新操作'});return true;}
      sessions.delete(sessionKey(req));res.setHeader('Set-Cookie',cookie(req,'',0));json(res,200,{ok:true});return true;
    }
    if(url.pathname==='/api/update/status'&&req.method==='GET'){
      const boundId=ticketJob(req),session=sessionFor(req);
      if(!boundId&&!session){json(res,401,{error:'请登录网页更新管理'});return true;}
      let job;try{job=jobState();}catch(_){json(res,503,{error:'更新状态文件不可用，请稍后重试'});return true;}
      if(boundId&&job?.id!==boundId){json(res,404,{error:'此更新任务的进度已不可用，请重新登录'});return true;}
      json(res,200,{current,repository:REPOSITORY,job});return true;
    }
    const session=sessionFor(req);
    if(!session){json(res,401,{error:'请登录网页更新管理'});return true;}
    if(!sameOrigin(req)){json(res,403,{error:'请从本站发起更新操作'});return true;}
    if(url.pathname==='/api/update/check'&&req.method==='POST'){
      let input;try{input=await body(req);}catch(error){json(res,error.status,{error:'检查请求格式不正确'});return true;}
      if(Object.keys(input).length){json(res,400,{error:'更新仓库和分支由服务器固定配置'});return true;}
      if(!sessionActive(session)){json(res,401,{error:'管理员会话已过期，请重新登录'});return true;}
      try{
        const commit=await latestCommit();
        if(!sessionActive(session)){json(res,401,{error:'管理员会话已过期，请重新登录'});return true;}
        session.value.checked={commit,at:now()};json(res,200,{latestCommit:commit,available:current.commit!==commit});
      }catch(_){json(res,502,{error:'无法检查 GitHub 最新版本，请稍后重试'});}return true;
    }
    if(url.pathname==='/api/update/start'&&req.method==='POST'){
      let input;try{input=await body(req);}catch(error){json(res,error.status,{error:'更新请求格式不正确'});return true;}
      if(!validCommit(input.expectedCommit)||Object.keys(input).some(key=>key!=='expectedCommit')){json(res,400,{error:'请先检查固定仓库的最新版本'});return true;}
      if(!sessionActive(session)){json(res,401,{error:'管理员会话已过期，请重新登录'});return true;}
      if(startBusy){json(res,409,{error:'已有更新任务正在处理'});return true;}startBusy=true;
      try{
        const job=jobState();if(requestExists()||job&&ACTIVE_STATUSES.has(job.status)){json(res,409,{error:'已有更新任务正在处理'});return true;}
        if(!session.value.checked||session.value.checked.commit!==input.expectedCommit||now()-session.value.checked.at>checkedMs){json(res,412,{error:'版本检查已失效，请重新检查更新'});return true;}
        if(current.commit===input.expectedCommit){json(res,409,{error:'当前已经运行此版本'});return true;}
        const request={id:crypto.randomUUID(),expectedCommit:input.expectedCommit,requestedAt:now()};
        try{createRequest(request);}catch(error){if(error.code==='EEXIST'){json(res,409,{error:'已有更新任务正在处理'});return true;}throw error;}
        session.value.checked=null;json(res,202,{job:queuedJob(request),ticket:ticketFor(request.id)});
      }catch(_){json(res,503,{error:'更新状态或请求目录不可用，请稍后重试'});}finally{startBusy=false;}return true;
    }
    json(res,404,{error:'更新接口不存在'});return true;
  }
  function close(){closed=true;sessions.clear();attempts.clear();checkCache=null;}
  return {handle,close,current,getSessionCount:()=>sessions.size};
}
module.exports={createUpdateApi,readCurrentRelease,fetchLatestCommit,REPOSITORY,GITHUB_URL,sanitizeJob};
