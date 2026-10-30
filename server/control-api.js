/* 只接受同源管理员驾驶请求，所有租约归属绑定账户会话和浏览器实例。 */
'use strict';
const {ControlService,DEVICE}=require('./control-service');
const P=require('./control-protocol');
const fault=(status,message)=>Object.assign(Error(message),{status});
function readJson(req,limit=1024){
  if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))return Promise.reject(fault(415,'驾驶请求必须使用JSON'));
  if(Number(req.headers['content-length'])>limit)return Promise.reject(fault(413,'驾驶请求过大'));
  return new Promise((resolve,reject)=>{
    let size=0,done=false;const chunks=[];
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('aborted',abort);req.removeListener('error',abort);error?reject(error):resolve(value);};
    const data=chunk=>{size+=chunk.length;if(size>limit)return finish(fault(413,'驾驶请求过大'));chunks.push(chunk);};
    const end=()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(_){finish(fault(400,'驾驶请求格式不正确'));}};
    const abort=()=>finish(fault(400,'驾驶请求已中断'));
    const timer=setTimeout(()=>finish(fault(408,'驾驶请求超时，未执行')),1000);timer.unref?.();
    req.on('data',data);req.once('end',end);req.once('aborted',abort);req.once('error',abort);
  });
}
function createControlApi({bridge,accounts,service,serviceOptions={}}={}){
  const manager=service||new ControlService({bridge,...serviceOptions});let closed=false;
  const unsubscribe=accounts?.onInvalidate?.(key=>manager.releaseOwner(key))||(()=>{});
  const json=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  function authorize(req,res,owner){
    if(!accounts?.enabled||closed)throw fault(503,'网页操控需要启用平台管理员账户');
    if(!owner||!accounts.isActive(owner)||req.aborted||res.destroyed)throw fault(401,'请登录有效的管理员账户');
    if(owner.value.role!=='admin')throw fault(403,'仅管理员可以接管无人船');
  }
  return {
    manager,
    async handle(req,res,url){
      if(url.pathname!=='/api/cloud/control')return false;
      let owner;
      try{
        owner=accounts?.sessionFor?.(req);authorize(req,res,owner);
        const read=req.method==='GET',browserRead=read&&!req.headers.origin&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');
        if(!browserRead&&!accounts.sameOrigin(req))throw fault(403,'请从本站发起网页操控');
        if(read){
          if([...url.searchParams.keys()].some(key=>!['deviceId','clientId'].includes(key))||url.searchParams.getAll('deviceId').length!==1||url.searchParams.getAll('clientId').length!==1)throw fault(400,'驾驶状态请求字段不正确');
          const id=url.searchParams.get('deviceId'),clientId=url.searchParams.get('clientId');
          if(!DEVICE.test(id||'')||!P.validToken(clientId))throw fault(400,'无人船或驾驶会话标识不正确');
          json(res,200,manager.snapshot(id,owner.key,clientId));return true;
        }
        if(req.method!=='POST')throw fault(405,'网页操控只支持GET或POST');
        if(url.search)throw fault(400,'驾驶指令不接受查询参数');
        const input=await readJson(req);authorize(req,res,owner);
        const fields=['deviceId','clientId','action','leaseId','sequence','mode','throttle','turn','targetHeading'];
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))throw fault(400,'驾驶请求字段不正确');
        const {deviceId,clientId,action,leaseId,sequence,mode,throttle,turn,targetHeading}=input;
        const controls={mode,throttle,turn,targetHeading};
        if(action==='acquire'){
          if(leaseId!==undefined||sequence!==undefined)throw fault(400,'新接管不能复用旧租约或序号');
          const onClose=()=>{if(!res.writableEnded)manager.cancelAcquire(deviceId,owner.key,clientId);};res.once('close',onClose);
          try{
            const result=await manager.acquire(deviceId,owner.key,clientId,controls);authorize(req,res,owner);json(res,200,result);
          }finally{res.removeListener('close',onClose);}
        }else if(['input','stop','release'].includes(action)){
          json(res,202,manager.command(deviceId,owner.key,clientId,leaseId,sequence,action,controls));
        }else throw fault(400,'驾驶操作不正确');
      }catch(error){req.resume();json(res,error.status||503,{error:error.status?error.message:'驾驶服务不可用，已取消操控'});}
      return true;
    },
    close(){if(closed)return;closed=true;unsubscribe();manager.close();}
  };
}
module.exports={createControlApi,readJson};
