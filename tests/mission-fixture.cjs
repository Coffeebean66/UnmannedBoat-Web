/* 本地模拟船：使用真实 CloudBridge、BPC1/BDC1 解析和任务执行器，不连接任何实际设备。 */
'use strict';
const {EventEmitter}=require('node:events'),fs=require('node:fs'),path=require('node:path');
const {CloudBridge}=require('../server/cloud'),{ControlService}=require('../server/control-service'),{MissionStore}=require('../server/mission-store'),{MissionService}=require('../server/mission-service');
const U=require('../public/utils/uart4Protocol'),P=require('../server/parameter-protocol');
const {createServer}=require('../server');
const NAV=require('../public/utils/missionNavigation');
const TOKEN='0123456789abcdef',CLIENT='1122334455667788';
const ENV={BOAT_CLOUD_ENABLED:'1',BOAT_CLOUD_PASSWORD:'mission-legacy-test-only',BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'browser-admin-test-only',BOAT_GUEST_USERNAME:'observer',BOAT_GUEST_PASSWORD:'browser-guest-test-only',BOAT_AMAP_KEY:'',BOAT_AMAP_SECURITY_CODE:''};
const ORIGIN={latitude:31.23,longitude:121.47};
function createMissionFixture(options={}){
  const out=path.resolve(__dirname,'../.test-output');fs.mkdirSync(out,{recursive:true});const dir=fs.mkdtempSync(path.join(out,'mission-state-'));
  let time=10000,sequence=0,capSequence=0,feedTimer;const now=options.realClock?Date.now:()=>time;
  const env={...ENV,BOAT_MISSION_FILE:path.join(dir,'missions.json'),BOAT_ACCOUNTS_FILE:path.join(dir,'accounts.json'),BOAT_MAP_CONFIG_FILE:path.join(dir,'map.json'),...options.env};
  class MQTT extends EventEmitter{
    constructor(){super();this.connected=true;this.sent=[];}
    subscribe(topics,opts,callback){callback(null,topics.map(topic=>({topic,qos:0})));}
    publish(topic,payload,opts,callback){const packet={topic,payload:Buffer.from(payload),opts};this.sent.push(packet);callback?.();onPublish(packet);}
    end(){}
  }
  const client=new MQTT(),bridge=new CloudBridge({env,connect:()=>client,now,tickMs:options.realClock?1000:60000});
  const control=new ControlService({bridge,now,pollMs:options.realClock?50:60000}),store=new MissionStore({env,now});
  const mission=new MissionService({bridge,control,store,now,pollMs:options.realClock?100:60000,...options.missionOptions});
  const states=new Map(),positions=new Map(),flags=new Map();let autoAck=options.autoAck!==false,paramReply=true,parameterDelay=0;
  const values=Object.fromEntries(Object.entries(P.RANGES).map(([key,[min]])=>[key,min]));values.maxTargetMmS=2500;
  function state(id){if(!states.has(id))states.set(id,{version:1,token:TOKEN,uptimeMs:now()>>>0,state:0,leaseId:'0000000000000000',sequence:0,mode:2,reason:0,enabled:true,timeoutMs:500,testMode:false});return states.get(id);}
  function publish(id,kind,payload){return bridge.acceptMessage('boats/'+id+'/'+kind,Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload)));}
  function ack(packet=client.sent.at(-1),extra={}){
    const id=packet.topic.split('/')[1],b=packet.payload,action=b[28];
    const s=state(id);Object.assign(s,{uptimeMs:now()>>>0,token:b.subarray(4,12).toString('hex'),leaseId:b.subarray(16,24).toString('hex'),sequence:b.readUInt32LE(24),mode:b[29],state:action<=2?1:2,reason:action===4?3:action===3?2:0},extra);publish(id,'control-state',s);return s;
  }
  function onPublish(packet){
    if(packet.topic.endsWith('/control-command')&&autoAck){queueMicrotask(()=>ack(packet));}
    if(packet.topic.endsWith('/parameter-command')&&packet.payload.toString('ascii',0,4)==='BPC1'&&paramReply){
      const respond=()=>{const b=packet.payload,id=packet.topic.split('/')[1],seq=b.readUInt32LE(22);const frame=Buffer.from(U.encodeParameterWriteRequest(seq,values));frame[3]=0x90;frame[5]=0;frame.writeUInt16LE(U.crc16CcittFalse(frame,2,52),54);publish(id,'parameter-response',P.envelope(b.subarray(4,12).toString('hex'),b.readUInt32LE(12),frame));};
      if(parameterDelay)setTimeout(respond,parameterDelay);else queueMicrotask(respond);
    }
  }
  function feed(id='boat-01',overrides={}){
    positions.set(id,{...(positions.get(id)||ORIGIN),...overrides});const p=positions.get(id),o=flags.get(id)||{};sequence++;
    const frames=[];for(const [type,size,version,flag]of [[1,64,1,0xf3],[2,40,2,3],[3,36,2,47],[4,36,1,3]]){
      const b=Buffer.alloc(size);b.set([0xa5,0x5a,version,type,size,flag]);b.writeUInt32LE(sequence,6);b.writeUInt32LE(now()>>>0,10);
      if(type===1)for(const base of [14,38]){b[base]=7;b.writeUInt16LE(2450,base+2);b.writeUInt16LE(5,base+20);}
      if(type===2){b.writeInt16LE(1000,16);b.writeUInt16LE(o.age??0,20);b.writeUInt32LE(p.sourceTick??(now()>>>0),22);b.writeInt32LE(Math.round(p.latitude*1e7),26);b.writeInt32LE(Math.round(p.longitude*1e7),30);b.writeUInt16LE(Math.round((p.heading??0)*100),34);b[36]=o.fix===false?6:7;}
      if(type===3){b[5]=o.motors===false?39:47;b[32]=state(id).mode;b[33]=o.heading===false?2:3;b.writeUInt16LE(1000,16);b.writeUInt16LE(o.age??0,20);b.writeUInt16LE(Math.round((p.heading??0)*100),28);}
      b.writeUInt16LE(U.crc16CcittFalse(b,2,size-4),size-2);frames.push(b);
    }
    publish(id,'telemetry',Buffer.concat(frames));const s=state(id);s.uptimeMs=now()>>>0;publish(id,'control-state',s);
    publish(id,'parameter-capability',{version:1,token:(++capSequence).toString(16).padStart(16,'0'),uptimeMs:now()>>>0});
  }
  bridge.start();client.emit('connect');feed();
  let server;
  if(options.server)server=createServer({cloud:bridge,env,accountOptions:{storeFile:path.join(dir,'accounts.json')},controlOptions:{service:control},missionOptions:{store,service:mission}});
  if(options.realClock)feedTimer=setInterval(()=>{for(const id of positions.keys())feed(id);},100);
  return {bridge,client,control,mission,store,server,env,dir,now,positions,flags,values,feed,ack,publish,
    get autoAck(){return autoAck;},set autoAck(v){autoAck=v;},get parameterDelay(){return parameterDelay;},set parameterDelay(v){parameterDelay=v;},set paramReply(v){paramReply=v;},
    advance(ms=100,id='boat-01',p={}){time+=ms;feed(id,p);control.refresh();mission.refresh();},
    route(id='boat-01',overrides={}){return store.save(id,{name:'湖区巡航',speedMps:1,arrivalRadiusM:3,points:[ORIGIN,NAV.destination(ORIGIN,0,30),NAV.destination(ORIGIN,90,45)],...overrides});},
    commands(){return client.sent.filter(p=>p.topic.endsWith('/control-command'));},
    async close(){clearInterval(feedTimer);if(server?.listening)await new Promise(resolve=>server.close(resolve));else{mission.close();control.close();await bridge.stop();}fs.rmSync(dir,{recursive:true,force:true});}
  };
}
module.exports={createMissionFixture,ORIGIN,TOKEN,CLIENT,ENV};
