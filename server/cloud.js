/* 网口遥测与有确认的参数事务：只发送单次参数命令，不发送航行控制指令。 */
'use strict';
const {EventEmitter}=require('node:events');
const crypto=require('node:crypto');
const protocol=require('../public/utils/uart4Protocol');
const parameters=require('./parameter-protocol');
const DEVICE_ID=/^[A-Za-z0-9_-]{1,64}$/;
const LAYOUT=[
  [0,64,1,1,protocol.decodeFrame],
  [64,40,2,2,protocol.decodeVelocityFrame],
  [104,36,2,3,protocol.decodeBoatFrame],
  [140,36,1,4,protocol.decodeImuFrame]
];

function validateTelemetry(payload){
  if(!Buffer.isBuffer(payload)||payload.length!==176)return false;
  return LAYOUT.every(([offset,length,version,type,decode])=>{
    const frame=payload.subarray(offset,offset+length);
    return frame[2]===version&&frame[3]===type&&frame[4]===length&&!!decode(frame);
  });
}

class CloudBridge extends EventEmitter {
  constructor({env=process.env,connect,now=Date.now,maxDevices=64,staleMs=3000,tickMs=1000,parameterFreshMs=2500,parameterTimeoutMs=5000,flashTimeoutMs=20000}={}){
    super();
    this.enabled=env.BOAT_CLOUD_ENABLED==='1';
    this.env=env;this.connect=connect;this.now=now;this.maxDevices=maxDevices;
    this.staleMs=staleMs;this.tickMs=tickMs;this.devices=new Map();
    this.parameterFreshMs=parameterFreshMs;this.parameterTimeoutMs=parameterTimeoutMs;this.flashTimeoutMs=flashTimeoutMs;this.pendingParameters=new Map();this.parameterSequence=crypto.randomBytes(4).readUInt32LE();
    this.brokerConnected=false;this.client=null;this.timer=null;this.stopped=false;this.generation=0;
    this.prefix=env.BOAT_MQTT_TOPIC_PREFIX||'boats';
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(this.prefix))throw Error('Invalid BOAT_MQTT_TOPIC_PREFIX');
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
    if(!connected)for(const device of this.devices.values()){device.live=false;device.capability=null;this.cancelParameters(device.id,503,'云端连接已断开，参数结果未知，请读取确认');}
    this.emit('state',{brokerConnected:connected,device:null});
  }
  snapshot(device){
    return {id:device.id,online:!!(this.brokerConnected&&device.live&&device.status!=='offline'&&
      device.lastReceivedAt!==null&&this.now()-device.lastReceivedAt<=this.staleMs),
      lastReceivedAt:device.lastReceivedAt,status:device.status,lastStatusAt:device.lastStatusAt,parametersReady:this.parametersReady(device)};
  }
  list(){return {brokerConnected:this.brokerConnected,devices:[...this.devices.values()].map(device=>this.snapshot(device))};}
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
    const device={id,lastReceivedAt:null,status:'unknown',lastStatusAt:null,live:false,announcedOnline:false,announcedParametersReady:false,capability:null,consumedToken:null};
    this.devices.set(id,device);return device;
  }
  acceptMessage(topic,payload,packet={}){
    if(this.stopped||!this.enabled||!this.brokerConnected||typeof topic!=='string'||!Buffer.isBuffer(payload))return false;
    const parts=topic.split('/');
    if(parts.length!==3||parts[0]!==this.prefix||!DEVICE_ID.test(parts[1]))return false;
    if(parts[2]==='telemetry'){
      if(packet.retain||!validateTelemetry(payload))return false;
      const device=this.obtain(parts[1]);if(!device)return false;
      device.lastReceivedAt=this.now();device.live=true;
      // 新遥测证明设备已上线，避免旧的 retained offline 覆盖本次连接。
      if(device.status==='offline')device.status='unknown';
      device.announcedOnline=true;
      this.emit('state',this.state(device.id));
      this.emit('telemetry',{deviceId:device.id,receivedAt:device.lastReceivedAt,payload:payload.toString('base64'),ageMs:0});
      return true;
    }
    if(parts[2]==='status'&&payload.length<=7){
      const value=payload.toString('utf8');if(!['online','offline'].includes(value))return false;
      const device=this.obtain(parts[1]);if(!device)return false;
      device.status=value;device.lastStatusAt=this.now();
      if(value==='offline'){device.live=false;device.capability=null;this.cancelParameters(device.id,503,'设备已离线，参数结果未知，请读取确认');}
      this.emit('state',this.state(device.id));return true;
    }
    if(parts[2]==='parameter-capability'){
      if(packet.retain)return false;const value=parameters.capability(payload);if(!value)return false;
      const device=this.obtain(parts[1]);if(!device)return false;const previous=device.capability;
      if(previous&&(previous.token!==value.token||value.uptimeMs<previous.uptimeMs))this.cancelParameters(device.id,409,'设备参数令牌已变化，结果未知，请读取确认');
      device.capability={...value,receivedAt:this.now()};this.emit('state',this.state(device.id));return true;
    }
    if(parts[2]==='parameter-response'){
      if(packet.retain)return false;const value=parameters.response(payload),pending=this.pendingParameters.get(parts[1]);
      if(!value||!pending||value.token!==pending.token||value.uptimeMs!==pending.uptimeMs||value.sequence!==pending.sequence)return false;
      const device=this.devices.get(parts[1]);if(!this.parameterLive(device)){this.cancelParameters(parts[1],503,'设备数据已过期，参数结果未知，请读取确认');return false;}
      this.finishParameters(parts[1],null,value.frame);return true;
    }
    return false;
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
      if(!this.parameterLive(device))this.cancelParameters(device.id,503,'设备数据已过期，参数结果未知，请读取确认');
      const parametersReady=this.parametersReady(device);
      if(online!==device.announcedOnline||parametersReady!==device.announcedParametersReady){device.announcedOnline=online;device.announcedParametersReady=parametersReady;this.emit('state',this.state(device.id));}
    }
  }
  stop(){
    if(this.stopped)return;
    this.setBrokerConnected(false);this.stopped=true;
    clearInterval(this.timer);this.timer=null;
    this.client?.end(true);this.client=null;
  }
}
module.exports={CloudBridge,validateTelemetry,DEVICE_ID};
