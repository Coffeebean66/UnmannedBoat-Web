/* 高德 JS API 配置：公开浏览器配置，管理员可将设置原子保存到源码目录外。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');

// JS API 的 Key 与 securityJsCode 均为 32 位十六进制字符串。
// 它们用于官方浏览器 SDK，不能替代平台账户密码；应在高德控制台限制可用域名。
const CREDENTIAL=/^[a-fA-F0-9]{32}$/;
const VECTOR_HOSTS=['https://vdata.amap.com',...Array.from({length:4},(_,i)=>'https://vdata0'+(i+1)+'.amap.com')];
const TILE_HOSTS=['webrd','webst'].flatMap(prefix=>Array.from({length:4},(_,i)=>'https://'+prefix+'0'+(i+1)+'.is.autonavi.com'));
const MAP_IMAGES=['https://webapi.amap.com','https://a.amap.com',...VECTOR_HOSTS,...TILE_HOSTS].join(' ');

// 官方在线 SDK、矢量数据与瓦片域名逐项放行；不开放通用域名或动态代码执行权限。
// JS API 2.0 使用 Blob Worker 绘制地图，因此单独声明 worker-src。
const MAP_CONTENT_SECURITY_POLICY=[
  "default-src 'self'",
  "script-src 'self' https://webapi.amap.com https://a.amap.com",
  "style-src 'self' 'unsafe-inline' https://webapi.amap.com",
  // 未配置高德时前端保留 OSM 底图回退，仅允许其明确的瓦片域名。
  "img-src 'self' data: blob: https://tile.openstreetmap.org "+MAP_IMAGES,
  "connect-src 'self' https://webapi.amap.com https://restapi.amap.com https://a.amap.com "+VECTOR_HOSTS.join(' ')+' '+TILE_HOSTS.join(' '),
  "font-src 'self' https://webapi.amap.com",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'"
].join('; ');

function readMapConfig(env=process.env){
  const key=String(env.BOAT_AMAP_KEY||'').trim(),securityJsCode=String(env.BOAT_AMAP_SECURITY_CODE||'').trim();
  const missing=[];
  if(!CREDENTIAL.test(key))missing.push('BOAT_AMAP_KEY');
  if(!CREDENTIAL.test(securityJsCode))missing.push('BOAT_AMAP_SECURITY_CODE');
  const configured=missing.length===0;
  return {provider:'amap',version:'2.0',enabled:configured,configured,
    key:configured?key:'',securityJsCode:configured?securityJsCode:'',
    reason:configured?'':'高德地图尚未配置：请在服务器设置 '+missing.join('、')+'（高德 Web 端 JS API 的 32 位 Key / 安全密钥）'};
}

function resolveMapConfigFile(env=process.env,file){
  let target=file||env.BOAT_MAP_CONFIG_FILE;
  if(!target&&env.BOAT_UPDATE_ENABLED==='1')target=path.join(env.BOAT_UPDATE_STATE_DIR||'/var/lib/unmanned-boat-web-update','requests','map-settings.json');
  if(!target&&env.STATE_DIRECTORY)target=path.join(String(env.STATE_DIRECTORY).split(path.delimiter)[0],'map-settings.json');
  if(!target){
    const directory=process.platform==='win32'?(env.APPDATA||path.join(os.homedir(),'AppData','Roaming')):(env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'));
    target=path.join(directory,'unmanned-boat-web','map-settings.json');
  }
  if(typeof target!=='string'||!path.isAbsolute(target))throw Error('地图配置文件必须使用绝对路径');
  return path.normalize(target);
}

function normalizeSettings(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||
    Object.keys(input).some(key=>!['key','securityJsCode'].includes(key))||typeof input.key!=='string'||typeof input.securityJsCode!=='string')return null;
  const key=input.key.trim(),securityJsCode=input.securityJsCode.trim();
  if((key===''&&securityJsCode==='')||(CREDENTIAL.test(key)&&CREDENTIAL.test(securityJsCode)))return {key,securityJsCode};
  return null;
}

function readJsonBody(req,timeoutMs){
  if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))return Promise.reject({status:415});
  if(Number(req.headers['content-length'])>2048)return Promise.reject({status:413});
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0,finished=false;
    const cleanup=()=>{clearTimeout(timer);req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('error',onError);req.removeListener('aborted',onAborted);};
    const finish=(error,value)=>{if(finished)return;finished=true;cleanup();if(error)reject(error);else resolve(value);};
    const onData=chunk=>{size+=chunk.length;if(size>2048)return finish({status:413});chunks.push(chunk);};
    const onEnd=()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(_){finish({status:400});}};
    const onError=()=>finish({status:400}),onAborted=()=>finish({status:400});
    const timer=setTimeout(()=>finish({status:408}),timeoutMs);timer.unref?.();
    req.on('data',onData);req.once('end',onEnd);req.once('error',onError);req.once('aborted',onAborted);
  });
}

function createMapConfigApi({env=process.env,accounts,file,bodyTimeoutMs=5000}={}){
  let settings=null,loadError='',configFile='',closed=false;
  try{
    configFile=resolveMapConfigFile(env,file);
    try{
      const stat=fs.lstatSync(configFile);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2048)throw Error('Invalid settings file');
      const stored=JSON.parse(fs.readFileSync(configFile,'utf8'));
      if(!stored||stored.version!==1||Object.keys(stored).some(key=>!['version','key','securityJsCode'].includes(key)))throw Error('Invalid settings version');
      settings=normalizeSettings({key:stored.key,securityJsCode:stored.securityJsCode});
      if(!settings)throw Error('Invalid settings values');
    }catch(error){if(error.code!=='ENOENT')loadError='地图配置文件读取失败，请管理员重新保存配置';}
  }catch(_){loadError='地图配置文件路径无效，请管理员设置绝对路径 BOAT_MAP_CONFIG_FILE';}
  function config(){
    if(loadError)return {...readMapConfig({}),reason:loadError};
    if(!settings)return readMapConfig(env);
    const value=readMapConfig({BOAT_AMAP_KEY:settings.key,BOAT_AMAP_SECURITY_CODE:settings.securityJsCode});
    if(!value.configured)value.reason='高德地图已停用，当前使用 OpenStreetMap';
    return value;
  }
  const snapshot=()=>({...config(),source:settings||loadError?'saved':config().configured?'environment':'none'});
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const active=session=>!closed&&accounts.isActive(session)&&session.value.role==='admin';
  async function save(input,session,res){
    if(!configFile)throw {status:503,message:'地图配置存储路径不可用'};
    const directory=path.dirname(configFile),temporary=path.join(directory,'.'+path.basename(configFile)+'.'+crypto.randomBytes(12).toString('hex')+'.tmp');
    let handle;
    try{
      await fs.promises.mkdir(directory,{recursive:true,mode:0o700});
      // requests 目录的 setgid 保留更新组；0640 允许 DynamicUser 重启后通过该组读取。
      handle=await fs.promises.open(temporary,'wx',0o640);
      await handle.chmod(0o640);await handle.writeFile(JSON.stringify({version:1,...input})+'\n','utf8');await handle.sync();await handle.close();handle=null;
      // 最终授权检查与 rename 同步完成，登出/会话失效不能在异步写入途中提交配置。
      if(!active(session)||res.destroyed)throw {status:401,message:'登录会话已失效，请重新登录'};
      fs.renameSync(temporary,configFile);
      settings=input;loadError='';
    }finally{
      if(handle)await handle.close().catch(()=>{});
      await fs.promises.unlink(temporary).catch(()=>{});
    }
  }
  return {close(){closed=true;},async handle(req,res,url){
    if(!url.pathname.startsWith('/api/map/'))return false;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    if(url.pathname==='/api/map/config'){
      if(req.method!=='GET'&&req.method!=='HEAD'){
        res.setHeader('Allow','GET, HEAD');json(res,405,{error:'Method not allowed'});return true;
      }
      res.statusCode=200;res.end(req.method==='HEAD'?undefined:JSON.stringify(config()));return true;
    }
    if(url.pathname!=='/api/map/settings'){json(res,404,{error:'Unknown map API'});return true;}
    if(!accounts?.enabled||closed){json(res,503,{error:'请先启用平台账户登录，再由管理员设置地图'});return true;}
    const session=accounts.sessionFor(req);
    if(!session){json(res,401,{error:'请先登录管理员账户'});return true;}
    if(session.value.role!=='admin'){json(res,403,{error:'仅管理员可以读取或修改地图设置'});return true;}
    if(req.method==='GET'){json(res,200,snapshot());return true;}
    if(req.method!=='PUT'){res.setHeader('Allow','GET, PUT');json(res,405,{error:'Method not allowed'});return true;}
    if(!accounts.sameOrigin(req)){json(res,403,{error:'请从本站发起地图设置操作'});return true;}
    let input;
    try{input=normalizeSettings(await readJsonBody(req,bodyTimeoutMs));}
    catch(error){
      if(!res.destroyed){res.setHeader('Connection','close');json(res,error.status||400,{error:error.status===408?'地图设置请求超时':'地图设置请求格式不正确'});req.resume();}
      return true;
    }
    if(!input){json(res,400,{error:'Key 和安全密钥必须同时为 32 位十六进制，或同时留空停用高德；不允许额外字段'});return true;}
    if(!active(session)){json(res,401,{error:'登录会话已失效，请重新登录'});return true;}
    try{await save(input,session,res);if(!res.destroyed)json(res,200,snapshot());}
    catch(error){if(!res.destroyed)json(res,error.status||503,{error:error.message&&error.status?error.message:'地图设置保存失败，当前配置未更改，请检查配置目录写入权限'});}
    return true;
  }};
}

module.exports={createMapConfigApi,readMapConfig,resolveMapConfigFile,MAP_CONTENT_SECURITY_POLICY};
