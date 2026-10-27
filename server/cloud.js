/* 网口遥测与有确认的参数事务：只发送单次参数命令，不发送航行控制指令。 */
'use strict';
const {EventEmitter}=require('node:events');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const protocol=require('../public/utils/uart4Protocol');
const parameters=require('./parameter-protocol');
const {unwrapTelemetry,isSyncResponse,UplinkClock}=require('./latency-protocol');
const {decodeVideoDescriptor}=require('./video-protocol');
const {TelemetryHistory,historyOptions}=require('./telemetry-history');
const DEVICE_ID=/^[A-Za-z0-9_-]{1,64}$/;
const LAYOUT=[
  [0,64,1,1,protocol.decodeFrame],
  [64,40,2,2,protocol.decodeVelocityFrame],
  [104,36,2,3,protocol.decodeBoatFrame],
  [140,36,1,4,protocol.decodeImuFrame]
];

function decodeTelemetry(payload){
  if(!Buffer.isBuffer(payload)||payload.length!==176)return null;
  const frames=[];
  for(const [offset,length,version,type,decode]of LAYOUT){
    const frame=payload.subarray(offset,offset+length);
    if(frame[2]!==version||frame[3]!==type||frame[4]!==length)return null;
    const decoded=decode(frame);if(!decoded)return null;frames.push(decoded);
  }
  return frames;
}
function validateTelemetry(payload){return !!decodeTelemetry(payload);}

// 总览只保留每船最近一包解析结果。独立源年龄决定每项的有效期限，不能用收包时间替代源时效。
function fleetSummary(sample,now){
  if(!sample||now<sample.receivedAt||now-sample.receivedAt>=1000)return null;
  const [status,velocityFrame,boatFrame]=sample.frames,v=velocityFrame.velocity,b=boatFrame.boat;
  const receivedAt=sample.receivedAt,packetUntil=receivedAt+1000;
  const until=(age,valid)=>valid&&Number.isFinite(age)&&age>=0?Math.min(packetUntil,receivedAt+1000-age):null;
  const boatUntil=until(b.ageMs,b.received),velocityUntil=until(v.ageMs,v.received&&v.fresh);
  const live=expiry=>Number.isFinite(expiry)&&now<expiry;
  const boatSpeed=live(boatUntil)&&b.feedbackValid,rtkSpeed=live(velocityUntil)&&v.velocityValid;
  const boatHeading=live(boatUntil)&&b.headingValid,rtkHeading=live(velocityUntil)&&v.headingValid;
  const validUntil={speedMps:boatSpeed?boatUntil:rtkSpeed?velocityUntil:null,targetSpeedMps:packetUntil,
    headingDegrees:boatHeading?boatUntil:rtkHeading?velocityUntil:null,
    position:live(velocityUntil)&&v.fixValid?velocityUntil:null,voltageV:null,controlMode:packetUntil};
  const motor=status.motors.filter(item=>item.received&&item.displayValid&&live(until(item.feedbackAgeMs,true)));
  if(motor.length)validUntil.voltageV=Math.min(...motor.map(item=>until(item.feedbackAgeMs,true)));
  return {receivedAt,speedMps:boatSpeed?b.actualMps:rtkSpeed?Math.hypot(v.xMps,v.yMps):null,
    targetSpeedMps:Math.abs(b.targetMps),headingDegrees:boatHeading?b.actualHeading:rtkHeading?v.headingDegrees:null,
    latitude:validUntil.position===null?null:v.latitude,longitude:validUntil.position===null?null:v.longitude,
    voltageV:motor.length?motor.reduce((sum,item)=>sum+item.voltageV,0)/motor.length:null,controlMode:b.controlMode,validUntil};
}

