/* 初次账户来自服务器环境；管理员修改后使用独立的持久化账户库。 */
'use strict';
const crypto=require('node:crypto'),{EventEmitter}=require('node:events'),{isIP}=require('node:net');
const {MAX_USERS,USERNAME,resolveAccountFile,loadAccounts,hashCredential,verifyCredential,saveAccounts}=require('./account-store');
const hash=value=>crypto.createHash('sha256').update(value).digest();
function createAccountApi({env=process.env,now=Date.now,maxSessions=128,sessionMs=12*60*60*1000,storeFile}={}){
  const enabled=env.BOAT_ACCOUNTS_ENABLED==='1',events=new EventEmitter(),sessions=new Map(),attempts=new Map();let closed=false,writing=false,loginWork=0;
  const accountFile=enabled?resolveAccountFile(env,storeFile):'',stored=enabled?loadAccounts(accountFile):null;
  let revision=stored?.value.revision||0,storeToken=stored?.token||null;
  let users=stored?stored.value.users:enabled?[
    {username:env.BOAT_ADMIN_USERNAME,password:env.BOAT_ADMIN_PASSWORD,role:'admin'},
    {username:env.BOAT_GUEST_USERNAME,password:env.BOAT_GUEST_PASSWORD,role:'guest'}
  ]:[];
  for(const user of stored?[]:users){
    if(typeof user.username!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(user.username)||typeof user.password!=='string'||user.password.length<6||user.password.length>256)throw Error('Account usernames or passwords are not configured correctly');
    user.id=crypto.randomBytes(16).toString('hex');user.passwordHash=hash(user.password);delete user.password;
  }
  if(enabled&&!stored&&users[0].username===users[1].username)throw Error('Administrator and guest usernames must differ');
  let configuredOrigin='';
  const originValue=env.BOAT_ACCOUNTS_ORIGIN||env.BOAT_CLOUD_ORIGIN||env.BOAT_UPDATE_ORIGIN;
  if(enabled&&originValue){const parsed=new URL(originValue);if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==originValue||parsed.username||parsed.password)throw Error('Account origin must be an exact HTTP(S) origin');configuredOrigin=originValue;}
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const secure=req=>!!req.socket.encrypted||configuredOrigin.startsWith('https:')||local(req)&&req.headers['x-forwarded-proto']==='https';
  const sameOrigin=req=>req.headers.origin===(configuredOrigin||((secure(req)?'https':'http')+'://'+req.headers.host))&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');
  const keyFrom=req=>{const token=String(req.headers.cookie||'').match(/(?:^|;\s*)boat_account_session=([a-f0-9]{64})(?:;|$)/)?.[1];return token?hash(token).toString('hex'):'';};
  function revoke(key){if(sessions.delete(key))events.emit('invalidate',key);}
  function activeKey(key){const value=sessions.get(key);if(!value)return false;const user=users.find(user=>user.id===value.userId);if(closed||value.expiresAt<=now()||!user||user.username!==value.username||user.role!==value.role){revoke(key);return false;}return true;}
  const sessionFor=req=>{const key=keyFrom(req);return activeKey(key)?{key,value:sessions.get(key)}:null;};
  const isActive=session=>!!session&&activeKey(session.key)&&sessions.get(session.key)===session.value;
  const publicUser=session=>session?{username:session.value.username,role:session.value.role}:null;
  const cookie=(req,token,age)=>'boat_account_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(secure(req)?'; Secure':'');
  async function body(req,limit=1024){
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))throw {status:415};
    if(Number(req.headers['content-length'])>limit)throw {status:413};
    return new Promise((resolve,reject)=>{
      const chunks=[];let size=0,finished=false;
      const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('error',onError);req.removeListener('aborted',onError);if(error)reject(error);else resolve(value);};
      const onData=chunk=>{size+=chunk.length;if(size>limit)return finish({status:413});chunks.push(chunk);};
      const onEnd=()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('body');finish(null,value);}catch(_){finish({status:400});}};
      const onError=()=>finish({status:400}),timer=setTimeout(()=>finish({status:408}),5000);timer.unref?.();
      req.on('data',onData);req.once('end',onEnd);req.once('error',onError);req.once('aborted',onError);
    });
  }
  const visibleUsers=()=>users.map(({id,username,role})=>({id,username,role}));
  const userSnapshot=session=>({users:visibleUsers(),currentUserId:session.value.userId});
  const administrator=session=>!closed&&isActive(session)&&session.value.role==='admin';
  async function manageUsers(req,res,url){
    const session=sessionFor(req);
    if(!session){json(res,401,{error:'请先登录管理员账户'});return;}
    if(session.value.role!=='admin'){json(res,403,{error:'仅管理员可以管理用户'});return;}
    const collection=url.pathname==='/api/auth/users',match=url.pathname.match(/^\/api\/auth\/users\/([a-f0-9]{32})$/);
    if(!collection&&!match){json(res,404,{error:'用户不存在'});return;}
    if(collection&&req.method==='GET'){json(res,200,userSnapshot(session));return;}
    if(!(collection&&req.method==='POST'||match&&req.method==='PATCH')){res.setHeader('Allow',collection?'GET, POST':'PATCH');json(res,405,{error:'用户管理操作不支持此方法'});return;}
    if(writing){json(res,409,{error:'正在保存账户，请稍后重新读取'});return;}
    writing=true;
    try{
      let input;try{input=await body(req,4096);}catch(error){res.setHeader('Connection','close');req.resume();throw Object.assign(Error('用户请求格式不正确'),{status:error.status});}
      const keys=Object.keys(input);
      if(keys.some(key=>!['username','role','password'].includes(key))||typeof input.username!=='string'||!USERNAME.test(input.username)||!['admin','guest'].includes(input.role)||
          (collection&&!Object.hasOwn(input,'password'))||(Object.hasOwn(input,'password')&&(typeof input.password!=='string'||input.password.length<6||input.password.length>256))){throw Object.assign(Error('用户名需为1～64位字母、数字、下划线、点或短横线；密码需6～256字符，角色只能为管理员或访客'),{status:400});}
      const previous=match?users.find(user=>user.id===match[1]):null;
      if(match&&!previous)throw Object.assign(Error('用户不存在'),{status:404});
      if(collection&&users.length>=MAX_USERS)throw Object.assign(Error('最多支持64个用户'),{status:409});
      if(users.some(user=>user.username===input.username&&user!==previous))throw Object.assign(Error('用户名已存在'),{status:409});
      if(previous?.role==='admin'&&input.role!=='admin'&&users.filter(user=>user.role==='admin').length===1)throw Object.assign(Error('必须至少保留一个管理员'),{status:409});
      if(!administrator(session)||res.destroyed)throw Object.assign(Error('登录会话已失效，请重新登录'),{status:401});
      const changed=!previous||previous.username!==input.username||previous.role!==input.role||Object.hasOwn(input,'password');
      if(!changed){json(res,200,{ok:true,reauthenticate:false,...userSnapshot(session)});return;}
      const currentRevision=revision,nextId=previous?.id||crypto.randomBytes(16).toString('hex');
      const next=[];
      // 首次持久化时迁移全部环境密码摘要，禁止把快速SHA256摘要保存到磁盘。
      for(const user of users){
        const credential=user.credential||await hashCredential(user.passwordHash);
        next.push({id:user.id,username:user.username,role:user.role,credential});
      }
      const replacement={id:nextId,username:input.username,role:input.role,credential:Object.hasOwn(input,'password')?await hashCredential(hash(input.password)):next.find(user=>user.id===nextId).credential};
      if(previous)next[next.findIndex(user=>user.id===nextId)]=replacement;else next.push(replacement);
      const reauthenticate=!!previous&&previous.id===session.value.userId;
      await saveAccounts(accountFile,{version:1,revision:currentRevision+1,users:next},storeToken,{
        authorize:()=>administrator(session)&&revision===currentRevision&&!req.aborted&&!res.destroyed,
        commit(token){users=next;revision++;storeToken=token;for(const [key,value]of sessions)if(value.userId===nextId)revoke(key);}
      });
      if(reauthenticate)res.setHeader('Set-Cookie',cookie(req,'',0));
      json(res,collection?201:200,{ok:true,reauthenticate,...userSnapshot(session)});
    }catch(error){if(!res.destroyed)json(res,error.status||503,{error:error.status?error.message:'账户保存失败，当前账户未更改，请检查存储目录权限'});}
    finally{writing=false;}
  }
  async function handle(req,res,url){
    if(!url.pathname.startsWith('/api/auth/'))return false;
    if(url.pathname==='/api/auth/config'&&req.method==='GET'){const session=enabled?sessionFor(req):null;json(res,200,{enabled,requiresLogin:enabled&&!session,user:publicUser(session)});return true;}
    if(!enabled||closed){json(res,503,{error:'服务器尚未启用账户登录'});return true;}
    const userListRead=url.pathname==='/api/auth/users'&&req.method==='GET'&&!req.headers.origin&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');
    if(!userListRead&&!sameOrigin(req)){json(res,403,{error:'请从本站发起账户操作'});return true;}
    if(url.pathname==='/api/auth/users'||url.pathname.startsWith('/api/auth/users/')){await manageUsers(req,res,url);return true;}
    if(url.pathname==='/api/auth/login'&&req.method==='POST'){
      const initialSession=sessionFor(req);
      const ip=local(req)&&isIP(req.headers['x-real-ip']||'')?req.headers['x-real-ip']:(req.socket.remoteAddress||'unknown'),time=now();let attempt=attempts.get(ip);
      if(!attempt||time-attempt.started>=60000){if(attempts.size>=1024)attempts.delete(attempts.keys().next().value);attempt={started:time,count:0};attempts.set(ip,attempt);}
      if(attempt.count>=8){res.setHeader('Retry-After','60');json(res,429,{error:'登录尝试过多，请一分钟后再试'});return true;}attempt.count++;
      let input;try{input=await body(req);}catch(error){res.setHeader('Connection','close');req.resume();json(res,error.status,{error:'登录请求格式不正确'});return true;}
      if(typeof input.username!=='string'||input.username.length>64||typeof input.password!=='string'||input.password.length>256||Object.keys(input).some(key=>!['username','password'].includes(key))){json(res,401,{error:'用户名或密码不正确'});return true;}
      if(loginWork>=4){json(res,429,{error:'登录验证繁忙，请稍后再试'});return true;}
      const candidate=users.find(user=>user.username===input.username),currentRevision=revision;let matched;
      loginWork++;
      try{if(await verifyCredential(candidate,input.password))matched=candidate;}
      catch(_){json(res,503,{error:'登录验证暂时不可用，请稍后重试'});return true;}
      finally{loginWork--;}
      if(!matched){json(res,401,{error:'用户名或密码不正确'});return true;}
      if(req.aborted||res.destroyed)return true;
      if(closed){json(res,503,{error:'服务正在重启，请稍后重试'});return true;}
      if(initialSession&&!isActive(initialSession)){json(res,409,{error:'登录期间原会话已退出或失效，请重新登录'});return true;}
      if(currentRevision!==revision||!users.includes(matched)){json(res,409,{error:'账户刚刚发生变化，请重新登录'});return true;}
      for(const key of sessions.keys())activeKey(key);revoke(keyFrom(req));
      if(sessions.size>=maxSessions){json(res,503,{error:'登录会话已满，请稍后再试'});return true;}
      const token=crypto.randomBytes(32).toString('hex'),key=hash(token).toString('hex');
      const value={userId:matched.id,username:matched.username,role:matched.role,expiresAt:now()+sessionMs,checked:null};sessions.set(key,value);
      res.setHeader('Set-Cookie',cookie(req,token,Math.floor(sessionMs/1000)));json(res,200,{ok:true,user:{username:value.username,role:value.role}});return true;
    }
    if(url.pathname==='/api/auth/session'&&req.method==='DELETE'){revoke(keyFrom(req));res.setHeader('Set-Cookie',cookie(req,'',0));json(res,200,{ok:true});return true;}
    json(res,404,{error:'账户接口不存在'});return true;
  }
  function close(){if(closed)return;closed=true;for(const key of sessions.keys())revoke(key);attempts.clear();}
  return {enabled,handle,close,sessionFor,isActive,activeKey,sameOrigin,publicUser,
    onInvalidate(callback){events.on('invalidate',callback);return ()=>events.removeListener('invalidate',callback);},
    getSessionCount:()=>sessions.size};
}
module.exports={createAccountApi};
