/* MQTT 凭据只由此受信任组件修改；网页进程通过受组权限保护的 Unix socket 请求。 */
'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {spawn}=require('node:child_process');
const USER=/^[A-Za-z0-9_-]{1,64}$/,REVISION=/^[a-f0-9]{64}$/;
const DEFAULTS=Object.freeze({configDir:'/etc/unmanned-boat-web',brokerUnit:'/etc/systemd/system/unmanned-boat-mqtt.service',mosquittoPasswd:'/usr/bin/mosquitto_passwd',systemctl:'/usr/bin/systemctl',checkOwnership:true});
const FILES=['passwd','acl','access.txt'],JOURNAL='.mqtt-device-transaction.json',LOCK='.mqtt-device-admin.lock';
const fail=(message,status=503)=>Object.assign(Error(message),{status});
function validateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['username','password','revision'].includes(k))||typeof input.username!=='string'||!USER.test(input.username)||typeof input.revision!=='string'||!REVISION.test(input.revision))throw fail('设备账号或配置版本无效，请重新读取设备列表',400);
  if(Object.hasOwn(input,'password')&&(typeof input.password!=='string'||input.password.length<8||input.password.length>64||! /^[!-9;-~]+$/.test(input.password)))throw fail('密码需为 8～64 位可打印 ASCII 字符，不能包含冒号或空白',400);
  return input;
}
async function ordinary(file,{directory=false,ownership=true,max=262144}={}){
  const s=await fsp.lstat(file);
  if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||s.nlink!==1&&!directory||!directory&&s.size>max||ownership&&(s.uid!==0||(s.mode&0o022)!==0))throw fail('MQTT 管理文件或目录权限不安全，操作已拒绝');
  return s;
}
async function parents(directory,ownership){
  for(let current=path.resolve(directory);;current=path.dirname(current)){
    await ordinary(current,{directory:true,ownership});if(path.dirname(current)===current)break;
  }
}
async function readOrdinary(file,ownership,max=262144){
  const before=await ordinary(file,{ownership,max}),handle=await fsp.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const opened=await handle.stat();if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)throw fail('MQTT 配置在读取时发生变化，请重试');return {text:await handle.readFile('utf8'),stat:before};}finally{await handle.close();}
}
function environment(text){
  const result={};
  for(const line of text.split(/\r?\n/)){
    if(!line||line.startsWith('#'))continue;
    const m=line.match(/^([A-Z_]+)=(.*)$/);if(!m||Object.hasOwn(result,m[1]))throw fail('MQTT 环境配置格式无效');result[m[1]]=m[2];
  }
  return result;
}
function parseConfigurations(passwd,acl,env){
  const bridge=env.BOAT_MQTT_USERNAME,prefix=env.BOAT_MQTT_TOPIC_PREFIX||'boats';
  if(typeof bridge!=='string'||!USER.test(bridge)||typeof prefix!=='string'||!USER.test(prefix))throw fail('受管理 MQTT 桥接账号配置无效');
  const passwordUsers=new Map();
  for(const line of passwd.split(/\r?\n/)){
    if(!line.trim())continue;const m=line.match(/^([A-Za-z0-9_-]{1,64}):(\$[67]\$[^\s:]+)$/);
    if(!m||passwordUsers.has(m[1]))throw fail('MQTT 密码文件格式无效或账号重复');passwordUsers.set(m[1],m[2]);
  }
  if(!passwordUsers.has(bridge))throw fail('MQTT 桥接账号缺失');
  const blocks=acl.split(/(?=^user[ \t]+)/m),seen=new Set(),devices=[];
  for(let index=0;index<blocks.length;index++){
    const lines=blocks[index].split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));
    if(!lines.length)continue;
    const match=lines[0].match(/^user[ \t]+([A-Za-z0-9_-]{1,64})$/);
    if(!match||seen.has(match[1])||!passwordUsers.has(match[1]))throw fail('MQTT 权限配置含未知或重复账号');
    const username=match[1];seen.add(username);
    if(username===bridge)continue;
    const telemetry=lines.slice(1).map(line=>line.match(new RegExp('^topic[ \\t]+write[ \\t]+'+prefix+'/([A-Za-z0-9_-]{1,64})/telemetry$'))).filter(Boolean);
    if(!telemetry.length){
      // 无关账号可以保留，但不能被本功能管理。
      if(lines.slice(1).some(line=>!/^topic[ \t]+(?:read|write|readwrite|deny)[ \t]+\S+$/.test(line)))throw fail('MQTT 权限文件含不支持的规则');
      continue;
    }
    if(telemetry.length!==1)throw fail('设备主题权限不明确，操作已拒绝');
    const deviceId=telemetry[0][1],base=prefix+'/'+deviceId+'/',allowed=new Set([
      'topic write '+base+'telemetry','topic write '+base+'status','topic read '+base+'parameter-command',
      'topic write '+base+'parameter-response','topic write '+base+'parameter-capability'
    ]),rules=lines.slice(1).map(line=>line.replace(/[ \t]+/g,' '));
    if(!rules.includes('topic write '+base+'status')||rules.some(line=>!allowed.has(line))||new Set(rules).size!==rules.length||devices.some(item=>item.deviceId===deviceId))throw fail('设备权限超出自身主题或设备 ID 重复，操作已拒绝');
    devices.push({deviceId,username,blockIndex:index});
  }
  if(!seen.has(bridge)||!devices.length||devices.length>64)throw fail('受管理设备或桥接权限缺失，最多支持 64 个设备');
  return {devices,blocks,passwordUsers};
}
function revisionFor(passwd,acl){return crypto.createHash('sha256').update(passwd).update('\0').update(acl).digest('hex');}
function publicSnapshot(config){return {devices:config.devices.map(({deviceId,username})=>({deviceId,username})),revision:config.revision};}
async function execute(file,args,{timeout=20000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{stdio:['ignore','ignore','ignore'],shell:false,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8'}});
    const timer=setTimeout(()=>{child.kill('SIGKILL');},timeout);timer.unref();
    child.once('error',()=>{clearTimeout(timer);reject(fail('MQTT 管理工具无法启动'));});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(fail('MQTT 管理工具执行失败'));});
  });
}
async function syncDirectory(directory){if(process.platform==='win32')return;const handle=await fsp.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
async function atomicWrite(file,text,stat,ownership){
  const temporary=path.join(path.dirname(file),'.mqtt-write-'+crypto.randomUUID());let handle;
  try{
    handle=await fsp.open(temporary,'wx',0o600);await handle.writeFile(text,'utf8');
    if(ownership)await handle.chown(stat.uid,stat.gid);
    await handle.chmod(stat.mode&0o777);await handle.sync();await handle.close();handle=null;
    await fsp.rename(temporary,file);await syncDirectory(path.dirname(file));
  }finally{await handle?.close();await fsp.unlink(temporary).catch(()=>{});}
}
function sanitizeAccess(text,deviceId,username){
  // 接口永不展示旧/新密码；原部署资料中旧凭据不再作为有效配置示例。
  const lines=text.split(/\r?\n/),next=[];
  for(const line of lines){
    if(/^Device (?:ID \/ username|ID|username|password):/.test(line)||/^#define BOAT_MQTT_(?:DEVICE_ID|USERNAME|PASSWORD)\b/.test(line)||/^MQTT device credentials were updated/.test(line))continue;
    next.push(line);
  }
  return next.join('\n').trimEnd()+'\n\nMQTT device credentials were updated from the administrator settings.\nDevice ID: '+deviceId+'\nDevice username: '+username+'\nDevice password: (not stored here; use the password set by the administrator)\nDevice topic ID is unchanged; update the firmware credentials and reconnect.\n';
}
function createMqttDeviceManager(options={}){
  const config={...DEFAULTS,...options},root=path.resolve(config.configDir),run=config.execute||execute;let busy=false;
  const service=config.service||(async()=>{await run(config.systemctl,['restart','unmanned-boat-mqtt.service'],{timeout:10000});await run(config.systemctl,['is-active','--quiet','unmanned-boat-mqtt.service'],{timeout:3000});});
  const file=name=>path.join(root,name);
  async function verify(){
    await parents(root,config.checkOwnership);
    const marker=await readOrdinary(file('.boat-cloud-deployment'),config.checkOwnership,128);
    if(marker.text.trim()!=='unmanned-boat-cloud-v1')throw fail('当前 MQTT 配置不属于受管理部署');
    const unit=await readOrdinary(config.brokerUnit,config.checkOwnership,16384);
    if(!unit.text.split(/\r?\n/).includes('# Owned by unmanned-boat-cloud-v1'))throw fail('MQTT 服务不是受管理服务');
    const broker=await readOrdinary(file('mosquitto.conf'),config.checkOwnership,16384),lines=broker.text.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
    for(const [key,value]of [['password_file',file('passwd')],['acl_file',file('acl')],['allow_anonymous','false']]){
      const directives=lines.filter(line=>new RegExp('^'+key+'\\s').test(line));
      if(directives.length!==1||directives[0]!==key+' '+value)throw fail('MQTT 认证配置与受管理文件不一致');
    }
    if(lines.some(line=>/^(?:include_dir|plugin|auth_plugin|global_plugin|auth_opt_|plugin_opt_)/.test(line)))throw fail('当前 MQTT 认证扩展不支持网页修改');
  }
  async function snapshot(){
    const records={};for(const name of ['runtime.env',...FILES])records[name]=await readOrdinary(file(name),config.checkOwnership);
    if(config.checkOwnership&&(records['runtime.env'].stat.mode&0o077||records['access.txt'].stat.mode&0o077))throw fail('MQTT 明文连接资料必须仅允许 root 读取');
    const parsed=parseConfigurations(records.passwd.text,records.acl.text,environment(records['runtime.env'].text));
    return {...parsed,records,revision:revisionFor(records.passwd.text,records.acl.text)};
  }
  async function recover(){
    let record;try{record=await readOrdinary(file(JOURNAL),config.checkOwnership,1048576);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(process.platform!=='win32'&&(record.stat.mode&0o077)!==0)throw fail('MQTT 恢复记录权限异常，需要服务器管理员检查');
    let value;try{value=JSON.parse(record.text);}catch(_){throw fail('MQTT 恢复记录无效，需要服务器管理员检查');}
    if(value?.version!==1||Object.keys(value).sort().join(',')!=='files,version'||!value.files||Object.keys(value.files).sort().join(',')!==FILES.slice().sort().join(','))throw fail('MQTT 恢复记录无效，需要服务器管理员检查');
    for(const name of FILES){
      const saved=value.files[name];
      if(!saved||typeof saved.text!=='string'||Buffer.byteLength(saved.text)>262144||!Number.isInteger(saved.mode)||(saved.mode&0o022)!==0||saved.mode<0||saved.mode>0o777||!Number.isInteger(saved.gid)||saved.gid<0)throw fail('MQTT 恢复记录无效，需要服务器管理员检查');
      await ordinary(file(name),{ownership:config.checkOwnership});
    }
    for(const name of FILES){const saved=value.files[name];await atomicWrite(file(name),saved.text,{uid:0,gid:saved.gid,mode:saved.mode},config.checkOwnership);}
    await service();await fsp.unlink(file(JOURNAL));await syncDirectory(root);
  }
  async function acquire(){
    try{await fsp.mkdir(file(LOCK),{mode:0o700});}
    catch(error){
      if(error.code!=='EEXIST')throw error;await ordinary(file(LOCK),{directory:true,ownership:config.checkOwnership});
      let owner;try{owner=JSON.parse((await readOrdinary(path.join(file(LOCK),'owner.json'),config.checkOwnership,256)).text);}catch(_){throw fail('MQTT 管理锁异常，需要服务器管理员检查');}
      if(!Number.isInteger(owner.pid)||owner.pid<=0)throw fail('MQTT 管理锁异常，需要服务器管理员检查');
      try{process.kill(owner.pid,0);throw fail('另一个 MQTT 管理操作正在进行，请稍后读取',409);}catch(error){if(error.code!=='ESRCH')throw error;}
      await fsp.unlink(path.join(file(LOCK),'owner.json'));await fsp.rmdir(file(LOCK));await fsp.mkdir(file(LOCK),{mode:0o700});
    }
    await fsp.writeFile(path.join(file(LOCK),'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600,flag:'wx'});
  }
  async function cleanInterruptedPasswordFiles(){
    // SIGKILL/断电可能留下尚未哈希的临时文件，只清理本组件 UUID 命名的私有常规文件。
    for(const name of await fsp.readdir(root)){
      if(!/^\.mqtt-password-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name))continue;
      const stat=await ordinary(file(name),{ownership:config.checkOwnership,max:1024});
      if(process.platform!=='win32'&&(stat.mode&0o077)!==0)throw fail('MQTT 临时凭据文件权限异常，需要服务器管理员检查');
      await fsp.unlink(file(name));
    }
  }
  async function serialized(action){
    if(busy)throw fail('MQTT 设备配置正在修改，请稍后重新读取',409);busy=true;let locked=false;
    try{await verify();await acquire();locked=true;await cleanInterruptedPasswordFiles();await recover();return await action();}
    catch(error){if(error.status)throw error;throw fail('MQTT 设备配置不可用，请检查管理组件和文件权限');}
    finally{if(locked){await fsp.unlink(path.join(file(LOCK),'owner.json')).catch(()=>{});await fsp.rmdir(file(LOCK)).catch(()=>{});}busy=false;}
  }
  async function passwordHash(username,password){
    const temporary=file('.mqtt-password-'+crypto.randomUUID());
    try{
      await fsp.writeFile(temporary,username+':'+password+'\n',{mode:0o600,flag:'wx'});
      await run(config.mosquittoPasswd,['-U',temporary],{timeout:5000});
      const value=(await readOrdinary(temporary,config.checkOwnership,1024)).text.trim();
      const hash=value.slice(username.length+1);
      if(!value.startsWith(username+':')||!/^\$[67]\$[^\s:]+$/.test(hash))throw fail('MQTT 密码哈希生成失败');
      return hash;
    }finally{await fsp.unlink(temporary).catch(()=>{});}
  }
  return {
    list:()=>serialized(async()=>publicSnapshot(await snapshot())),
    update:(deviceId,input)=>{
      if(typeof deviceId!=='string'||!USER.test(deviceId))return Promise.reject(fail('设备 ID 无效',400));
      try{validateInput(input);}catch(error){return Promise.reject(error);}
      return serialized(async()=>{
        const before=await snapshot(),device=before.devices.find(item=>item.deviceId===deviceId);
        if(!device)throw fail('设备不存在或不属于受管理设备',404);
        if(input.revision!==before.revision)throw fail('设备账号配置已变化，请重新读取后修改',409);
        if(input.username!==device.username&&before.passwordUsers.has(input.username))throw fail('MQTT 账号已存在，不能覆盖其他设备或桥接账号',409);
        if(input.username===device.username&&!Object.hasOwn(input,'password'))return {ok:true,...publicSnapshot(before),requiresReconnect:false};
        const hash=Object.hasOwn(input,'password')?await passwordHash(input.username,input.password):before.passwordUsers.get(device.username);
        const check=await snapshot();if(check.revision!==before.revision||check.records['runtime.env'].text!==before.records['runtime.env'].text)throw fail('MQTT 配置在保存前发生变化，请重新读取',409);
        const nextPasswd=before.records.passwd.text.split(/\r?\n/).map(line=>line.startsWith(device.username+':')?input.username+':'+hash:line).join('\n');
        const blocks=before.blocks.slice();blocks[device.blockIndex]=blocks[device.blockIndex].replace(/^user[ \t]+[^\r\n]+/m,'user '+input.username);
        const texts={passwd:nextPasswd,acl:blocks.join(''),'access.txt':sanitizeAccess(before.records['access.txt'].text,deviceId,input.username)};
        const transaction={version:1,files:Object.fromEntries(FILES.map(name=>[name,{text:before.records[name].text,mode:process.platform==='win32'?(name==='access.txt'?0o600:0o640):before.records[name].stat.mode&0o777,gid:before.records[name].stat.gid}]))};
        const handle=await fsp.open(file(JOURNAL),'wx',0o600);try{await handle.writeFile(JSON.stringify(transaction)+'\n','utf8');await handle.sync();}finally{await handle.close();}await syncDirectory(root);
        try{
          for(const name of FILES)await atomicWrite(file(name),texts[name],before.records[name].stat,config.checkOwnership);
          await service();
          // 只有配置重新读取成功后才提交，任何中断均会留下恢复记录供下次启动回滚。
          const after=await snapshot();await fsp.unlink(file(JOURNAL));await syncDirectory(root);
          return {ok:true,...publicSnapshot(after),requiresReconnect:true};
        }catch(_){
          try{await recover();}catch(_){throw fail('MQTT 配置修改失败且恢复尚未完成；请暂停设备重连并联系服务器管理员检查管理服务');}
          throw fail('MQTT 配置修改失败，已恢复原账号；请重新读取后再试');
        }
      });
    }
  };
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let finished=false,size=0;const chunks=[];
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',bad);req.removeListener('aborted',bad);error?reject(error):resolve(value);};
    const bad=()=>finish(fail('MQTT 请求中断',400)),data=chunk=>{size+=chunk.length;if(size>2048){req.resume();return finish(fail('MQTT 请求过大',413));}chunks.push(chunk);};
    const end=()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(_){finish(fail('MQTT 请求格式不正确',400));}};
    const timer=setTimeout(()=>{req.resume();finish(fail('MQTT 请求超时',408));},5000);timer.unref();
    req.on('data',data);req.once('end',end);req.once('error',bad);req.once('aborted',bad);
  });
}
function createMqttDeviceWorker(options={}){
  const manager=options.manager||createMqttDeviceManager(options);
  const server=http.createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try{
      if(req.url==='/devices'&&req.method==='GET')return json(200,await manager.list());
      const match=req.url?.match(/^\/devices\/([A-Za-z0-9_-]{1,64})$/);
      if(match&&req.method==='PUT'){
        if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw fail('MQTT 请求需要 JSON 格式',415);
        if(Number(req.headers['content-length'])>2048)throw fail('MQTT 请求过大',413);
        const input=await readBody(req);if(req.aborted||res.destroyed)throw fail('请求已中断，未提交修改',400);
        return json(200,await manager.update(match[1],input));
      }
      json(req.url==='/devices'||match?405:404,{error:'MQTT 管理接口或方法不支持'});
    }catch(error){req.resume();if(!res.destroyed)json(error.status||503,{error:error.status?error.message:'MQTT 管理组件不可用'});}
  });
  server.requestTimeout=10000;server.headersTimeout=6000;server.maxRequestsPerSocket=20;server.maxConnections=16;
  return server;
}
if(require.main===module){
  (async()=>{
    if(process.getuid?.()!==0||process.argv.length!==2||process.env.LISTEN_PID!==String(process.pid)||process.env.LISTEN_FDS!=='1')throw Error('Trusted systemd socket activation is required');
    const helper=path.dirname(__filename);await parents(helper,true);
    const configFile=path.join(helper,'mqtt-device-worker-config.json'),loaded=JSON.parse((await readOrdinary(configFile,true,2048)).text);
    if(!loaded||Array.isArray(loaded)||Object.keys(loaded).some(key=>!['mosquittoPasswd','systemctl'].includes(key)))throw Error('Invalid trusted worker configuration');
    for(const value of Object.values({...{mosquittoPasswd:DEFAULTS.mosquittoPasswd,systemctl:DEFAULTS.systemctl},...loaded})){
      if(typeof value!=='string'||!/^\/[A-Za-z0-9_./-]+$/.test(value))throw Error('Invalid trusted executable');
      await parents(path.dirname(value),true);const executable=await ordinary(value,{ownership:true,max:67108864});if((executable.mode&0o111)===0)throw Error('Trusted executable is not executable');
    }
    const server=createMqttDeviceWorker(loaded);server.listen({fd:3});
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
    server.on('error',()=>{console.error('MQTT administrator worker socket failed');process.exitCode=1;});
  })().catch(()=>{console.error('MQTT administrator worker startup failed');process.exitCode=1;});
}
module.exports={createMqttDeviceManager,createMqttDeviceWorker,validateInput,parseConfigurations,sanitizeAccess};
