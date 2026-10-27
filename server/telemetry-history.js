/* 后台历史独立于浏览器：最新快照保留完整解码值，曲线/轨迹只采样船体和 RTK 摘要。 */
'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const DEVICE=/^[A-Za-z0-9_-]{1,64}$/,MAX_FILE_BYTES=32*1024*1024,MAX_TOTAL_POINTS=20000;
const BOOL={status:['sbusLinkValid','speedLoop','sbusFrameLost','sbusFailsafe','motor1Received','motor2Received','motor1Fresh','motor2Fresh'],motor:['received','displayValid','feedbackFresh','reverse'],velocity:['received','fresh','hasNavigation','fixValid','velocityValid','headingValid','timeAligned'],boat:['speedLoop','feedbackValid','hasHeading','headingValid','controlEnabled','sbusValid','motorsValid','reversing','received'],imu:['received','fresh','gyroValid','eulerValid','timeAligned','headingAvailable','headingFresh']};
const NUM={status:['version','messageType','length','statusFlags','sequence','timestampMs'],motor:['statusFlags','temperatureC','voltageV','currentA','capacityMah','electricalRpm','mechanicalRpm','targetRpm','appliedPwmX2','appliedPwmPercent','feedbackAgeMs','telemetrySequence'],velocity:['xMps','yMps','zRadps','ageMs','receivedMs','latitude','longitude','headingDegrees','sourceFlags'],boat:['controlMode','targetHeading','actualHeading','headingError','targetMps','actualMps','commonPercent','ageMs','requestedMps','turnPercent'],imu:['rollDegrees','pitchDegrees','yawDegrees','ageMs','receivedMs','sourceFlags']};
const integer=(value,fallback,min,max)=>Number.isInteger(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):fallback;
const clone=value=>JSON.parse(JSON.stringify(value));
function pick(source,type){
  if(!source||typeof source!=='object'||Array.isArray(source))return null;
  const result={};
  for(const key of BOOL[type])if(Object.hasOwn(source,key)){if(typeof source[key]!=='boolean'&&source[key]!==null)return null;result[key]=source[key];}
  for(const key of NUM[type])if(Object.hasOwn(source,key)){if(source[key]!==null&&(!Number.isFinite(source[key])||Math.abs(source[key])>0xffffffff))return null;result[key]=source[key];}
  if(type==='status'){
    if(!Number.isInteger(result.sequence)||!Number.isFinite(result.timestampMs)||!Array.isArray(source.motors)||source.motors.length!==2)return null;
    result.motors=source.motors.map(motor=>pick(motor,'motor'));if(result.motors.some(motor=>!motor||typeof motor.received!=='boolean'))return null;
  }else if(['velocity','boat','imu'].includes(type)){
    if(typeof result.received!=='boolean'||!Object.hasOwn(result,'ageMs'))return null;
    if(type==='velocity'&&(typeof result.fresh!=='boolean'||!Number.isFinite(result.xMps)||!Number.isFinite(result.yMps)))return null;
    if(type==='boat'&&(!Number.isFinite(result.targetMps)||!Number.isFinite(result.actualMps)||!Number.isInteger(result.controlMode)||result.controlMode<0||result.controlMode>2))return null;
    if(type==='imu'){if(!Array.isArray(source.gyroRadps)||source.gyroRadps.length!==3||source.gyroRadps.some(value=>!Number.isFinite(value)||Math.abs(value)>1000))return null;result.gyroRadps=source.gyroRadps.slice();}
  }
  return result;
}
function normalizeSample(sample,id,full=false){
  if(!sample||typeof sample!=='object'||sample.deviceId!==id||!DEVICE.test(id)||!Number.isFinite(sample.receivedAt)||sample.receivedAt<0||!sample.summary)return null;
  const velocity=pick(sample.summary.velocity,'velocity'),boat=pick(sample.summary.boat,'boat');if(!velocity||!boat)return null;
  const summary={velocity,boat};
  if(full){summary.status=pick(sample.summary.status,'status');summary.imu=pick(sample.summary.imu,'imu');if(!summary.status||!summary.imu)return null;}
  const result={deviceId:id,receivedAt:sample.receivedAt,summary};
  for(const key of ['ageMs','uplinkDelayMs','uplinkRttMs','uplinkUncertaintyMs'])if(Number.isFinite(sample[key])&&sample[key]>=0)result[key]=sample[key];
  return result;
}
class TelemetryHistory{
  constructor({file='',maxPoints=3600,sampleMs=1000,maxAgeMs=86400000,maxDevices=64,writeIntervalMs=10000,now=Date.now}={}){
    this.file=typeof file==='string'&&file.trim()?path.resolve(file):'';this.maxPoints=integer(maxPoints,3600,10,3600);this.sampleMs=integer(sampleMs,1000,100,60000);
    this.maxAgeMs=integer(maxAgeMs,86400000,60000,30*86400000);this.maxDevices=integer(maxDevices,64,1,64);this.writeIntervalMs=integer(writeIntervalMs,10000,10,60000);this.now=now;
    this.devices=new Map();this.writeTimer=null;this.writing=null;this.dirty=false;this.closed=false;this.storageError=null;this.lastSavedAt=null;this.blockedFile=false;this.lastPrunedAt=null;this.totalPoints=0;this.load();
  }
  load(){
    if(!this.file)return;
    try{
      const stat=fs.lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE_BYTES)throw Error('invalid-file');
      const value=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!value||value.version!==1||!Array.isArray(value.devices)||value.devices.length>64)throw Error('invalid-format');
      const loaded=new Map();
      for(const entry of value.devices){
        if(!entry||!DEVICE.test(entry.deviceId||'')||loaded.has(entry.deviceId)||!Array.isArray(entry.samples)||entry.samples.length>3600)throw Error('invalid-device');
        const latest=normalizeSample(entry.latest,entry.deviceId,true);if(!latest)throw Error('invalid-latest');
        const samples=entry.samples.map(sample=>normalizeSample(sample,entry.deviceId));if(samples.some(sample=>!sample)||samples.some((sample,index)=>index&&sample.receivedAt<samples[index-1].receivedAt))throw Error('invalid-samples');
        loaded.set(entry.deviceId,{latest,samples});
      }
      this.devices=loaded;this.prune();this.lastSavedAt=Number.isFinite(value.savedAt)?value.savedAt:null;
    }catch(error){if(error.code==='ENOENT')return;this.storageError='历史存储损坏或不可读取，请检查历史文件和权限后重启服务';this.blockedFile=true;}
  }
  prune(){
    const cutoff=this.now()-this.maxAgeMs;this.lastPrunedAt=this.now();
    for(const[id,entry]of this.devices){
      const count=entry.samples.length;entry.samples=entry.samples.filter(sample=>sample.receivedAt>=cutoff&&sample.receivedAt<=this.now()+60000).slice(-this.maxPoints);
      if(entry.latest.receivedAt<cutoff||entry.latest.receivedAt>this.now()+60000){this.devices.delete(id);this.dirty=true;}else if(count!==entry.samples.length)this.dirty=true;
    }
    while(this.devices.size>this.maxDevices){const oldest=[...this.devices.entries()].sort((a,b)=>a[1].latest.receivedAt-b[1].latest.receivedAt)[0];this.devices.delete(oldest[0]);this.dirty=true;}
    this.totalPoints=[...this.devices.values()].reduce((count,entry)=>count+entry.samples.length,0);this.trimTotal();
  }
  trimTotal(){
    while(this.totalPoints>MAX_TOTAL_POINTS){const oldest=[...this.devices.values()].filter(entry=>entry.samples.length).sort((a,b)=>a.samples[0].receivedAt-b.samples[0].receivedAt)[0];oldest.samples.shift();this.totalPoints--;this.dirty=true;}
  }
  record(message){
    if(this.closed)return false;const sample=normalizeSample(message,message?.deviceId,true);if(!sample)return false;
    let entry=this.devices.get(sample.deviceId);
    if(!entry){if(this.devices.size>=this.maxDevices){const oldest=[...this.devices.entries()].sort((a,b)=>a[1].latest.receivedAt-b[1].latest.receivedAt)[0];this.totalPoints-=oldest[1].samples.length;this.devices.delete(oldest[0]);}this.devices.set(sample.deviceId,entry={latest:sample,samples:[]});}else if(sample.receivedAt<entry.latest.receivedAt)return false;
    entry.latest=sample;const previous=entry.samples.at(-1),sampled=!previous||sample.receivedAt-previous.receivedAt>=this.sampleMs;
    if(sampled){entry.samples.push(normalizeSample(sample,sample.deviceId));this.totalPoints++;while(entry.samples.length>this.maxPoints||entry.samples[0]?.receivedAt<this.now()-this.maxAgeMs){entry.samples.shift();this.totalPoints--;}this.trimTotal();}
    this.dirty=true;if(this.lastPrunedAt===null||this.now()-this.lastPrunedAt>=10000)this.prune();this.scheduleWrite();return sampled;
  }
  snapshot(deviceId,{since=0,until=Infinity,limit=600}={}){
    this.prune();const entry=this.devices.get(deviceId),count=Math.min(this.maxPoints,integer(limit,600,1,3600));
    return{deviceId,latest:entry?clone(entry.latest):null,samples:entry?entry.samples.filter(sample=>sample.receivedAt>=since&&sample.receivedAt<=until).slice(-count).map(clone):[],recording:this.status()};
  }
  list(deviceId,options={}){return this.snapshot(deviceId,options).samples;}
  latest(deviceId){return this.snapshot(deviceId).latest;}
  deviceIds(){this.prune();return[...this.devices.keys()];}
  status(){return{sampleMs:this.sampleMs,maxPoints:this.maxPoints,maxAgeMs:this.maxAgeMs,persistent:!!this.file,storageError:this.storageError,lastSavedAt:this.lastSavedAt};}
  scheduleWrite(){
    if(!this.file||this.writeTimer||this.closed||this.blockedFile)return;
    this.writeTimer=setTimeout(()=>{this.writeTimer=null;this.flush();},this.writeIntervalMs);this.writeTimer.unref?.();
  }
  flush(){
    if(this.writing)return this.writing;if(!this.file||!this.dirty||this.blockedFile)return Promise.resolve();
    this.prune();this.dirty=false;
    const savedAt=this.now(),value={version:1,savedAt,devices:[...this.devices].map(([deviceId,entry])=>({deviceId,latest:entry.latest,samples:entry.samples}))};
    const raw=JSON.stringify(value),temporary=this.file+'.tmp-'+crypto.randomUUID();
    const write=async()=>{try{
      if(Buffer.byteLength(raw)>MAX_FILE_BYTES)throw Error('oversize');await fsp.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      await fsp.writeFile(temporary,raw,{mode:0o600,flag:'wx'});await fsp.rename(temporary,this.file);this.lastSavedAt=savedAt;this.storageError=null;
    }catch(_){this.dirty=true;this.storageError='历史数据暂未保存，请检查历史存储路径、空间和写入权限';await fsp.unlink(temporary).catch(()=>{});}};
    this.writing=write().finally(()=>{this.writing=null;if(this.dirty&&!this.closed)this.scheduleWrite();});return this.writing;
  }
  async close(){this.closed=true;clearTimeout(this.writeTimer);this.writeTimer=null;if(this.writing)await this.writing;if(this.dirty)await this.flush();}
}
function historyOptions(env=process.env,options={}){
  // 旧网页更新部署没有 StateDirectory，但 requests 已由受信安装器授权给网页服务写入。
  const fallback=env.STATE_DIRECTORY?path.join(String(env.STATE_DIRECTORY).split(path.delimiter)[0],'telemetry-history.json'):
    env.BOAT_UPDATE_ENABLED==='1'?path.join(env.BOAT_UPDATE_STATE_DIR||'/var/lib/unmanned-boat-web-update','requests','telemetry-history.json'):'';
  const file=options.file??(env.BOAT_TELEMETRY_HISTORY_FILE?.trim()||fallback);
  return{...options,file,maxPoints:options.maxPoints??env.BOAT_TELEMETRY_HISTORY_MAX_POINTS??3600,sampleMs:options.sampleMs??env.BOAT_TELEMETRY_HISTORY_SAMPLE_MS??1000,maxAgeMs:options.maxAgeMs??env.BOAT_TELEMETRY_HISTORY_MAX_AGE_MS??86400000};
}
module.exports={TelemetryHistory,historyOptions,normalizeSample};
