/* 网口遥测、参数/OTA事务及独立短时驾驶通道；各船维护互斥资源。 */
'use strict';
const {EventEmitter}=require('node:events');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const protocol=require('../public/utils/uart4Protocol');
const parameters=require('./parameter-protocol');
const {unwrapTelemetry,isSyncResponse,UplinkClock}=require('./latency-protocol');
const {decodeVideoDescriptor}=require('./video-protocol');
const {TelemetryHistory,historyOptions}=require('./telemetry-history');
const firmware=require('./firmware-protocol');
const control=require('./control-protocol');
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
    this.firmwareLocks=new Set();this.firmwareSubscribed=false;this.controlLocks=new Set();this.controlSubscribed=false;
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
        // 驾驶主题授权独立于原监测链路，旧 ACL 缺少驾驶规则时仍可监测。
        try{
          this.client.subscribe(['control-capability','control-state'].map(kind=>this.prefix+'/+/'+kind),{qos:0,rap:true},(error,granted)=>{
            if(this.stopped||generation!==this.generation)return;
            this.controlSubscribed=!error&&!granted?.some(subscription=>subscription.qos>=128);
          });
        }catch(_){this.controlSubscribed=false;}
        // 未配置 OTA 的旧部署不增加订阅；新增 ACL 不可用时不影响原遥测/参数主题。
        if(firmware.keyFrom(this.env.BOAT_OTA_KEY))try{
          this.client.subscribe(['firmware-capability','firmware-response'].map(kind=>this.prefix+'/+/'+kind),{qos:0,rap:true},(error,granted)=>{
            if(this.stopped||generation!==this.generation)return;
            this.firmwareSubscribed=!error&&!granted?.some(subscription=>subscription.qos>=128);
          });
        }catch(_){this.firmwareSubscribed=false;}
      });
    });
    for(const event of ['offline','close','disconnect','error'])this.client.on(event,()=>{this.generation++;this.setBrokerConnected(false);});
    this.client.on('message',(topic,payload,packet)=>this.acceptMessage(topic,payload,packet));
    this.timer=setInterval(()=>this.refresh(),this.tickMs);this.timer.unref?.();
  }
  setBrokerConnected(connected){
    if(this.stopped||this.brokerConnected===connected)return;
    this.brokerConnected=connected;
    if(!connected){this.firmwareSubscribed=false;this.controlSubscribed=false;}
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
      const offline=[...this.devices.values()].filter(device=>!this.snapshot(device).online&&!this.firmwareLocks.has(device.id)&&!this.controlLocks.has(device.id))
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
    if(parts[2]==='control-capability'||parts[2]==='control-state'){
      if(packet.retain||!control.status(payload)||!this.obtain(parts[1]))return false;
      // ACK/能力不代替遥测在线，也不持久化成历史控制指令。
      this.emit(parts[2],{deviceId:parts[1],payload:Buffer.from(payload)});return true;
    }
    if(parts[2]==='firmware-capability'||parts[2]==='firmware-response'){
      if(packet.retain)return false;
      let directoryChanged=false;
      if(parts[2]==='firmware-capability'){
        if(!firmware.capability(payload))return false;
        directoryChanged=!this.devices.has(parts[1]);
        const device=this.obtain(parts[1]);if(!device)return false;
        // 当前 MCU 的非 retained 能力撤销旧离线标记，但不伪造传感器遥测在线时间。
        if(device.status==='offline'){device.status='unknown';directoryChanged=true;}
      }else if(!firmware.response(payload))return false;
      // OTA 能力与 ACK 不延长遥测在线时间，不进入参数事务或遥测历史。
      this.emit(parts[2],{deviceId:parts[1],payload:Buffer.from(payload)});
      if(directoryChanged)this.emit('state',this.state(parts[1]));return true;
    }
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
  parametersReady(device){return !!(this.parameterLive(device)&&device.capability.token!==device.consumedToken&&!this.pendingParameters.has(device.id)&&!this.firmwareLocks.has(device.id)&&!this.controlLocks.has(device.id));}
  claimFirmware(id){
    if(!DEVICE_ID.test(id)||!this.devices.has(id))throw Object.assign(Error('无人船不存在'),{status:404});
    if(this.firmwareLocks.has(id)||this.pendingParameters.has(id)||this.controlLocks.has(id))throw Object.assign(Error('该船正在驾驶、调参或升级，请先停船并等待操作完成'),{status:409});
    if(!this.brokerConnected||!this.firmwareSubscribed||!this.client||this.client.connected===false||this.client.disconnecting)throw Object.assign(Error('OTA MQTT通道未就绪，请检查设备和主题权限'),{status:503});
    this.firmwareLocks.add(id);this.emit('state',this.state(id));
  }
  releaseFirmware(id){if(this.firmwareLocks.delete(id))this.emit('state',this.state(id));}
  claimControl(id){
    if(!DEVICE_ID.test(id)||!this.devices.has(id))throw Object.assign(Error('无人船不存在'),{status:404});
    if(this.controlLocks.has(id)||this.firmwareLocks.has(id)||this.pendingParameters.has(id))throw Object.assign(Error('该船正在驾驶、调参或升级，请等待操作完成'),{status:409});
    if(!this.brokerConnected||!this.controlSubscribed||!this.client||this.client.connected===false||this.client.disconnecting)throw Object.assign(Error('驾驶MQTT通道未就绪，请检查主题权限'),{status:503});
    this.controlLocks.add(id);this.emit('state',this.state(id));
  }
  releaseControl(id){if(this.controlLocks.delete(id))this.emit('state',this.state(id));}
  publishControl(id,payload){
    if(!DEVICE_ID.test(id)||!Buffer.isBuffer(payload)||payload.length!==40||payload.toString('ascii',0,4)!=='BDC1'||!this.controlLocks.has(id)||!this.brokerConnected||!this.controlSubscribed||!this.client||this.client.connected===false||this.client.disconnecting)
      return Promise.reject(Object.assign(Error('驾驶通道已断开'),{status:503}));
    return new Promise((resolve,reject)=>{try{this.client.publish(this.prefix+'/'+id+'/control-command',payload,{qos:0,retain:false},error=>error?reject(Object.assign(Error('驾驶指令发送失败'),{status:503})):resolve());}catch(_){reject(Object.assign(Error('驾驶指令发送失败'),{status:503}));}});
  }
  publishFirmware(id,payload){
    if(!DEVICE_ID.test(id)||!Buffer.isBuffer(payload)||payload.length>296||!this.firmwareLocks.has(id)||!this.brokerConnected||!this.firmwareSubscribed||!this.client||this.client.connected===false||this.client.disconnecting)
      return Promise.reject(Object.assign(Error('OTA通道已断开'),{status:503}));
    return new Promise((resolve,reject)=>{try{this.client.publish(this.prefix+'/'+id+'/firmware-command',payload,{qos:0,retain:false},error=>error?reject(Object.assign(Error('OTA发送失败'),{status:503})):resolve());}catch(_){reject(Object.assign(Error('OTA发送失败'),{status:503}));}});
  }
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
    if(this.controlLocks.has(id))return Promise.reject(Object.assign(Error('该船正在网页驾驶，请先停止并释放操控'),{status:409}));
    if(this.firmwareLocks.has(id))return Promise.reject(Object.assign(Error('该船正在升级固件，暂不能调参'),{status:409}));
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
