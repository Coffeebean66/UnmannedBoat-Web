/* 统一账户仅保存在服务器环境中；共享会话分别授权监测和管理功能。 */
'use strict';
const crypto=require('node:crypto'),{EventEmitter}=require('node:events'),{isIP}=require('node:net');
const hash=value=>crypto.createHash('sha256').update(value).digest();
function createAccountApi({env=process.env,now=Date.now,maxSessions=128,sessionMs=12*60*60*1000}={}){
  const enabled=env.BOAT_ACCOUNTS_ENABLED==='1',events=new EventEmitter(),sessions=new Map(),attempts=new Map();let closed=false;
  const users=enabled?[
    {username:env.BOAT_ADMIN_USERNAME,password:env.BOAT_ADMIN_PASSWORD,role:'admin'},
    {username:env.BOAT_GUEST_USERNAME,password:env.BOAT_GUEST_PASSWORD,role:'guest'}
  ]:[];
  for(const user of users){
    if(typeof user.username!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(user.username)||typeof user.password!=='string'||user.password.length<6||user.password.length>256)throw Error('Account usernames or passwords are not configured correctly');
    user.passwordHash=hash(user.password);delete user.password;
  }
  if(enabled&&users[0].username===users[1].username)throw Error('Administrator and guest usernames must differ');
  let configuredOrigin='';
  const originValue=env.BOAT_ACCOUNTS_ORIGIN||env.BOAT_CLOUD_ORIGIN||env.BOAT_UPDATE_ORIGIN;
  if(enabled&&originValue){const parsed=new URL(originValue);if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==originValue||parsed.username||parsed.password)throw Error('Account origin must be an exact HTTP(S) origin');configuredOrigin=originValue;}
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const secure=req=>!!req.socket.encrypted||configuredOrigin.startsWith('https:')||local(req)&&req.headers['x-forwarded-proto']==='https';
  const sameOrigin=req=>req.headers.origin===(configuredOrigin||((secure(req)?'https':'http')+'://'+req.headers.host))&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');
  const keyFrom=req=>{const token=String(req.headers.cookie||'').match(/(?:^|;\s*)boat_account_session=([a-f0-9]{64})(?:;|$)/)?.[1];return token?hash(token).toString('hex'):'';};
  function revoke(key){if(sessions.delete(key))events.emit('invalidate',key);}
  function activeKey(key){const value=sessions.get(key);if(!value)return false;if(closed||value.expiresAt<=now()){revoke(key);return false;}return true;}
  const sessionFor=req=>{const key=keyFrom(req);return activeKey(key)?{key,value:sessions.get(key)}:null;};
  const isActive=session=>!!session&&activeKey(session.key)&&sessions.get(session.key)===session.value;
  const publicUser=session=>session?{username:session.value.username,role:session.value.role}:null;
  const cookie=(req,token,age)=>'boat_account_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(secure(req)?'; Secure':'');
  async function body(req){
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))throw {status:415};
    if(Number(req.headers['content-length'])>1024)throw {status:413};
    const chunks=[];let size=0;const timer=setTimeout(()=>req.destroy(),5000);timer.unref?.();
    try{for await(const chunk of req){size+=chunk.length;if(size>1024)throw {status:413};chunks.push(chunk);}const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('body');return value;}
    catch(error){throw {status:error.status||400};}finally{clearTimeout(timer);}
  }
  async function handle(req,res,url){
    if(!url.pathname.startsWith('/api/auth/'))return false;
    if(url.pathname==='/api/auth/config'&&req.method==='GET'){const session=enabled?sessionFor(req):null;json(res,200,{enabled,requiresLogin:enabled&&!session,user:publicUser(session)});return true;}
    if(!enabled||closed){json(res,503,{error:'服务器尚未启用账户登录'});return true;}
    if(!sameOrigin(req)){json(res,403,{error:'请从本站发起账户操作'});return true;}
    if(url.pathname==='/api/auth/login'&&req.method==='POST'){
      const ip=local(req)&&isIP(req.headers['x-real-ip']||'')?req.headers['x-real-ip']:(req.socket.remoteAddress||'unknown'),time=now();let attempt=attempts.get(ip);
      if(!attempt||time-attempt.started>=60000){if(attempts.size>=1024)attempts.delete(attempts.keys().next().value);attempt={started:time,count:0};attempts.set(ip,attempt);}
      if(attempt.count>=8){res.setHeader('Retry-After','60');json(res,429,{error:'登录尝试过多，请一分钟后再试'});return true;}attempt.count++;
      let input;try{input=await body(req);}catch(error){json(res,error.status,{error:'登录请求格式不正确'});return true;}
      if(typeof input.username!=='string'||input.username.length>64||typeof input.password!=='string'||input.password.length>256||Object.keys(input).some(key=>!['username','password'].includes(key))){json(res,401,{error:'用户名或密码不正确'});return true;}
      const provided=hash(input.password);let matched;
      for(const user of users){const valid=crypto.timingSafeEqual(provided,user.passwordHash);if(user.username===input.username&&valid)matched=user;}
      if(!matched){json(res,401,{error:'用户名或密码不正确'});return true;}
      if(closed){json(res,503,{error:'服务正在重启，请稍后重试'});return true;}
      for(const key of sessions.keys())activeKey(key);revoke(keyFrom(req));
      if(sessions.size>=maxSessions){json(res,503,{error:'登录会话已满，请稍后再试'});return true;}
      const token=crypto.randomBytes(32).toString('hex'),key=hash(token).toString('hex');
      const value={username:matched.username,role:matched.role,expiresAt:now()+sessionMs,checked:null};sessions.set(key,value);
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
