/* 同源密码登录、有限期会话和 SSE。仅推送实时遥测，不重播旧帧。 */
'use strict';
const crypto=require('node:crypto');
const {isIP}=require('node:net');
const {DEVICE_ID}=require('./cloud');
const {readVideoConfig}=require('./video-protocol');
const COOKIE='boat_cloud_session';
const hash=value=>crypto.createHash('sha256').update(value).digest();
function createCloudApi({bridge,env=process.env,now=Date.now,maxSessions=128,maxClients=64,maxClientsPerSession=4,sessionMs=12*60*60*1000,heartbeatMs=15000,accounts}={}){
  const accountMode=!!accounts?.enabled;
  const enabled=!!bridge?.enabled;
  const videoConfig=readVideoConfig(env);
  if(enabled&&!accountMode&&(!env.BOAT_CLOUD_PASSWORD||env.BOAT_CLOUD_PASSWORD.length<16||env.BOAT_CLOUD_PASSWORD.length>256))throw Error('BOAT_CLOUD_PASSWORD must contain 16 to 256 characters');
  let configuredOrigin='';
  if(env.BOAT_CLOUD_ORIGIN){
    const parsed=new URL(env.BOAT_CLOUD_ORIGIN);
    if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==env.BOAT_CLOUD_ORIGIN)throw Error('BOAT_CLOUD_ORIGIN must be an HTTP(S) origin without a trailing slash');
    configuredOrigin=parsed.origin;
  }
  const expectedPassword=hash(env.BOAT_CLOUD_PASSWORD||'');
  const sessions=new Map(),attempts=new Map(),clients=new Set();
  let closed=false,fleetTimer=null,fleetIds='',fleetBroker=null;
  const fleetSent=new Map(),FLEET_INTERVAL_MS=250;
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const secure=req=>!!req.socket.encrypted||(local(req)&&req.headers['x-forwarded-proto']==='https')||configuredOrigin.startsWith('https:');
  const origin=req=>configuredOrigin||((secure(req)?'https':'http')+'://'+req.headers.host);
  const sameOrigin=req=>typeof req.headers.origin==='string'&&req.headers.origin===origin(req)&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');
  // 只接受本机反向代理覆盖的 X-Real-IP，不信任公网请求传入的代理头。
  const address=req=>local(req)&&isIP(req.headers['x-real-ip']||'')?req.headers['x-real-ip']:(req.socket.remoteAddress||'unknown');
  const keyFromRequest=req=>{
    const match=String(req.headers.cookie||'').match(/(?:^|;\s*)boat_cloud_session=([a-f0-9]{64})(?:;|$)/);
    return match?hash(match[1]).toString('hex'):'';
  };
  const sessionFor=req=>{
    if(accountMode){const session=accounts.sessionFor(req);return session?{key:session.key,...session.value}:null;}
    const key=keyFromRequest(req),session=sessions.get(key);
    if(!session)return null;
    if(session.expiresAt<=now()){sessions.delete(key);closeSession(key);return null;}
    return {key,...session};
  };
  const cookie=(req,token,age)=>COOKIE+'='+token+'; Path=/api/cloud; HttpOnly; SameSite=Strict; Max-Age='+age+(secure(req)?'; Secure':'');
  function closeClient(client,force=false){
    if(!clients.delete(client))return;
    clearInterval(client.timer);
    clearTimeout(client.drainTimer);if(client.onDrain)client.res.removeListener('drain',client.onDrain);
    if(client.fleet&&![...clients].some(item=>item.fleet)){clearInterval(fleetTimer);fleetTimer=null;fleetSent.clear();fleetIds='';fleetBroker=null;}
    if(force&&typeof client.res.destroy==='function')client.res.destroy();else client.res.end();
  }
  function closeSession(key){for(const client of [...clients])if(client.key===key)closeClient(client);}
  const parameterOperations=new Set();
  const unsubscribe=accountMode?accounts.onInvalidate(key=>{closeSession(key);for(const operation of parameterOperations)if(operation.key===key)operation.controller.abort();}):()=>{};
  const activeKey=key=>accountMode?accounts.activeKey(key):sessions.has(key)&&sessions.get(key).expiresAt>now();
  function send(client,event,data){
    if(!activeKey(client.key))return closeClient(client);
    if(client.res.destroyed||client.res.writableEnded)return closeClient(client);
    const encoded='event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n';
    if(client.backpressured||client.res.writableLength>32768)return closeClient(client,true);
    if(!client.res.write(encoded)){
      // 64艘船首次快照可超过Node单次写入高水位；只容许这一份有上限的快照等待drain，不继续排队。
      if(client.fleet&&event==='fleet'&&Buffer.byteLength(encoded)<=524288){
        client.backpressured=true;client.onDrain=()=>{client.backpressured=false;clearTimeout(client.drainTimer);client.onDrain=null;};
        client.res.once('drain',client.onDrain);client.drainTimer=setTimeout(()=>closeClient(client,true),2000);client.drainTimer.unref?.();
      }else closeClient(client,true);
    }
  }
  const fleetSnapshot=()=>{
    const state=typeof bridge.fleetList==='function'?bridge.fleetList():bridge.list();
    return {...state,devices:state.devices.map(device=>({...device,summary:device.summary??null})),serverTime:now()};
  };
  const identity=devices=>devices.map(device=>device.id).sort().join('\0');
  function rememberFleet(state){
    fleetIds=identity(state.devices);fleetBroker=state.brokerConnected;fleetSent.clear();
    for(const device of state.devices)fleetSent.set(device.id,{at:now(),text:JSON.stringify(device),online:device.online});
  }
  function broadcastFleet(state){
    for(const client of [...clients])if(client.fleet)send(client,'fleet',state);
    if([...clients].some(client=>client.fleet))rememberFleet(state);
  }
  function flushFleet(immediateOffline=false){
    if(![...clients].some(client=>client.fleet))return;
    const state=fleetSnapshot();
    if(identity(state.devices)!==fleetIds||state.brokerConnected!==fleetBroker)return broadcastFleet(state);
    for(const device of state.devices){
      const previous=fleetSent.get(device.id),text=JSON.stringify(device);
      if(previous?.text===text)continue;
      const urgent=!device.online&&(immediateOffline||previous?.online);
      if(!urgent&&previous&&now()-previous.at<FLEET_INTERVAL_MS)continue;
      for(const client of [...clients])if(client.fleet)send(client,'fleet-device',{brokerConnected:state.brokerConnected,device,serverTime:state.serverTime});
      if([...clients].some(client=>client.fleet))fleetSent.set(device.id,{at:now(),text,online:device.online});
    }
  }
  function onTelemetry(message){
    for(const client of [...clients])if(!client.fleet&&client.device===message.deviceId)send(client,'telemetry',message);
    // 原始遥测可能是64船×10Hz；总览由共用250ms定时器合并，不在每一包重算整个船队。
  }
  function onState(message){
    for(const client of [...clients])if(!client.fleet&&(!message.device||message.device.id===client.device))send(client,'state',bridge.state(client.device));
    if(!message.device||!fleetSent.has(message.device.id)||(!message.device.online&&fleetSent.get(message.device.id).online))flushFleet(true);
  }
  if(enabled){bridge.on('telemetry',onTelemetry);bridge.on('state',onState);}
  async function readJson(req,limit=1024){
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))throw {status:415};
    if(Number(req.headers['content-length'])>limit)throw {status:413};
    const chunks=[];let size=0;
    const timer=setTimeout(()=>req.destroy(),5000);timer.unref?.();
    try{for await(const chunk of req){size+=chunk.length;if(size>limit)throw {status:413};chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
    catch(error){throw {status:error.status||400};}finally{clearTimeout(timer);}
  }
  async function handle(req,res,url){
    if(!url.pathname.startsWith('/api/cloud/'))return false;
    res.setHeader('Cache-Control','no-store');
    if(url.pathname==='/api/cloud/config'&&req.method==='GET'){
      json(res,200,{enabled,requiresLogin:enabled&&!sessionFor(req),serverTime:now(),video:videoConfig});return true;
    }
    if(!enabled||closed){json(res,503,{error:'Cloud telemetry is not enabled'});return true;}
    if(url.pathname==='/api/cloud/parameters'&&req.method==='POST'){
      const shared=accountMode?accounts.sessionFor(req):null;
      if(!shared||shared.value.role!=='admin'){json(res,accountMode&&!shared?401:403,{error:'仅管理员账户可以操作云端参数'});return true;}
      if(!accounts.sameOrigin(req)){json(res,403,{error:'请从本站发起参数操作'});return true;}
      let input;try{input=await readJson(req,2048);}catch(error){json(res,error.status,{error:'参数请求格式不正确'});return true;}
      if(!accounts.isActive(shared)||shared.value.role!=='admin'||closed){json(res,401,{error:'登录会话已失效，请重新登录'});return true;}
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['deviceId','kind','values'].includes(key))){json(res,400,{error:'参数请求字段不正确'});return true;}
      const operation={key:shared.key,controller:new AbortController()};parameterOperations.add(operation);
      const onClose=()=>{if(!res.writableEnded)operation.controller.abort();};res.once('close',onClose);
      try{
        const frame=await bridge.requestParameters(input.deviceId,input.kind,input.values,{signal:operation.controller.signal});
        if(!accounts.isActive(shared)||shared.value.role!=='admin'){json(res,401,{error:'登录会话已失效，结果未知，请重新读取参数'});return true;}
        if(!res.destroyed)json(res,200,{frame:frame.toString('base64'),serverTime:now()});
      }catch(error){if(!res.destroyed)json(res,[400,409,503,504].includes(error.status)?error.status:503,{error:error.status?error.message:'参数操作未完成，请读取确认'});}
      finally{parameterOperations.delete(operation);res.removeListener('close',onClose);}return true;
    }
    if(accountMode&&['/api/cloud/login','/api/cloud/session'].includes(url.pathname)){json(res,403,{error:'请使用平台账户登录或退出'});return true;}
    if(url.pathname==='/api/cloud/login'&&req.method==='POST'){
      if(!sameOrigin(req)){json(res,403,{error:'Same-origin request required'});return true;}
      const ip=address(req),time=now();
      let attempt=attempts.get(ip);
      if(!attempt||time-attempt.started>=60000){
        if(attempts.size>=1024)attempts.delete(attempts.keys().next().value);
        attempt={started:time,count:0};attempts.set(ip,attempt);
      }
      if(attempt.count>=8){res.setHeader('Retry-After','60');json(res,429,{error:'Too many login attempts'});return true;}
      attempt.count++;
      let body;try{body=await readJson(req);}catch(error){json(res,error.status,{error:'Invalid login request'});return true;}
      if(typeof body?.password!=='string'||body.password.length>256||!crypto.timingSafeEqual(hash(body.password),expectedPassword)){
        json(res,401,{error:'Incorrect password'});return true;
      }
      // 登录不延长已有会话；定期清理到期记录并限制会话总数。
      for(const [key,session]of sessions)if(session.expiresAt<=time){sessions.delete(key);closeSession(key);}
      const previous=keyFromRequest(req);if(sessions.delete(previous))closeSession(previous);
      if(sessions.size>=maxSessions){json(res,503,{error:'Session limit reached'});return true;}
      const token=crypto.randomBytes(32).toString('hex'),key=hash(token).toString('hex');
      sessions.set(key,{expiresAt:time+sessionMs});
      res.setHeader('Set-Cookie',cookie(req,token,Math.floor(sessionMs/1000)));
      json(res,200,{ok:true});return true;
    }
    if(url.pathname==='/api/cloud/session'&&req.method==='DELETE'){
      if(!sameOrigin(req)){json(res,403,{error:'Same-origin request required'});return true;}
      const key=keyFromRequest(req);sessions.delete(key);closeSession(key);
      res.setHeader('Set-Cookie',cookie(req,'',0));json(res,200,{ok:true});return true;
    }
    const session=sessionFor(req);
    if(!session){json(res,401,{error:'Login required'});return true;}
    if(url.pathname==='/api/cloud/devices'&&req.method==='GET'){json(res,200,{...bridge.list(),serverTime:now()});return true;}
    if(url.pathname==='/api/cloud/fleet'&&req.method==='GET'){json(res,200,fleetSnapshot());return true;}
    if(url.pathname==='/api/cloud/history'&&req.method==='GET'){
      const device=url.searchParams.get('device');
      if(!DEVICE_ID.test(device||'')){json(res,400,{error:'Invalid device ID'});return true;}
      const numeric=(name,fallback)=>url.searchParams.has(name)&&url.searchParams.get(name)!==''?Number(url.searchParams.get(name)):fallback;
      const since=numeric('since',0),until=numeric('until',Infinity),limit=numeric('limit',600);
      if(!Number.isFinite(since)||since<0||until<since||!(until===Infinity||Number.isFinite(until))||!Number.isInteger(limit)||limit<1||limit>3600){json(res,400,{error:'Invalid history range or limit'});return true;}
      const history=bridge.historySnapshot?.(device,{since,until,limit})||{deviceId:device,latest:null,samples:[],recording:{persistent:false,storageError:null}};
      json(res,200,{...history,serverTime:now()});return true;
    }
    if(['/api/cloud/events','/api/cloud/fleet/events'].includes(url.pathname)&&req.method==='GET'){
      const fleet=url.pathname==='/api/cloud/fleet/events',device=fleet?null:url.searchParams.get('device');
      if(!fleet&&!DEVICE_ID.test(device||'')){json(res,400,{error:'Invalid device ID'});return true;}
      if(clients.size>=maxClients||[...clients].filter(client=>client.key===session.key).length>=maxClientsPerSession){json(res,503,{error:'Stream limit reached'});return true;}
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.flushHeaders();req.setTimeout(0);res.setTimeout(0);
      const client={res,key:session.key,device,fleet,timer:null};clients.add(client);
      req.once('close',()=>closeClient(client));res.once('error',()=>closeClient(client));
      if(fleet){
        const state=fleetSnapshot();send(client,'fleet',state);
        if(!fleetTimer&&clients.has(client)){
          rememberFleet(state);fleetTimer=setInterval(()=>flushFleet(),FLEET_INTERVAL_MS);fleetTimer.unref?.();
        }
      }else send(client,'state',bridge.state(device));
      if(!clients.has(client))return true;
      client.timer=setInterval(()=>{
        if(!activeKey(client.key))return closeClient(client);
        if(client.backpressured||!res.write(': heartbeat\n\n'))closeClient(client,true);
      },heartbeatMs);client.timer.unref?.();
      return true;
    }
    json(res,404,{error:'API endpoint not found'});return true;
  }
  function close(){
    if(closed)return;closed=true;
    clearInterval(fleetTimer);fleetTimer=null;fleetSent.clear();
    for(const client of [...clients])closeClient(client);
    for(const operation of parameterOperations)operation.controller.abort();parameterOperations.clear();
    bridge?.removeListener('telemetry',onTelemetry);bridge?.removeListener('state',onState);
    unsubscribe();
    sessions.clear();attempts.clear();
  }
  return {handle,close,getClientCount:()=>clients.size,getSessionCount:()=>sessions.size};
}
module.exports={createCloudApi};
