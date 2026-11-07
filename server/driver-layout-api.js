/* 平台级驾驶布局：管理员上传与启停，已登录用户读取；状态与部署源码分开保存。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {normalizeCloudLayout}=require('../public/utils/driverLayout');
const PREFIX='/api/driver-layout',MAX_BYTES=32768;
const fault=(status,message)=>Object.assign(Error(message),{status});
function resolveDriverLayoutFile(env=process.env,file){
  let target=file!==undefined?file:env.BOAT_DRIVER_LAYOUT_FILE;
  if(!target&&env.BOAT_UPDATE_ENABLED==='1')target=path.join(env.BOAT_UPDATE_STATE_DIR||'/var/lib/unmanned-boat-web-update','requests','driver-layout.json');
  if(!target&&env.STATE_DIRECTORY)target=path.join(env.STATE_DIRECTORY.split(path.delimiter)[0],'driver-layout.json');
  if(!target){
    const directory=process.platform==='win32'?(env.APPDATA||path.join(os.homedir(),'AppData','Roaming')):(env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'));
    target=path.join(directory,'unmanned-boat-web','driver-layout.json');
  }
  if(typeof target!=='string'||!path.isAbsolute(target)||target.includes('\0'))throw Error('Invalid driver layout state file');
  return path.normalize(target);
}
function readJson(req,timeoutMs){
  if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))return Promise.reject(fault(415,'请使用 JSON 布局设置'));
  if(Number(req.headers['content-length'])>MAX_BYTES)return Promise.reject(fault(413,'布局设置过大'));
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0,finished=false;
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);for(const [event,handler]of [['data',data],['end',end],['error',aborted],['aborted',aborted]])req.removeListener(event,handler);error?reject(error):resolve(value);};
    const data=chunk=>{size+=chunk.length;if(size>MAX_BYTES)finish(fault(413,'布局设置过大'));else chunks.push(chunk);};
    const end=()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(_){finish(fault(400,'布局请求格式不正确'));}};
    const aborted=()=>finish(fault(400,'布局请求已取消'));
    const timer=setTimeout(()=>finish(fault(408,'布局请求超时')),timeoutMs);timer.unref?.();
    req.on('data',data);req.once('end',end);req.once('error',aborted);req.once('aborted',aborted);
  });
}
function createDriverLayoutApi({env=process.env,accounts,file,bodyTimeoutMs=5000,now=Date.now}={}){
  let configFile='',loadError='',closed=false,pending=null;
  let state={version:1,revision:0,enabled:false,layout:null,updatedAt:null};
  try{
    configFile=resolveDriverLayoutFile(env,file);
    try{
      const stat=fs.lstatSync(configFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error('Invalid file');
      const value=JSON.parse(fs.readFileSync(configFile,'utf8')),layout=value.layout===null?null:normalizeCloudLayout(value.layout);
      if(value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.enabled!=='boolean'||(value.layout!==null&&!layout)||(value.enabled&&!layout)||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))throw Error('Invalid state');
      state={version:1,revision:value.revision,enabled:value.enabled,layout,updatedAt:value.updatedAt};
    }catch(error){if(error.code!=='ENOENT')loadError='云端布局文件无法读取，请管理员重新上传布局';}
  }catch(_){loadError='云端布局存储路径无效，请设置绝对路径 BOAT_DRIVER_LAYOUT_FILE';}
  const snapshot=()=>({...state,persistent:!!configFile,error:loadError||null});
  const active=session=>!closed&&accounts?.isActive(session)&&session.value.role==='admin';
  const json=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  async function save(next,session,res){
    if(!configFile)throw fault(503,'云端布局存储路径不可用');
    const temporary=path.join(path.dirname(configFile),'.'+path.basename(configFile)+'.'+crypto.randomBytes(12).toString('hex')+'.tmp');let handle;
    try{
      await fs.promises.mkdir(path.dirname(configFile),{recursive:true,mode:0o700});
      handle=await fs.promises.open(temporary,'wx',0o640);await handle.chmod(0o640);await handle.writeFile(JSON.stringify(next)+'\n','utf8');await handle.sync();await handle.close();handle=null;
      // 身份与连接最后再核对，异步写入期间登出或降权不会发布配置。
      if(!active(session)||res.destroyed)throw fault(401,'登录会话已失效，请重新登录');
      fs.renameSync(temporary,configFile);state=next;loadError='';
    }finally{if(handle)await handle.close().catch(()=>{});await fs.promises.unlink(temporary).catch(()=>{});}
  }
  return {snapshot,close(){closed=true;return pending?.catch(()=>{});},async handle(req,res,url){
    if(url.pathname!==PREFIX&&!url.pathname.startsWith(PREFIX+'/'))return false;
    if(url.pathname!==PREFIX){json(res,404,{error:'未知的布局接口'});return true;}
    if(!accounts?.enabled||closed){json(res,503,{error:'云端统一布局需要启用平台账户登录'});return true;}
    const session=accounts.sessionFor(req);
    if(!session){json(res,401,{error:'请先登录平台'});return true;}
    if(req.method==='GET'){json(res,200,snapshot());return true;}
    if(!['PUT','PATCH'].includes(req.method)){res.setHeader('Allow','GET, PUT, PATCH');json(res,405,{error:'不支持的布局操作'});return true;}
    if(session.value.role!=='admin'){json(res,403,{error:'只有管理员可以上传或启停统一驾驶布局'});return true;}
    if(!accounts.sameOrigin(req)){json(res,403,{error:'请从本站修改驾驶布局'});return true;}
    let input;
    try{input=await readJson(req,bodyTimeoutMs);}catch(error){res.setHeader('Connection','close');json(res,error.status||400,{error:error.message});req.resume();return true;}
    if(!active(session)){json(res,401,{error:'登录会话已失效，请重新登录'});return true;}
    const keys=req.method==='PUT'?['revision','layout']:['revision','enabled'];
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key))||!Number.isSafeInteger(input.revision)||input.revision<0){json(res,400,{error:'布局请求字段无效'});return true;}
    if(pending){json(res,409,{error:'另一项布局设置正在保存，请稍后重试'});return true;}
    if(input.revision!==state.revision){json(res,409,{error:'云端布局已被更新，请先刷新云端再操作'});return true;}
    let next;
    if(req.method==='PUT'){
      const layout=normalizeCloudLayout(input.layout);
      if(!layout){json(res,400,{error:'布局内容无效：仅支持模块位置、大小、透明度及显示偏好'});return true;}
      if(state.enabled){json(res,409,{error:'请先停用统一布局，再调整并上传新布局'});return true;}
      next={...state,layout};
    }else{
      if(typeof input.enabled!=='boolean'){json(res,400,{error:'启用状态必须是布尔值'});return true;}
      if(input.enabled&&!state.layout){json(res,409,{error:'请先上传一套驾驶布局'});return true;}
      next={...state,enabled:input.enabled};
    }
    next.revision++;next.updatedAt=new Date(now()).toISOString();
    pending=save(next,session,res);
    try{await pending;json(res,200,snapshot());}
    catch(error){json(res,error.status||503,{error:error.status?error.message:'布局保存失败，当前配置未更改，请检查状态目录写入权限'});}
    finally{pending=null;}
    return true;
  }};
}
module.exports={createDriverLayoutApi,resolveDriverLayoutFile,PREFIX};
