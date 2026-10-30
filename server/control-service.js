/* 每船独占驾驶租约：浏览器新输入才会发给船，禁止服务器自动续发上一次非零推力。 */
'use strict';
const crypto=require('node:crypto');
const P=require('./control-protocol');
const DEVICE=/^[A-Za-z0-9_-]{1,64}$/;
const REASONS=['正常','驾驶指令超时，已停船','已退出网页操控','紧急停止','网络中断，已停船','固件升级锁定'];
const fault=(status,message)=>Object.assign(Error(message),{status});
class ControlService {
  constructor({bridge,now=Date.now,ackTimeoutMs=1800,inputTimeoutMs=600,capabilityFreshMs=750,stopTimeoutMs=1200,pollMs=50}={}){
    this.bridge=bridge;this.now=now;this.ackTimeoutMs=ackTimeoutMs;this.inputTimeoutMs=inputTimeoutMs;
    this.capabilityFreshMs=capabilityFreshMs;this.stopTimeoutMs=stopTimeoutMs;this.caps=new Map();this.jobs=new Map();this.closed=false;
    this.onCapability=event=>this.accept(event);this.onState=event=>{
      if(!bridge.brokerConnected)this.caps.clear();else if(event?.device?.online===false)this.caps.delete(event.device.id);
      this.refresh();
    };
    bridge?.on?.('control-capability',this.onCapability);bridge?.on?.('control-state',this.onCapability);bridge?.on?.('state',this.onState);
    this.timer=setInterval(()=>this.refresh(),pollMs);this.timer.unref?.();
  }
  cap(id){const value=this.caps.get(id),age=value?this.now()-value.receivedAt:-1;return age>=0&&age<=this.capabilityFreshMs?value:null;}
  live(id){const value=this.bridge?.get?.(id),age=value?this.now()-value.lastReceivedAt:-1;return !!(value?.online&&age>=0&&age<=1000);}
  own(job,owner,clientId){return !!job&&job.owner===owner&&job.clientId===clientId;}
  snapshot(id,owner='',clientId=''){
    const cap=this.cap(id),job=this.jobs.get(id),owned=this.own(job,owner,clientId),supported=!!cap;
    const active=!!(cap&&this.live(id)&&cap.state===1),available=!this.closed&&this.bridge?.enabled&&this.bridge?.brokerConnected&&this.bridge?.controlSubscribed&&this.live(id);
    const ready=!!(available&&cap&&cap.state!==1&&!job&&!this.bridge.firmwareLocks?.has(id)&&!this.bridge.pendingParameters?.has(id));
    const state=cap?.state??null,status=job?.status||(active?'active':state===2?'hold':available&&cap?'idle':'unavailable');
    let message=!available?'船端或云端数据未就绪':!cap?'等待船端驾驶协议；请更新固件并检查 MQTT 主题权限':job?.status==='acquiring'?'等待单片机确认接管':job?.status==='stopping'?'正在停船并释放操控':active?(owned?'网页已接管，遥控器无效':'该船已由其他驾驶会话接管'):REASONS[cap?.reason??0];
    return {deviceId:id,supported,ready,active,owned,state,status,reason:cap?.reason??null,message,mode:cap?.mode??0,
      sequence:cap?.sequence??0,clientSequence:owned?job.lastBrowserSequence:0,...(owned?{leaseId:job.leaseId}:{}),timeoutMs:500};
  }
  accept({deviceId,payload}){
    if(this.closed||!DEVICE.test(deviceId||''))return;
    const value=P.status(payload);if(!value)return;
    const previous=this.caps.get(deviceId),job=this.jobs.get(deviceId);let sourceAge=0;
    if(job&&value.token===job.token&&value.leaseId===job.leaseId&&value.state===1&&job.startTick!==undefined){
      // 即使 ACK 在网络中滞留，旧的 active 也不能被当作刚完成的硬件接管。
      const deviceElapsed=(value.uptimeMs-job.startTick)|0,estimatedAge=this.now()-job.startedAt-deviceElapsed;
      if(estimatedAge>500)return;
      sourceAge=Math.max(0,estimatedAge);
    }
    // 一个连接代次内状态只前进；较旧的 MQTT 状态不得回退已接受的 ACK。
    if(previous&&previous.token===value.token){
      const delta=(value.uptimeMs-previous.uptimeMs)>>>0;
      if(delta>0x7fffffff||delta===0&&(value.leaseId===previous.leaseId?value.sequence<=previous.sequence:value.leaseId!==job?.leaseId))return;
    }
    this.caps.set(deviceId,{...value,receivedAt:this.now()-sourceAge});
    if(!job)return;
    if(value.token!==job.token){this.drop(job,fault(409,'船端连接已变化，网页操控已取消'));return;}
    if(value.leaseId===job.leaseId&&value.state===1&&value.sequence>=1&&job.status==='acquiring'){
      job.status='active';job.resolve?.(this.snapshot(deviceId,job.owner,job.clientId));job.resolve=job.reject=null;return;
    }
    if(value.state!==1&&value.leaseId===job.leaseId){this.drop(job,fault(409,REASONS[value.reason]||'船端已停止网页操控'));return;}
    if(value.state===0&&job.status==='stopping'){this.drop(job);return;}
    if(value.state===1&&value.leaseId!==job.leaseId)this.drop(job,fault(409,'船端操控会话不匹配，已取消本机操控'));
  }
  assertClient(id,owner,clientId){if(typeof id!=='string'||!DEVICE.test(id)||!owner||!P.validToken(clientId))throw fault(400,'无人船或驾驶会话标识不正确');}
  assertReady(id){
    if(this.closed||!this.bridge?.enabled||!this.bridge?.brokerConnected||!this.bridge?.controlSubscribed||!this.live(id)||!this.cap(id))throw fault(503,'驾驶通道未就绪，请检查固件、实时遥测和 MQTT 主题权限');
  }
  acquire(id,owner,clientId,input){
    this.assertClient(id,owner,clientId);P.controls(input);
    if(input.throttle!==0||input.turn!==0)throw fault(400,'接管时运动输入必须归零');
    this.assertReady(id);const cap=this.cap(id);
    if(this.jobs.has(id)||cap.state===1)throw fault(409,'这艘船已有驾驶会话，请先停止并释放操控');
    this.bridge.claimControl(id);
    const job={id,owner,clientId,leaseId:crypto.randomBytes(8).toString('hex'),token:cap.token,sequence:0,lastBrowserSequence:0,lastInputAt:this.now(),startedAt:this.now(),status:'acquiring',input:{...input},resolve:null,reject:null};
    this.jobs.set(id,job);
    const promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
    this.send(job,'acquire',input).catch(()=>this.stopJob(job,'stop',fault(503,'接管指令发送失败，已取消操控')));
    return promise;
  }
  command(id,owner,clientId,leaseId,sequence,action,input){
    this.assertClient(id,owner,clientId);P.controls(input);
    const job=this.jobs.get(id);
    if(!this.own(job,owner,clientId)||leaseId!==job.leaseId)throw fault(409,'操控租约已失效或属于其他浏览器');
    if(!P.isU32(sequence)||sequence<=job.lastBrowserSequence)throw fault(409,'驾驶输入序号已过期，拒绝重放旧指令');
    if(!['input','stop','release'].includes(action))throw fault(400,'驾驶操作不正确');
    if(action!=='input'&&(input.throttle||input.turn))throw fault(400,'停止或释放时运动输入必须归零');
    job.lastBrowserSequence=sequence;
    if(action==='input'){
      if(job.status!=='active')throw fault(409,'驾驶接管尚未确认或已停止');
      this.assertReady(id);
      const cap=this.cap(id);if(cap.token!==job.token||cap.state!==1||cap.leaseId!==job.leaseId){this.stopJob(job,'stop');throw fault(409,'船端已停止网页操控，请重新启用');}
      if(input.mode!==job.input.mode&&(input.throttle||input.turn))throw fault(400,'切换控制模式时请先松开运动按键');
      job.lastInputAt=this.now();job.input={...input};
      this.send(job,'input',input).catch(()=>this.stopJob(job,'stop'));
    }else this.stopJob(job,action);
    return {accepted:true,...this.snapshot(id,owner,clientId)};
  }
  send(job,action,input){
    if(this.jobs.get(job.id)!==job)return Promise.reject(fault(409,'驾驶租约已释放'));
    const cap=this.cap(job.id);
    if(!cap||cap.token!==job.token)return Promise.reject(fault(503,'船端驾驶状态已过期'));
    // 把最新设备时钟向前推到发包时刻；500 ms 窗口在单片机再次检查。
    const uptimeMs=(cap.uptimeMs+Math.max(0,Math.floor(this.now()-cap.receivedAt)))>>>0;
    if(action==='acquire')job.startTick=uptimeMs;
    const sequence=++job.sequence;
    if(sequence>0xffffffff)return Promise.reject(fault(409,'驾驶序号已耗尽，请重新接管'));
    return this.bridge.publishControl(job.id,P.command({token:job.token,uptimeMs,leaseId:job.leaseId,sequence,action,...input}));
  }
  stopJob(job,action='stop',error){
    if(this.jobs.get(job.id)!==job||job.status==='stopping')return;
    job.status='stopping';job.stopAt=this.now();
    if(job.reject){job.reject(error||fault(409,'接管已取消，请重新启用'));job.resolve=job.reject=null;}
    this.send(job,action,{...job.input,throttle:0,turn:0}).catch(()=>{});
  }
  drop(job,error){
    if(this.jobs.get(job.id)!==job)return;
    this.jobs.delete(job.id);this.bridge.releaseControl?.(job.id);
    if(job.reject)job.reject(error||fault(409,'网页操控已停止'));job.resolve=job.reject=null;
  }
  releaseOwner(owner){for(const job of this.jobs.values())if(job.owner===owner)this.stopJob(job,'stop',fault(401,'登录会话已失效，已停船'));}
  cancelAcquire(id,owner,clientId){const job=this.jobs.get(id);if(this.own(job,owner,clientId))this.stopJob(job,'stop',fault(409,'浏览器连接已关闭，已取消接管'));}
  refresh(){
    if(this.closed)return;
    const now=this.now();
    for(const job of [...this.jobs.values()]){
      if(job.status==='stopping'){if(now-job.stopAt>=this.stopTimeoutMs)this.drop(job);continue;}
      if(!this.bridge.brokerConnected||!this.live(job.id)||!this.cap(job.id))this.stopJob(job,'stop',fault(503,'驾驶数据已断开，已取消操控'));
      else if(job.status==='acquiring'&&now-job.startedAt>=this.ackTimeoutMs)this.stopJob(job,'stop',fault(504,'单片机未确认接管，请检查固件和主题权限'));
      else if(job.status==='active'&&now-job.lastInputAt>=this.inputTimeoutMs)this.stopJob(job,'release',fault(504,'驾驶指令超时，已取消操控'));
    }
  }
  close(){
    if(this.closed)return;
    for(const job of [...this.jobs.values()]){this.stopJob(job,'stop',fault(503,'服务正在停止，已取消操控'));this.drop(job);}
    this.closed=true;clearInterval(this.timer);
    this.bridge?.removeListener?.('control-capability',this.onCapability);this.bridge?.removeListener?.('control-state',this.onCapability);this.bridge?.removeListener?.('state',this.onState);this.caps.clear();
  }
}
module.exports={ControlService,DEVICE,REASONS};
