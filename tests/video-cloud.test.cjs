'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {EventEmitter}=require('node:events');
const {CloudBridge}=require('../server/cloud'),{createServer}=require('../server');
const P=require('../public/utils/uart4Protocol');
const ORIGIN='https://video-platform.test',PASSWORD='video-test-password-fixture';
const ENV={BOAT_CLOUD_ENABLED:'1',BOAT_CLOUD_PASSWORD:PASSWORD,BOAT_CLOUD_ORIGIN:ORIGIN,BOAT_VIDEO_ALLOWED_ORIGINS:'https://video.test'};
const descriptor=(url='https://video.test/live/boat-01.m3u8',format='hls')=>Buffer.from(JSON.stringify({version:1,url,format,title:'船载摄像头'}));
const clear=()=>Buffer.from(JSON.stringify({version:1,enabled:false}));
class MQTT extends EventEmitter{
  subscribe(topics,options,callback){(this.subscriptions??=[]).push({topics,options});callback(null);}
  publish(){this.published=true;}
  end(){}
}
function fixture(t,options={}){
  let time=10000;const client=new MQTT(),bridge=new CloudBridge({env:ENV,connect:()=>client,now:()=>time,tickMs:60000,...options});
  bridge.start();client.emit('connect');t.after(()=>bridge.stop());
  return {bridge,client,setTime:value=>{time=value;},now:()=>time};
}
function telemetry(){
  const data=Buffer.alloc(176);
  for(const [offset,length,version,type]of [[0,64,1,1],[64,40,2,2],[104,36,2,3],[140,36,1,4]]){
    const frame=data.subarray(offset,offset+length);frame.set([0xa5,0x5a,version,type,length,3]);
    frame.writeUInt16LE(P.crc16CcittFalse(frame,2,length-4),length-2);
  }
  return data;
}

test('桥接订阅视频配置，按设备隔离并提供快照；配置不伪造遥测在线状态',t=>{
  const f=fixture(t),states=[];f.bridge.on('state',state=>states.push(state));
  assert.deepEqual(f.client.subscriptions.map(item=>item.topics),[
    ['boats/+/telemetry','boats/+/status','boats/+/parameter-capability','boats/+/parameter-response'],
    ['boats/+/video'],
    ['boats/+/control-capability','boats/+/control-state']
  ]);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/video',descriptor(),{retain:true}),true);
  assert.equal(f.bridge.acceptMessage('boats/boat-02/video',descriptor('https://video.test/live/boat-02.flv','flv')),true);
  const a=f.bridge.get('boat-01'),b=f.bridge.get('boat-02');
  assert.equal(a.online,false);assert.equal(a.lastReceivedAt,null);assert.equal(a.parametersReady,false);
  assert.equal(a.video.retained,true);assert.equal(a.video.receivedAt,10000);assert.match(a.video.url,/boat-01/);
  assert.match(b.video.url,/boat-02/);assert.equal(b.video.format,'flv');assert.equal(states.length,2);
  assert.equal(f.bridge.fleetList().devices[0].summary,null);assert.equal(f.client.published,undefined);
  a.video.url='https://wrong.test/';assert.match(f.bridge.get('boat-01').video.url,/boat-01/);
});

test('视频发布不延长传感器/参数期限，离线和Broker重连保留地址但不恢复船端在线',t=>{
  const f=fixture(t);f.bridge.acceptMessage('boats/boat-01/telemetry',telemetry());
  f.bridge.acceptMessage('boats/boat-01/parameter-capability',Buffer.from(JSON.stringify({version:1,token:'0123456789abcdef',uptimeMs:1})));
  assert.equal(f.bridge.get('boat-01').parametersReady,true);
  const before=f.bridge.devices.get('boat-01'),capability=before.capability,lastReceivedAt=before.lastReceivedAt;
  f.setTime(14000);f.bridge.acceptMessage('boats/boat-01/video',descriptor());
  const after=f.bridge.get('boat-01');assert.equal(after.online,false);assert.equal(after.parametersReady,false);assert.equal(after.lastReceivedAt,lastReceivedAt);
  assert.equal(before.capability,capability);assert.equal(before.capability.receivedAt,10000);
  f.client.emit('close');assert.ok(f.bridge.get('boat-01').video);f.client.emit('connect');
  assert.equal(f.bridge.get('boat-01').online,false);assert.ok(f.bridge.get('boat-01').video);
});

