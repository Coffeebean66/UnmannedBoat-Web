/* Root-owned updater. Repository code is built and checked only as boat-web-build. */
'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const REPOSITORY='https://github.com/Coffeebean66/UnmannedBoat-Web';
const BRANCH='main',MARKER='unmanned-boat-web-v1',BUILD_USER='boat-web-build';
const ALLOWED=['public','server','server.js','package.json','package-lock.json','node_modules'];
const MAX_FILES=30000,MAX_BYTES=512*1024*1024;
const DEFAULTS=Object.freeze({target:'/opt/unmanned-boat-web',stateDir:'/var/lib/unmanned-boat-web-update',configDir:'/etc/unmanned-boat-web',helperDir:'/usr/local/lib/unmanned-boat-web-update',service:'unmanned-boat-web.service',node:process.execPath,npm:'/usr/bin/npm',git:'/usr/bin/git',runuser:'/usr/sbin/runuser',systemctl:'/usr/bin/systemctl',checkOwnership:true});
class UpdateError extends Error {constructor(message){super(message);this.name='UpdateError';}}
async function exists(file){try{await fsp.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function ordinary(file,{directory=false,root=false}={}){
  const s=await fsp.lstat(file);
  if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||(root&&(s.uid!==0||(s.mode&0o022)!==0)))throw new UpdateError('更新目录或文件权限检查失败');
  return s;
}
async function noLinkedParents(file){let current=path.resolve(file);for(;;){const s=await fsp.lstat(current);if(s.isSymbolicLink()||!s.isDirectory())throw new UpdateError('更新路径检查失败');const next=path.dirname(current);if(next===current)return;current=next;}}
async function readJson(file,max=16384){
  const handle=await fsp.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const s=await handle.stat();if(!s.isFile()||s.size>max)throw new UpdateError('更新状态文件格式错误');return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
}
async function writeJson(file,value,mode=0o644){
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try{await fsp.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode});await fsp.rename(temporary,file);}finally{await fsp.unlink(temporary).catch(()=>{});}
}
function validateRequest(value,now=Date.now()){
  if(!value||Object.keys(value).some(k=>!['id','expectedCommit','requestedAt'].includes(k))||
    typeof value.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)||
    typeof value.expectedCommit!=='string'||!/^[0-9a-f]{40}$/.test(value.expectedCommit)||!Number.isSafeInteger(value.requestedAt)||
    value.requestedAt<now-15*60*1000||value.requestedAt>now+60000)throw new UpdateError('更新请求无效或已过期，请重新检查更新');
  return {id:value.id,expectedCommit:value.expectedCommit,requestedAt:value.requestedAt};
}
// No shell or credential-bearing inherited environment is passed to build commands.
function command(executable,args,{cwd,env={},timeout=120000,maxOutput=1024*1024}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    let stdout='',stderr='',tooLarge=false,timedOut=false,killTimer;
    const kill=signal=>{try{if(process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal);}catch(_){}};
    const stop=()=>{kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000);killTimer.unref();};
    const timer=setTimeout(()=>{timedOut=true;stop();},timeout);timer.unref();
    child.stdout.on('data',buffer=>{stdout+=buffer;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>maxOutput&&!tooLarge){tooLarge=true;stop();}});
    child.stderr.on('data',buffer=>{stderr+=buffer;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>maxOutput&&!tooLarge){tooLarge=true;stop();}});
    child.on('error',error=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);if(code!==0||tooLarge||timedOut){const error=new Error(timedOut?'Command timeout':tooLarge?'Command output limit':'Command failed: '+path.basename(executable));error.command=path.basename(executable);error.code=code;error.detail=stderr.slice(-4096);reject(error);}else resolve(stdout.trim());});
  });
}
async function safeCopyTree(source,destination,budget={files:0,bytes:0}){
  const s=await fsp.lstat(source);
  if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw new UpdateError('候选版本包含不支持的链接或特殊文件');
  if(s.isDirectory()){
    await fsp.mkdir(destination,{mode:0o755});
    for(const name of await fsp.readdir(source)){if(name==='.'||name==='..')throw new UpdateError('候选版本目录错误');await safeCopyTree(path.join(source,name),path.join(destination,name),budget);}
    return;
  }
  if(++budget.files>MAX_FILES||(budget.bytes+=s.size)>MAX_BYTES)throw new UpdateError('候选版本文件数量或大小超出限制');
  const input=await fsp.open(source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const opened=await input.stat();
    if(!opened.isFile()||opened.dev!==s.dev||opened.ino!==s.ino||opened.size!==s.size)throw new UpdateError('候选版本在复制时发生变化');
    const output=await fsp.open(destination,'wx',0o644);
    try{
      const buffer=Buffer.alloc(65536);let offset=0;
      while(offset<opened.size){const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,opened.size-offset),offset);if(!bytesRead)throw new UpdateError('候选文件复制失败');await output.write(buffer,0,bytesRead,offset);offset+=bytesRead;}
      await output.sync();
    }finally{await output.close();}
  }finally{await input.close();}
}
async function readEnvironment(file){
  if(!await exists(file))return {};
  await ordinary(file);
  const text=await fsp.readFile(file,'utf8');
  return Object.fromEntries(text.split(/\r?\n/).filter(line=>/^[A-Z_]+=.*/.test(line)).map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];}));
}
async function managedAccountsPresent({runtime={},stateDir='/var/lib/unmanned-boat-web-update'}={}){
  const files=runtime.BOAT_ACCOUNTS_FILE?[runtime.BOAT_ACCOUNTS_FILE]:[
    '/var/lib/unmanned-boat-web/accounts.json',path.join(stateDir,'requests','accounts.json')];
  for(const file of files){
    if(!path.isAbsolute(file))throw new UpdateError('账户库配置路径无效');
    if(await exists(file)){await ordinary(file);return true;}
  }
  return false;
}
function readinessMatches(readiness,runtime){
  return !!readiness&&typeof readiness==='object'&&!Array.isArray(readiness)&&
    typeof readiness.cloudEnabled==='boolean'&&typeof readiness.brokerConnected==='boolean'&&
    typeof readiness.accountsEnabled==='boolean'&&readiness.accountManagement===1&&
    readiness.cloudEnabled===(runtime.BOAT_CLOUD_ENABLED==='1')&&
    readiness.accountsEnabled===(runtime.BOAT_ACCOUNTS_ENABLED==='1')&&
    (!readiness.cloudEnabled||readiness.brokerConnected===true);
}
async function health({port,commit,configDir,stateDir='/var/lib/unmanned-boat-web-update',timeout=30000,retryMs=1000}){
  const runtime={...await readEnvironment(path.join(configDir,'runtime.env')),...await readEnvironment(path.join(configDir,'accounts.env'))};
  const managed=await managedAccountsPresent({runtime,stateDir});
  const base='http://127.0.0.1:'+port,end=Date.now()+timeout;let cloudCookie;
  while(Date.now()<end){
    try{
      const request=(route,options={})=>fetch(base+route,{...options,signal:AbortSignal.timeout(2000)});
      const response=await request('/healthz'),data=await response.json();
      if(!response.ok||data.app!=='unmanned-boat-web'||data.ok!==true||data.apiVersion!==1||data.commit!==commit)throw Error('health');
      // Account changes invalidate the bootstrap environment password. The new
      // server reports bounded readiness without minting an administrator session.
      if(Object.hasOwn(data,'readiness')){
        if(!readinessMatches(data.readiness,runtime))throw Error('readiness');
        return;
      }
      if(managed)throw Error('managed account readiness is unsupported');
      if(runtime.BOAT_CLOUD_ENABLED==='1'){
        if(!cloudCookie){
          const accounts=runtime.BOAT_ACCOUNTS_ENABLED==='1';
          const login=await request(accounts?'/api/auth/login':'/api/cloud/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:runtime.BOAT_ACCOUNTS_ORIGIN||runtime.BOAT_CLOUD_ORIGIN||runtime.BOAT_UPDATE_ORIGIN},body:JSON.stringify(accounts?{username:runtime.BOAT_ADMIN_USERNAME,password:runtime.BOAT_ADMIN_PASSWORD}:{password:runtime.BOAT_CLOUD_PASSWORD})});
          cloudCookie=(login.headers.get('set-cookie')||'').split(';')[0];
          if(!login.ok||!cloudCookie){cloudCookie=undefined;throw Error('cloud login');}
        }
        const devices=await request('/api/cloud/devices',{headers:{Cookie:cloudCookie}});
        if(!devices.ok||(await devices.json()).brokerConnected!==true)throw Error('cloud broker');
      }
      return;
    }catch(_){await new Promise(resolve=>setTimeout(resolve,retryMs));}
  }
  throw new UpdateError('新版本启动或云端连接检查失败');
}
function productionAdapters(config){
  const restricted={PATH:path.dirname(config.node)+':/usr/bin:/bin',LANG:'C.UTF-8',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'};
  const rootRun=(file,args,options={})=>command(file,args,{env:restricted,...options});
  const buildRun=(file,args,options={})=>rootRun(config.runuser,['-u',BUILD_USER,'--','/usr/bin/env','-i',...Object.entries({...restricted,HOME:path.join(config.stateDir,'build-home'),NPM_CONFIG_CACHE:path.join(config.stateDir,'build-home/.npm'),NODE_OPTIONS:'--max-old-space-size=384'}).map(([k,v])=>k+'='+v),file,...args],options);
  return {
    async stopBuild(){
      // The account is dedicated to this locked worker. Kill even setsid/double-fork
      // descendants before root inspects/copies/removes any build-owned directory.
      const uid=await rootRun('/usr/bin/id',['-u',BUILD_USER]);
      if(!/^\d+$/.test(uid)||uid==='0')throw new UpdateError('构建账户配置错误');
      for(let attempt=0;attempt<10;attempt++){
        try{await rootRun('/usr/bin/pkill',['-KILL','-u',uid]);}catch(error){if(error.code!==1)throw error;}
        try{await rootRun('/usr/bin/pgrep',['-u',uid]);}catch(error){if(error.code===1)return;throw error;}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new UpdateError('构建进程未能安全停止');
    },
    freeze:directory=>rootRun('/usr/bin/chown',['-hR','-P','root:root',directory]),
    async prepare(directory,request){
      await rootRun('/usr/bin/chown',[BUILD_USER+':'+BUILD_USER,directory]);
      await buildRun(config.git,['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','clone','--no-checkout','--depth=1','--single-branch','--branch',BRANCH,REPOSITORY+'.git',directory],{timeout:180000});
      const commit=await buildRun(config.git,['-C',directory,'rev-parse','refs/remotes/origin/'+BRANCH]);
      if(commit!==request.expectedCommit)throw new UpdateError('GitHub main 已变化，请重新检查更新后再试');
      await buildRun(config.git,['-C',directory,'-c','core.hooksPath=/dev/null','checkout','--detach',commit]);
      const files=await buildRun(config.git,['-C',directory,'ls-files','--stage']);
      if(files.split('\n').some(line=>line.startsWith('120000 ')||line.startsWith('160000 ')))throw new UpdateError('仓库包含不支持的链接或子模块');
      return commit;
    },
    async build(directory,commit){
      for(const name of ['package.json','package-lock.json','build-bundle.js','server.js','server/update-api.js'])await ordinary(path.join(directory,name));
      const manifest=await readJson(path.join(directory,'package.json'));
      if(manifest.name!=='unmanned-boat-monitor-web'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version||''))throw new UpdateError('候选版本应用标识或版本无效');
      await buildRun(config.npm,['ci','--prefix',directory,'--omit=dev','--ignore-scripts','--no-bin-links','--no-audit','--no-fund'],{timeout:300000});
      await buildRun(config.node,[path.join(directory,'build-bundle.js')],{cwd:directory,timeout:60000});
      await buildRun(config.node,['--check',path.join(directory,'server.js')],{timeout:30000});
      const accounts={...await readEnvironment(path.join(config.configDir,'runtime.env')),...await readEnvironment(path.join(config.configDir,'accounts.env'))};
      const managed=await managedAccountsPresent({runtime:accounts,stateDir:config.stateDir});
      if(accounts.BOAT_ACCOUNTS_ENABLED==='1')await ordinary(path.join(directory,'server/account-api.js'));
      await buildRun(config.node,[path.join(config.helperDir,'validate-release.cjs'),directory,commit,...(accounts.BOAT_ACCOUNTS_ENABLED==='1'?['--accounts']:[]),...(managed?['--managed-accounts']:[])],{timeout:30000});
      return manifest.version;
    },
    service:action=>rootRun(config.systemctl,[action,config.service],{timeout:30000}),
    health:commit=>health({port:config.port,commit,configDir:config.configDir,stateDir:config.stateDir}),
    log:error=>console.error('[boat-update]',error.message,error.command||'',error.detail||'')
  };
}
async function getRelease(directory){try{const value=await readJson(path.join(directory,'.boat-web-release.json'));return /^[0-9a-f]{40}$/.test(value.commit||'')?value.commit:null;}catch(_){return null;}}
async function acquireLock(directory){
  try{await fsp.mkdir(directory,{mode:0o700});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    await ordinary(directory,{directory:true});
    const value=await readJson(path.join(directory,'owner.json')).catch(()=>null);
    if(!Number.isSafeInteger(value?.pid)||value.pid<=0)throw new UpdateError('更新锁异常，需要管理员检查');
    try{process.kill(value.pid,0);return false;}catch(error){if(error.code!=='ESRCH')return false;}
    await fsp.rm(directory,{recursive:true});await fsp.mkdir(directory,{mode:0o700});
  }
  await writeJson(path.join(directory,'owner.json'),{pid:process.pid},0o600);return true;
}
// Injectable adapters are available only to callers of this module, never HTTP/env inputs.
async function runUpdate(options={}){
  const config={...DEFAULTS,...options};
  const a={...productionAdapters(config),...options.adapters};
  const state=config.stateDir,requestFile=path.join(state,'requests/update.json'),inflight=path.join(state,'inflight.json');
  const statusFile=path.join(state,'state/status.json'),lock=path.join(state,'worker.lock'),transactionFile=path.join(state,'transaction.json');
  await noLinkedParents(state);await noLinkedParents(path.dirname(config.target));
  await ordinary(state,{directory:true,root:config.checkOwnership});
  if(!await acquireLock(lock))return {status:'busy'};
  let job,work,candidate,backup,oldMoved=false,newMoved=false,stopped=false,claim=false,buildStopped=false;
  const status=async(status,phase,message,extra={})=>{job={...job,status,phase,message,...extra};await writeJson(statusFile,job);};
  const saveTransaction=()=>writeJson(transactionFile,{id:job.id,target:config.target,candidate,backup,targetCommit:job.targetCommit,oldMoved,newMoved,stopped,job},0o600);
  const undo=async()=>{
    await a.service('stop');
    if(newMoved&&await exists(config.target))await fsp.rename(config.target,path.join(backup,'failed-app'));
    if(oldMoved&&await exists(path.join(backup,'app')))await fsp.rename(path.join(backup,'app'),config.target);
    await a.service('start');
    await a.health(job.previousCommit??null);
  };
  try{
    await ordinary(path.join(state,'state'),{directory:true,root:config.checkOwnership});
    await a.stopBuild();buildStopped=true;
    // A previous interrupted switch is recovered on boot before accepting another request.
    if(await exists(transactionFile)){
      const tx=await readJson(transactionFile);
      const parent=path.dirname(config.target),prefix=path.basename(config.target)+'.update-backup-';
      if(tx.target!==config.target||typeof tx.backup!=='string'||path.dirname(tx.backup)!==parent||!path.basename(tx.backup).startsWith(prefix))throw new UpdateError('中断更新的恢复信息无效，需要管理员检查');
      await ordinary(tx.backup,{directory:true,root:config.checkOwnership});
      job=tx.job;backup=tx.backup;oldMoved=await exists(path.join(backup,'app'));newMoved=oldMoved&&await exists(config.target);stopped=true;
      if(oldMoved)await undo();else {await a.service('start');await a.health(job.previousCommit??null);}
      await status('rolled_back','recovery','已恢复中断更新前的服务',{finishedAt:Date.now()});
      await fsp.unlink(transactionFile);await fsp.unlink(inflight).catch(()=>{});
      backup=undefined;oldMoved=false;newMoved=false;stopped=false;job=undefined;
    }
    if(!await exists(requestFile)){
      if(await exists(inflight)){
        const interrupted=await readJson(inflight).catch(()=>null);
        if(typeof interrupted?.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(interrupted.id)&&typeof interrupted.expectedCommit==='string'&&/^[0-9a-f]{40}$/.test(interrupted.expectedCommit)){job={id:interrupted.id,expectedCommit:interrupted.expectedCommit,startedAt:Date.now()};await status('failed','interrupted','上次更新已中断，请重新检查更新',{finishedAt:Date.now()});}
        await fsp.unlink(inflight);
      }
      return {status:'idle'};
    }
    await ordinary(path.join(state,'requests'),{directory:true});
    claim=true;
    const pending=await readJson(requestFile,1024);
    try{job=validateRequest(pending);}catch(error){
      if(typeof pending?.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pending.id)&&typeof pending.expectedCommit==='string'&&/^[0-9a-f]{40}$/.test(pending.expectedCommit))job={id:pending.id,expectedCommit:pending.expectedCommit};
      throw error;
    }
    job.startedAt=Date.now();
    await fsp.mkdir(path.join(state,'history'),{recursive:true,mode:0o700});
    await status('running','checking','正在检查更新请求');
    await fsp.rename(requestFile,inflight);
    const claimed=validateRequest(await readJson(inflight,1024));
    if(claimed.id!==job.id||claimed.expectedCommit!==job.expectedCommit)throw new UpdateError('更新请求在读取时发生变化');
    if(await exists(path.join(state,'history',job.id+'.json'))){
      const previous=await readJson(path.join(state,'history',job.id+'.json'));
      if(previous.id!==job.id||previous.expectedCommit!==job.expectedCommit||!['succeeded','failed','rolled_back'].includes(previous.status))throw new UpdateError('重复请求记录不一致');
      job=previous;await writeJson(statusFile,job);return {status:'duplicate'};
    }
    await ordinary(config.target,{directory:true,root:config.checkOwnership});
    if((await fsp.readFile(path.join(config.target,'.boat-web-deployment'),'utf8')).trim()!==MARKER)throw new UpdateError('当前目录不是受管理的无人船平台');
    job.previousCommit=await getRelease(config.target);
    if(job.previousCommit===job.expectedCommit){await status('succeeded','complete','当前已经是选定版本',{targetCommit:job.expectedCommit,finishedAt:Date.now()});return job;}
    work=await fsp.mkdtemp(path.join(state,'work-'));await fsp.chmod(work,0o755);
    const source=path.join(work,'source');await fsp.mkdir(source,{mode:0o755});
    await status('running','downloading','正在下载 GitHub main 分支');
    buildStopped=false;const commit=await a.prepare(source,job);
    if(commit!==job.expectedCommit)throw new UpdateError('GitHub 提交与所选版本不一致，请重新检查');
    job.targetCommit=commit;
    await status('running','building','正在安装依赖并验证新版本');
    const version=await a.build(source,commit);job.targetVersion=version;
    await a.stopBuild();buildStopped=true;
    // Lock the root-owned parent before inspecting any untrusted directory names.
    // Even a later scheduled process for the build account cannot enter this tree.
    await fsp.chmod(work,0o700);await a.freeze(source);
    if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version||''))throw new UpdateError('候选版本号无效');
    candidate=await fsp.mkdtemp(path.join(path.dirname(config.target),'.boat-web-update-stage-'));await fsp.chmod(candidate,0o755);
    const budget={files:0,bytes:0};
    for(const name of ALLOWED){if(await exists(path.join(source,name)))await safeCopyTree(path.join(source,name),path.join(candidate,name),budget);}
    for(const required of ['public','server','server.js','package.json','package-lock.json','server/update-api.js'])await ordinary(path.join(candidate,required),{directory:required==='public'||required==='server'});
    await fsp.writeFile(path.join(candidate,'.boat-web-deployment'),MARKER+'\n',{mode:0o644,flag:'wx'});
    await writeJson(path.join(candidate,'.boat-web-release.json'),{commit,version,installedAt:new Date().toISOString(),repository:REPOSITORY,branch:BRANCH});
    backup=await fsp.mkdtemp(path.join(path.dirname(config.target),path.basename(config.target)+'.update-backup-'));await fsp.chmod(backup,0o700);
    await status('running','restarting','新版本已验证，正在重启服务');
    await saveTransaction();
    await a.service('stop');stopped=true;await saveTransaction();
    await fsp.rename(config.target,path.join(backup,'app'));oldMoved=true;await saveTransaction();
    await fsp.rename(candidate,config.target);candidate=undefined;newMoved=true;await saveTransaction();
    await a.service('start');await a.health(commit);
    await status('succeeded','complete','更新完成，服务已重启',{finishedAt:Date.now()});
    await fsp.unlink(transactionFile);oldMoved=false;newMoved=false;stopped=false;
    return job;
  }catch(error){
    a.log(error);
    if(job?.id){
      if(stopped||oldMoved||newMoved){
        try{await undo();await status('rolled_back','rollback','新版本未通过检查，已恢复更新前的服务',{finishedAt:Date.now()});await fsp.unlink(transactionFile).catch(()=>{});oldMoved=false;newMoved=false;stopped=false;}
        catch(rollbackError){a.log(rollbackError);await status('failed','recovery_required','自动恢复未完成，请联系管理员检查服务',{finishedAt:Date.now()});}
      }else await status('failed','failed',error instanceof UpdateError?error.message:'更新准备失败，原服务保持运行',{finishedAt:Date.now()});
    }else if(claim)await writeJson(statusFile,{status:'idle'});
    return job||{status:'failed'};
  }finally{
    if(job?.id&&['succeeded','failed','rolled_back'].includes(job.status))await writeJson(path.join(state,'history',job.id+'.json'),job,0o600).catch(()=>{});
    if(claim){await fsp.unlink(inflight).catch(()=>{});await fsp.unlink(requestFile).catch(()=>{});}
    if(candidate&&path.dirname(candidate)===path.dirname(config.target)&&path.basename(candidate).startsWith('.boat-web-update-stage-'))await fsp.rm(candidate,{recursive:true,force:true}).catch(()=>{});
    if(!buildStopped){try{await a.stopBuild();buildStopped=true;}catch(error){a.log(error);}}
    if(work&&buildStopped&&path.dirname(work)===state&&path.basename(work).startsWith('work-'))await fsp.rm(work,{recursive:true,force:true}).catch(()=>{});
    await fsp.rm(lock,{recursive:true}).catch(()=>{});
  }
}
if(require.main===module){
  if(process.platform!=='linux'||!process.getuid||process.getuid()!==0)throw Error('The installed updater must run as root on Linux.');
  // This file/config are installed root-owned once; GitHub updates never replace them.
  const configFile='/usr/local/lib/unmanned-boat-web-update/worker-config.json';
  ordinary(configFile,{root:true}).then(()=>readJson(configFile)).then(installed=>{
    for(const key of Object.keys(installed))if(!['node','npm','git','runuser','systemctl','port'].includes(key))throw Error('Invalid installed updater configuration');
    for(const key of ['node','npm','git','runuser','systemctl'])if(!/^\/[A-Za-z0-9_./-]+$/.test(installed[key]||''))throw Error('Invalid updater command path');
    if(!Number.isInteger(installed.port)||installed.port<1||installed.port>65535)throw Error('Invalid updater port');
    return runUpdate(installed);
  }).then(result=>{if(result.status==='failed')process.exitCode=1;}).catch(error=>{console.error('[boat-update]',error.message);process.exitCode=1;});
}
module.exports={runUpdate,validateRequest,safeCopyTree,readJson,command,health,managedAccountsPresent,readinessMatches,REPOSITORY,BRANCH,DEFAULTS};
