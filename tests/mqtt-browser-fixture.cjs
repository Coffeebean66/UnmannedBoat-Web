/* 浏览器通过真实本地账户 API / SSE 接收模拟船端的完整 MQTT 遥测包。 */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {createServer}=require('../server'),P=require('../public/utils/uart4Protocol');
const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/parameter-data.js'),'utf8'),context);
const defaults={...context.window.BoatParameters.tuning,turnAtFullSpeedPercent:50,motor1Reversed:0,motor2Reversed:1,headingKpX100:200,headingKiX100:0,headingKdX100:0,headingIntegralLimitX2:30,headingOutputLimitX2:60,headingDeadbandCdeg:200,headingReversed:0};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function createFixtureServer(options={}){
  const fixture={overrides:{},values:{...defaults},sequence:0,running:true,replyStatus:0,suppressReply:false,calls:[]};
  const bridge=new EventEmitter(),id='boat-mqtt-test';let timer;
  const frame=(type,size,version,flags)=>{const b=Buffer.alloc(size);b.set([0xa5,0x5a,version,type,size,flags]);b.writeUInt32LE(fixture.sequence,6);b.writeUInt32LE(fixture.sequence*100,10);return b;};
  const finish=b=>{b.writeUInt16LE(P.crc16CcittFalse(b,2,b.length-4),b.length-2);return b;};
  function feed(){
    const o=fixture.overrides;fixture.sequence++;const frames=[];
    let b=frame(1,64,1,0xf3);
    for(const base of [14,38]){b[base]=7;b[base+1]=32;b.writeUInt16LE(2450,base+2);b.writeUInt16LE(1230,base+4);b.writeUInt32LE(1500,base+12);b.writeUInt32LE(10500,base+8);b.writeInt16LE(120,base+18);b.writeUInt16LE(10,base+20);}frames.push(finish(b));
    b=frame(2,40,2,3);b.writeInt16LE(Math.round((o.x??1.5)*1000),14);b.writeInt16LE(Math.round((o.y??.4)*1000),16);b.writeUInt16LE(o.skipVelocity?1000:20,20);b.writeInt32LE(311234567+fixture.sequence*160,26);b.writeInt32LE(1217654321,30);b.writeUInt16LE(Math.round((o.rtkHeading??359)*100),34);b[36]=o.rtkFlags??15;frames.push(finish(b));
    b=frame(3,36,2,47);b.writeInt16LE(Math.round((o.target??1.8)*1000),14);b.writeUInt16LE(1552,16);b.writeInt16LE(120,18);b.writeUInt16LE(20,20);b.writeInt16LE(2000,22);b.writeUInt16LE(Math.round((o.targetHeading??1)*100),26);b.writeUInt16LE(Math.round((o.actualHeading??359)*100),28);b.writeInt16LE(200,30);b[32]=o.skipBoat?0:o.mode??2;b[33]=o.headingFlags??3;frames.push(finish(b));
    b=frame(4,36,1,3);b.writeInt16LE(120,14);b.writeInt16LE(Math.round((o.roll??6)*100),20);b.writeInt16LE(Math.round((o.pitch??-4)*100),22);b.writeInt16LE(Math.round((o.yaw??32)*100),24);b.writeUInt16LE(o.skipImu?1000:o.imuAge??20,26);b[32]=o.imuFlags??127;frames.push(finish(b));
    bridge.emit('telemetry',{deviceId:id,receivedAt:Date.now(),ageMs:0,payload:Buffer.concat(frames).toString('base64')});
  }
  Object.assign(bridge,{enabled:true,start(){timer=setInterval(()=>{if(fixture.running)feed();},100);},stop(){clearInterval(timer);},
    list:()=>({brokerConnected:true,devices:[{id,online:true,parametersReady:true}]}),state:()=>({brokerConnected:true,device:{id,online:true,parametersReady:true}}),
    async requestParameters(deviceId,kind,values){
      fixture.calls.push({deviceId,kind,values});await wait(100);
      if(fixture.suppressReply)throw Object.assign(Error('设备响应超时，结果未知，请读取确认'),{status:504});
      if(kind==='write'&&fixture.replyStatus===0)fixture.values={...values};
      const bytes=P.encodeParameterWriteRequest(321,fixture.values);bytes[3]=0x90;bytes[5]=fixture.replyStatus;new DataView(bytes.buffer).setUint16(54,P.crc16CcittFalse(bytes,2,52),true);return Buffer.from(bytes);
    }});
  const server=createServer({...options,cloud:bridge,env:{...process.env,BOAT_CLOUD_ENABLED:'1',BOAT_CLOUD_PASSWORD:'mqtt-browser-legacy-test-only',BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'browser-admin-test-only',BOAT_GUEST_USERNAME:'observer',BOAT_GUEST_PASSWORD:'browser-guest-test-only',BOAT_AMAP_KEY:'',BOAT_AMAP_SECURITY_CODE:'',...options.env}});
  const handler=server.listeners('request')[0];server.removeListener('request',handler);
  server.on('request',(req,res)=>{
    if(req.url!=='/__test/mqtt')return handler(req,res);
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      try{const input=JSON.parse(body||'{}');fixture.overrides=input.overrides??fixture.overrides;if('replyStatus'in input)fixture.replyStatus=input.replyStatus;if('suppressReply'in input)fixture.suppressReply=input.suppressReply;if(input.action==='start')fixture.running=true;if(input.action==='stop')fixture.running=false;if(input.action==='feed'||input.action==='start')feed();res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({calls:fixture.calls.length}));}
      catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}));}
    });
  });
  server.mqttFixture=fixture;return server;
}
const fixtureScript='('+function(){
  Object.defineProperty(navigator,'bluetooth',{configurable:true,value:undefined});
  window.telemetryOverrides={};window.testConnections=0;window.testWrites=[];window.replyStatus=0;window.suppressReply=false;
  const originalFetch=window.fetch.bind(window),OriginalEventSource=window.EventSource;
  window.EventSource=class extends OriginalEventSource{constructor(...args){super(...args);window.testConnections++;}};
  const control=async action=>{const response=await originalFetch('/__test/mqtt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,overrides:window.telemetryOverrides,replyStatus:window.replyStatus,suppressReply:window.suppressReply})});return response.json();};
  window.feedTelemetry=()=>control('feed');window.startTelemetry=()=>control('start');window.stopTelemetry=()=>control('stop');
  window.fetch=async(url,options)=>{if(String(url)==='/api/cloud/parameters'){const input=JSON.parse(options.body);window.lastCommand={read:0x10,write:0x11,flash:0x12}[input.kind];window.testWrites.push(input);await control('config');}return originalFetch(url,options);};
  const until=async check=>{for(let n=0;n<200;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('MQTT test fixture connection timed out');};
  window.ensureTestLogin=async()=>{
    await until(()=>window.BoatAuth?.ready&&window.boatMonitor?.link.configurationKnown);
    if(BoatAuth.enabled===true&&!BoatAuth.user){document.getElementById('accountUsername').value='operator';document.getElementById('accountPassword').value='browser-admin-test-only';document.getElementById('accountLoginForm').requestSubmit();await until(()=>BoatAuth.canManage&&!BoatAuth.busy);}
    else if(BoatAuth.enabled===false&&!boatMonitor.link.authenticated)await boatMonitor.link.login('mqtt-browser-legacy-test-only');
    await until(()=>!!document.getElementById('cloudDevice').value&&(boatMonitor.link.wanted||!document.getElementById('connectButton').disabled));
  };
  window.connectTestBoat=async()=>{await ensureTestLogin();await startTelemetry();if(!boatMonitor.link.wanted)document.getElementById('connectButton').click();await until(()=>boatMonitor.link.connected);};
}.toString()+')();';
module.exports={createFixtureServer,fixtureScript};