test('无效视频包不建船或覆盖已确认地址，清空不会制造不存在的船',t=>{
  const f=fixture(t);assert.equal(f.bridge.acceptMessage('boats/missing/video',clear()),true);assert.equal(f.bridge.list().devices.length,0);
  for(const [topic,payload]of [['boats/boat-01/video',Buffer.alloc(5000)],['boats/invalid.id/video',descriptor()],['boats/boat-01/video/extra',descriptor()],['boats/boat-01/video',Buffer.from('{bad')]])assert.equal(f.bridge.acceptMessage(topic,payload),false);
  assert.equal(f.bridge.list().devices.length,0);f.bridge.acceptMessage('boats/boat-01/video',descriptor());
  assert.equal(f.bridge.acceptMessage('boats/boat-01/video',Buffer.from(JSON.stringify({version:1,url:'javascript:alert(1)'}))),false);
  assert.match(f.bridge.get('boat-01').video.url,/boat-01/);
  assert.equal(f.bridge.acceptMessage('boats/boat-01/video',clear(),{retain:true}),true);assert.equal(f.bridge.get('boat-01').video,null);
});

test('视频遵守自定义主题前缀、设备上限和停用状态',t=>{
  const f=fixture(t,{maxDevices:2,env:{...ENV,BOAT_MQTT_TOPIC_PREFIX:'fleet'}});
  assert.deepEqual(f.client.subscriptions[1].topics,['fleet/+/video']);assert.equal(f.bridge.acceptMessage('boats/boat-01/video',descriptor()),false);
  for(const id of ['one','two'])f.bridge.acceptMessage('fleet/'+id+'/telemetry',telemetry());
  assert.equal(f.bridge.acceptMessage('fleet/three/video',descriptor()),false);assert.equal(f.bridge.list().devices.length,2);
  f.bridge.stop();assert.equal(f.bridge.acceptMessage('fleet/one/video',descriptor()),false);
});

function call(port,route,{method='GET',body,cookie}={}){
  const data=body===undefined?undefined:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{origin:ORIGIN,...(cookie?{cookie}:{}),...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{})}},res=>{
      let raw='';res.on('data',chunk=>{raw+=chunk;});res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,json:JSON.parse(raw)}));
    });req.on('error',reject);req.end(data);
  });
}
function stream(port,cookie,id){
  return new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:'/api/cloud/events?device='+id,agent:false,headers:{cookie}},res=>{
      const item={req,res,events:[]};let raw='';
      res.on('data',chunk=>{raw+=chunk;let boundary;while((boundary=raw.indexOf('\n\n'))>=0){const part=raw.slice(0,boundary);raw=raw.slice(boundary+2);const event=part.match(/^event: (.+)$/m),data=part.match(/^data: (.+)$/m);if(event&&data)item.events.push({event:event[1],data:JSON.parse(data[1])});}});
      resolve(item);
    });req.on('error',reject);
  });
}
async function until(predicate){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error('Video stream timeout');await new Promise(resolve=>setTimeout(resolve,5));}}

test('已有认证HTTP/SSE提供视频初始状态和更新，错误设备无串流且退出关闭连接',async t=>{
  const f=fixture(t),server=createServer({env:ENV,cloud:f.bridge}),streams=[];
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const item of streams)item.req.destroy();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));});
  const port=server.address().port;
  const config=await call(port,'/api/cloud/config');assert.deepEqual(config.json.video,{allowedOrigins:['https://video.test']});
  assert.equal((await call(port,'/api/cloud/devices')).status,401);
  const login=await call(port,'/api/cloud/login',{method:'POST',body:{password:PASSWORD}}),cookie=login.headers['set-cookie'][0].split(';')[0];
  f.bridge.acceptMessage('boats/boat-01/video',descriptor(),{retain:true});
  const first=await stream(port,cookie,'boat-01');streams.push(first);await until(()=>first.events.length===1);
  assert.equal(first.events[0].event,'state');assert.match(first.events[0].data.device.video.url,/boat-01/);
  f.bridge.acceptMessage('boats/boat-02/video',descriptor('https://video.test/live/boat-02.flv','flv'));
  f.bridge.acceptMessage('boats/boat-01/video',descriptor('https://video.test/live/boat-01.flv','flv'));
  await until(()=>first.events.length===2);assert.equal(first.events[1].data.device.id,'boat-01');assert.equal(first.events[1].data.device.video.format,'flv');
  assert.equal(first.events.some(event=>event.event==='telemetry'),false);
  const devices=await call(port,'/api/cloud/devices',{cookie}),fleet=await call(port,'/api/cloud/fleet',{cookie});
  assert.equal(devices.json.devices.length,2);assert.equal(fleet.json.devices[0].online,false);assert.ok(fleet.json.devices.every(device=>device.video&&device.summary===null));
  f.bridge.acceptMessage('boats/boat-01/video',clear());await until(()=>first.events.length===3);assert.equal(first.events[2].data.device.video,null);
  await call(port,'/api/cloud/session',{method:'DELETE',cookie});await until(()=>server.boatCloudApi.getClientCount()===0);
  assert.equal((await call(port,'/api/cloud/devices',{cookie})).status,401);
});
