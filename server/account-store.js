/* 账户库与源码分开保存；密码只保存加盐的 scrypt 派生值，更新网页不会覆盖。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const MAX_USERS=64,MAX_FILE_BYTES=65536,USERNAME=/^[A-Za-z0-9_.-]{1,64}$/,ID=/^[a-f0-9]{32}$/;
const digest=value=>crypto.createHash('sha256').update(value).digest();
const failure=(status,message)=>Object.assign(Error(message),{status});
const exact=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).length===keys.length&&Object.keys(object).every(key=>keys.includes(key));

function resolveAccountFile(env=process.env,file){
  let target=file||env.BOAT_ACCOUNTS_FILE;
  const state=env.STATE_DIRECTORY?path.join(String(env.STATE_DIRECTORY).split(path.delimiter)[0],'accounts.json'):'';
  const update=env.BOAT_UPDATE_ENABLED==='1'?path.join(env.BOAT_UPDATE_STATE_DIR||'/var/lib/unmanned-boat-web-update','requests','accounts.json'):'';
  const present=value=>{if(!value)return false;try{fs.lstatSync(value);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  // 首次安装更新组件会新增 UPDATE 环境；继续读原库，不能退回环境中的初始密码。
  // 老部署只有 requests；后来补 StateDirectory 时，同样继续复用已有库。
  if(!target)target=present(state)?state:present(update)?update:state||update;
  if(!target){
    const base=process.platform==='win32'?(env.APPDATA||path.join(os.homedir(),'AppData','Roaming')):(env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'));
    target=path.join(base,'unmanned-boat-web','accounts.json');
  }
  if(typeof target!=='string'||!path.isAbsolute(target))throw Error('账户存储路径必须使用绝对路径 BOAT_ACCOUNTS_FILE');
  return path.normalize(target);
}

function validateStore(value){
  if(!exact(value,['version','revision','users'])||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||!Array.isArray(value.users)||value.users.length<1||value.users.length>MAX_USERS)throw Error('Invalid account store');
  const names=new Set(),ids=new Set();let administrators=0;
  for(const user of value.users){
    if(!exact(user,['id','username','role','credential'])||typeof user.id!=='string'||!ID.test(user.id)||typeof user.username!=='string'||!USERNAME.test(user.username)||!['admin','guest'].includes(user.role)||names.has(user.username)||ids.has(user.id))throw Error('Invalid account record');
    const c=user.credential;
    if(!exact(c,['scheme','salt','key'])||c.scheme!=='scrypt-sha256-v1'||typeof c.salt!=='string'||!/^[a-f0-9]{32}$/.test(c.salt)||typeof c.key!=='string'||!/^[a-f0-9]{128}$/.test(c.key))throw Error('Invalid password hash');
    names.add(user.username);ids.add(user.id);if(user.role==='admin')administrators++;
  }
  if(!administrators)throw Error('An administrator account is required');
  return value;
}

// 路径由服务器管理员决定。systemd 的 DynamicUser/StateDirectory 可能用
// 目录软链接指向 /var/lib/private；允许这种目录映射，目标文件本身仍不跟随链接。
function inspectParents(directory){
  for(let current=directory;;current=path.dirname(current)){
    try{const stat=fs.statSync(current);if(!stat.isDirectory())throw Error('Invalid account directory');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(current===path.dirname(current))break;
  }
}
function readRaw(file){
  inspectParents(path.dirname(file));
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE_BYTES)throw Error('Invalid account file');
    const raw=fs.readFileSync(file);
    if(raw.length>MAX_FILE_BYTES)throw Error('Account file too large');
    return raw;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function loadAccounts(file){
  try{
    const raw=readRaw(file);if(raw===null)return null;
    return {value:validateStore(JSON.parse(raw.toString('utf8'))),token:digest(raw).toString('hex')};
  }catch(_){throw Error('账户库读取失败；请检查 BOAT_ACCOUNTS_FILE 或从备份恢复，不能回退初始密码');}
}
function derive(prehash,salt){return new Promise((resolve,reject)=>crypto.scrypt(prehash,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024},(error,key)=>error?reject(error):resolve(key)));}
async function hashCredential(prehash){
  const salt=crypto.randomBytes(16),key=await derive(prehash,salt);
  return {scheme:'scrypt-sha256-v1',salt:salt.toString('hex'),key:key.toString('hex')};
}
async function verifyCredential(user,password){
  const prehash=digest(password);
  if(user?.passwordHash)return crypto.timingSafeEqual(prehash,user.passwordHash);
  // 不存在的用户名也执行一次相同的昂贵派生，避免账户库加载后的快速失败分支。
  const c=user?.credential||{salt:'0'.repeat(32),key:'0'.repeat(128)};
  const candidate=await derive(prehash,Buffer.from(c.salt,'hex'));
  return !!user&&crypto.timingSafeEqual(candidate,Buffer.from(c.key,'hex'));
}

async function saveAccounts(file,value,expectedToken,{authorize,commit}){
  validateStore(value);const directory=path.dirname(file),temporary=path.join(directory,'.accounts.'+crypto.randomBytes(12).toString('hex')+'.tmp');
  let handle;
  try{
    inspectParents(directory);await fs.promises.mkdir(directory,{recursive:true,mode:0o700});inspectParents(directory);
    // requests 的 setgid 组允许 DynamicUser 更换后继续读取；该组不包含构建用户。
    handle=await fs.promises.open(temporary,'wx',0o640);await handle.chmod(0o640);
    const raw=Buffer.from(JSON.stringify(value)+'\n');
    await handle.writeFile(raw);await handle.sync();await handle.close();handle=null;
    if(!authorize())throw failure(401,'登录会话已失效，请重新登录');
    const current=readRaw(file),token=current===null?null:digest(current).toString('hex');
    if(token!==expectedToken)throw failure(409,'服务器账户库已变化，请重新启动服务后再读取');
    // 最终授权、原子替换与内存提交同一轮执行；退出不能插入替换与会话撤销之间。
    fs.renameSync(temporary,file);commit(digest(raw).toString('hex'));
  }finally{
    if(handle)await handle.close().catch(()=>{});
    await fs.promises.unlink(temporary).catch(()=>{});
  }
}
module.exports={MAX_USERS,USERNAME,ID,resolveAccountFile,loadAccounts,hashCredential,verifyCredential,saveAccounts,digest};