class CloudBridge extends EventEmitter {
  constructor({env=process.env,connect,now=Date.now,monotonicNow=()=>performance.now(),maxDevices=64,staleMs=3000,tickMs=1000,parameterFreshMs=2500,parameterTimeoutMs=5000,flashTimeoutMs=20000,historyOptions:historyConfig={}}={}){
    super();
    this.enabled=env.BOAT_CLOUD_ENABLED==='1';
    this.env=env;this.connect=connect;this.now=now;this.monotonicNow=monotonicNow;this.maxDevices=maxDevices;
    this.staleMs=staleMs;this.tickMs=tickMs;this.devices=new Map();
    this.parameterFreshMs=parameterFreshMs;this.parameterTimeoutMs=parameterTimeoutMs;this.flashTimeoutMs=flashTimeoutMs;this.pendingParameters=new Map();this.parameterSequence=crypto.randomBytes(4).readUInt32LE();
    this.brokerConnected=false;this.client=null;this.timer=null;this.stopped=false;this.generation=0;
    this.history=new TelemetryHistory(historyOptions(env,{now,maxDevices,...historyConfig}));
    this.prefix=env.BOAT_MQTT_TOPIC_PREFIX||'boats';
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(this.prefix))throw Error('Invalid BOAT_MQTT_TOPIC_PREFIX');
    // 历史记录只恢复设备目录，在线/参数能力仍需新的实时 MQTT 遥测确认。
    for(const id of this.history.deviceIds()){
      const device=this.obtain(id),latest=this.history.latest(id);
      device.lastReceivedAt=latest.receivedAt;device.status='offline';
    }
  }
  start(){
    if(!this.enabled||this.client||this.stopped)return;
    const url=this.env.BOAT_MQTT_URL||'mqtt://127.0.0.1:1883';
    let parsed;
    try{parsed=new URL(url);}catch(_){throw Error('Invalid BOAT_MQTT_URL');}
    if(!['mqtt:','mqtts:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error('BOAT_MQTT_URL must use mqtt/mqtts; configure credentials separately');
    const connect=this.connect||require('mqtt').connect;
    this.client=connect(url,{
      clientId:'boat-web-'+crypto.randomBytes(8).toString('hex'),
      username:this.env.BOAT_MQTT_USERNAME||undefined,password:this.env.BOAT_MQTT_PASSWORD||undefined,
      clean:true,reconnectPeriod:2000,connectTimeout:10000,keepalive:30,
      queueQoSZero:false,resubscribe:false,protocolVersion:5
    });
    this.client.on('connect',()=>{
      if(this.stopped)return;
      const generation=++this.generation;
      // MQTT 5 Retain As Published 保留实时转发的 RETAIN 位，避免把 retained 发布当作新能力。
      this.client.subscribe(['telemetry','status','parameter-capability','parameter-response'].map(kind=>this.prefix+'/+/'+kind),{qos:0,rap:true},(error,granted)=>{
        if(this.stopped||generation!==this.generation)return;
        if(error||granted?.some(subscription=>subscription.qos>=128)){this.setBrokerConnected(false);return;}
        this.setBrokerConnected(true);
        if(this.stopped||generation!==this.generation)return;
        // 旧 Broker 可能还没有视频 ACL；可选视频订阅失败不能阻断电控遥测、参数或更新健康检查。
        try{
          this.client.subscribe([this.prefix+'/+/video'],{qos:0,rap:true},()=>{
            if(this.stopped||generation!==this.generation)return;
            // 仅必需主题的订阅结果决定 brokerConnected，视频授权结果不修改连接状态。
          });
        }catch(_){/* 可选订阅的同步错误同样不改变已就绪的必需链路。 */}
      });
    });
    for(const event of ['offline','close','disconnect','error'])this.client.on(event,()=>{this.generation++;this.setBrokerConnected(false);});
    this.client.on('message',(topic,payload,packet)=>this.acceptMessage(topic,payload,packet));
    this.timer=setInterval(()=>this.refresh(),this.tickMs);this.timer.unref?.();
  }
  setBrokerConnected(connected){
    if(this.stopped||this.brokerConnected===connected)return;
    this.brokerConnected=connected;
    // Broker 重连后旧缓存仍保持离线；必须等到新的非 retained 遥测。
    if(!connected)for(const device of this.devices.values()){device.live=false;device.capability=null;device.fleetTelemetry=null;device.uplinkClock.reset();this.cancelParameters(device.id,503,'云端连接已断开，参数结果未知，请读取确认');}
    this.emit('state',{brokerConnected:connected,device:null});
  }
  snapshot(device){
    return {id:device.id,online:!!(this.brokerConnected&&device.live&&device.status!=='offline'&&
      device.lastReceivedAt!==null&&this.now()-device.lastReceivedAt<=this.staleMs),
      lastReceivedAt:device.lastReceivedAt,status:device.status,lastStatusAt:device.lastStatusAt,parametersReady:this.parametersReady(device),video:device.video?{...device.video}:null};
  }
  list(){return {brokerConnected:this.brokerConnected,devices:[...this.devices.values()].map(device=>this.snapshot(device))};}
  fleetSnapshot(device){const snapshot=this.snapshot(device);return {...snapshot,summary:snapshot.online?fleetSummary(device.fleetTelemetry,this.now()):null};}
  fleetList(){return {brokerConnected:this.brokerConnected,devices:[...this.devices.values()].map(device=>this.fleetSnapshot(device))};}
  get(id){const device=this.devices.get(id);return device?this.snapshot(device):null;}
  state(id){return {brokerConnected:this.brokerConnected,device:this.get(id)};}
  obtain(id){
    if(this.devices.has(id))return this.devices.get(id);
    if(this.devices.size>=this.maxDevices){
      const offline=[...this.devices.values()].filter(device=>!this.snapshot(device).online)
        .sort((a,b)=>(a.lastReceivedAt||a.lastStatusAt||0)-(b.lastReceivedAt||b.lastStatusAt||0));
      if(!offline.length)return null;
      this.cancelParameters(offline[0].id,503,'设备连接已变化，参数结果未知，请读取确认');
      this.devices.delete(offline[0].id);
    }
    const device={id,lastReceivedAt:null,status:'unknown',lastStatusAt:null,live:false,announcedOnline:false,announcedParametersReady:false,capability:null,consumedToken:null,fleetTelemetry:null,video:null,uplinkClock:new UplinkClock()};
    this.devices.set(id,device);return device;
  }
  acceptMessage(topic,payload,packet={}){
    if(this.stopped||!this.enabled||!this.brokerConnected||typeof topic!=='string'||!Buffer.isBuffer(payload))return false;
    const parts=topic.split('/');
    if(parts.length!==3||parts[0]!==this.prefix||!DEVICE_ID.test(parts[1]))return false;
    if(parts[2]==='video'){
      const descriptor=decodeVideoDescriptor(payload);if(!descriptor)return false;
      // 视频地址是可 retained 的配置；收到地址不代表有画面，也不延长单片机遥测或参数能力。
      const device=descriptor.enabled===false?this.devices.get(parts[1]):this.obtain(parts[1]);
      if(!device)return descriptor.enabled===false;
      device.video=descriptor.enabled===false?null:{...descriptor,receivedAt:this.now(),retained:packet.retain===true};
      this.emit('state',this.state(device.id));return true;
    }
    if(parts[2]==='telemetry'){
      const receivedAt=this.now(),receivedMono=this.monotonicNow();
      if(packet.retain)return false;
      const telemetry=unwrapTelemetry(payload);
      const frames=telemetry&&decodeTelemetry(telemetry.payload);if(!frames)return false;
      const device=this.obtain(parts[1]);if(!device)return false;
      device.lastReceivedAt=receivedAt;device.live=true;device.fleetTelemetry={receivedAt,frames};
      device.uplinkClock.observe(telemetry.session);
      const timing=telemetry.session?device.uplinkClock.estimate(telemetry.tick,receivedMono):null;
      // 新遥测证明设备已上线，避免旧的 retained offline 覆盖本次连接。
      if(device.status==='offline')device.status='unknown';
      device.announcedOnline=true;
      this.emit('state',this.state(device.id));
      const [status,velocity,boat,imu]=frames;
      const event={deviceId:device.id,receivedAt:device.lastReceivedAt,payload:telemetry.payload.toString('base64'),ageMs:0,...timing};
      const summary={status,velocity:velocity.velocity,boat:boat.boat,imu:imu.imu};
      this.history.record({...event,summary});
      this.emit('telemetry',event);
      if(telemetry.session)this.probeUplinkClock(device);
      return true;
    }
    if(parts[2]==='status'&&payload.length<=7){
      const value=payload.toString('utf8');if(!['online','offline'].includes(value))return false;
      const device=this.obtain(parts[1]);if(!device)return false;
      device.status=value;device.lastStatusAt=this.now();
      if(value==='offline'){device.live=false;device.capability=null;device.fleetTelemetry=null;device.uplinkClock.reset();this.cancelParameters(device.id,503,'设备已离线，参数结果未知，请读取确认');}
      this.emit('state',this.state(device.id));return true;
    }
    if(parts[2]==='parameter-capability'){
      if(packet.retain)return false;const value=parameters.capability(payload);if(!value)return false;
      const device=this.obtain(parts[1]);if(!device)return false;const previous=device.capability;
      if(previous&&(previous.token!==value.token||value.uptimeMs<previous.uptimeMs))this.cancelParameters(device.id,409,'设备参数令牌已变化，结果未知，请读取确认');
      device.capability={...value,receivedAt:this.now()};this.emit('state',this.state(device.id));return true;
    }
    if(parts[2]==='parameter-response'){
      if(packet.retain)return false;
      // BTS1 是只读校时诊断，不续遥测在线时间，也不完成/消费任何 BPC1 参数事务。
      if(isSyncResponse(payload)){
        const device=this.devices.get(parts[1]);
        return !!(device&&this.snapshot(device).online&&device.uplinkClock.accept(payload,this.monotonicNow()));
      }
      const value=parameters.response(payload),pending=this.pendingParameters.get(parts[1]);
      if(!value||!pending||value.token!==pending.token||value.uptimeMs!==pending.uptimeMs||value.sequence!==pending.sequence)return false;
      const device=this.devices.get(parts[1]);if(!this.parameterLive(device)){this.cancelParameters(parts[1],503,'设备数据已过期，参数结果未知，请读取确认');return false;}
      this.finishParameters(parts[1],null,value.frame);return true;
    }
    return false;
  }
  probeUplinkClock(device){
    if(!this.client||typeof this.client.publish!=='function'||this.client.connected===false||this.client.disconnecting||this.pendingParameters.has(device.id))return;
    const clock=device.uplinkClock,pending=clock.probe(this.monotonicNow());if(!pending)return;
    // 复用已部署的参数主题ACL；不同magic/精确长度使校时不会进入控制/Flash队列。
    try{this.client.publish(this.prefix+'/'+device.id+'/parameter-command',pending.payload,{qos:0,retain:false},error=>{if(error)clock.cancel(pending);});}
    catch(_){clock.cancel(pending);}
  }
  parameterLive(device){
    if(!device||!this.brokerConnected||!device.live||device.status==='offline'||!device.capability||device.lastReceivedAt===null)return false;
    const time=this.now(),telemetryAge=time-device.lastReceivedAt,capAge=time-device.capability.receivedAt;
    return telemetryAge>=0&&telemetryAge<=this.parameterFreshMs&&capAge>=0&&capAge<=this.parameterFreshMs;
  }
  parametersReady(device){return !!(this.parameterLive(device)&&device.capability.token!==device.consumedToken&&!this.pendingParameters.has(device.id));}
  finishParameters(id,error,frame){
    const pending=this.pendingParameters.get(id);if(!pending)return;
    this.pendingParameters.delete(id);clearTimeout(pending.timer);pending.signal?.removeEventListener('abort',pending.onAbort);
    if(error)pending.reject(error);else pending.resolve(frame);this.emit('state',this.state(id));
  }
  cancelParameters(id,status,message){this.finishParameters(id,Object.assign(Error(message),{status}));}
  requestParameters(id,kind,values,{signal}={}){
    try{parameters.validateOperation(kind,values);}catch(error){return Promise.reject(Object.assign(error,{status:400}));}
    if(typeof id!=='string'||!DEVICE_ID.test(id))return Promise.reject(Object.assign(Error('设备编号不正确'),{status:400}));
    const device=this.devices.get(id);
    if(this.pendingParameters.has(id))return Promise.reject(Object.assign(Error('该设备已有参数操作正在等待响应'),{status:409}));
    if(!this.parametersReady(device)||!this.client||this.client.connected===false||this.client.disconnecting)return Promise.reject(Object.assign(Error('设备不在线或尚未提供新参数令牌'),{status:503}));
    if(signal?.aborted)return Promise.reject(Object.assign(Error('参数操作已取消'),{status:409}));
    const sequence=this.parameterSequence=(this.parameterSequence+1)>>>0,cap=device.capability;
    const payload=parameters.envelope(cap.token,cap.uptimeMs,parameters.commandFrame(kind,sequence,values));
    device.consumedToken=cap.token;
    return new Promise((resolve,reject)=>{
      const pending={resolve,reject,sequence,token:cap.token,uptimeMs:cap.uptimeMs,signal,timer:null,onAbort:()=>this.cancelParameters(id,409,'登录或连接已变化，参数结果未知，请读取确认')};
      this.pendingParameters.set(id,pending);signal?.addEventListener('abort',pending.onAbort,{once:true});
      pending.timer=setTimeout(()=>this.cancelParameters(id,504,'参数响应超时，结果未知，请读取确认后再试'),kind==='flash'?this.flashTimeoutMs:this.parameterTimeoutMs);pending.timer.unref?.();
      try{this.client.publish(this.prefix+'/'+id+'/parameter-command',payload,{qos:0,retain:false},error=>{if(error&&this.pendingParameters.get(id)===pending)this.cancelParameters(id,503,'参数发送失败，结果未知，请读取确认');});}
      catch(_){this.cancelParameters(id,503,'参数发送失败，结果未知，请读取确认');}
      this.emit('state',this.state(id));
    });
  }
  refresh(){
    for(const device of this.devices.values()){
      const online=this.snapshot(device).online;
      if(!online)device.uplinkClock.reset();else device.uplinkClock.expire(this.monotonicNow());
      if(!this.parameterLive(device))this.cancelParameters(device.id,503,'设备数据已过期，参数结果未知，请读取确认');
      const parametersReady=this.parametersReady(device);
      if(online!==device.announcedOnline||parametersReady!==device.announcedParametersReady){device.announcedOnline=online;device.announcedParametersReady=parametersReady;this.emit('state',this.state(device.id));}
    }
  }
  stop(){
    if(this.stopped)return this.stopPromise;
    this.setBrokerConnected(false);this.stopped=true;
    clearInterval(this.timer);this.timer=null;
    this.client?.end(true);this.client=null;
    this.stopPromise=this.history.close();return this.stopPromise;
  }
  historyFor(id,options={}){return this.history.snapshot(id,options);}
  historySnapshot(id,options={}){return this.history.snapshot(id,options);}
  historyDeviceIds(){return this.history.deviceIds();}
}
module.exports={CloudBridge,validateTelemetry,DEVICE_ID};
