const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const root=path.resolve(__dirname,'..');
const P=require('../public/utils/uart4Protocol');
const {createServer}=require('../server');
const {BoatTrack}=require('../public/utils/boatTrack');
const {prepareImuDisplay}=require('../public/utils/imuDisplay');
const {prepareVelocityDisplay}=require('../public/utils/velocityDisplay');
const {prepareBoatChart,createBoatChartSample}=require('../public/utils/boatChart');
function loadTransport(){
  let timeout;
  const context={EventTarget,CustomEvent,Uint8Array,BoatModules:{uart4Protocol:P},navigator:{},window:{isSecureContext:true},setTimeout:fn=>(timeout=fn,1),clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'public/transport.js'),'utf8'),context);
  return {link:new context.window.BoatLink(),context,expire:()=>timeout()};
}
function rtk(){
  const b=new Uint8Array(40),v=new DataView(b.buffer);
  b.set([0xa5,0x5a,2,2,40,3]);v.setUint32(6,42,true);v.setInt16(14,1200,true);v.setInt16(16,-500,true);
  v.setUint16(20,25,true);v.setInt32(26,311234567,true);v.setInt32(30,1217654321,true);v.setUint16(34,35999,true);b[36]=15;
  v.setUint16(38,P.crc16CcittFalse(b,2,36),true);return b;
}
test('CRC、拆包、粘包、坏帧重同步与DataView偏移',()=>{
  assert.equal(P.crc16CcittFalse(new TextEncoder().encode('123456789')),0x29b1);
  const raw=rtk(),bad=raw.slice();bad[14]^=1;
  const parser=new P.UART4StreamParser();
  assert.equal(parser.push(raw.slice(0,7)).length,0);
  const backing=new Uint8Array(raw.length-7+10);backing.set(raw.slice(7),5);
  const [frame]=parser.push(new DataView(backing.buffer,5,raw.length-7));
  assert.equal(frame.sequence,42);assert.equal(frame.velocity.xMps,1.2);assert.equal(frame.velocity.latitude,31.1234567);
  const stream=new Uint8Array(bad.length+raw.length+3);stream.set([1,2,3]);stream.set(bad,3);stream.set(raw,3+bad.length);
  assert.equal(parser.push(stream).length,1);assert.equal(parser.getStats().crcErrors,1);
});
test('RTK/IMU源超时、断连不显示旧数据；轨迹保持WGS84且断流断线',()=>{
  const frame=P.decodeVelocityFrame(rtk());
  assert.equal(prepareVelocityDisplay(frame,0,500,true).fixFresh,true);
  assert.equal(prepareVelocityDisplay(frame,0,975,true).fresh,false);
  assert.equal(prepareVelocityDisplay(frame,0,100,false).latitude,'--');
  const imu={imu:{received:true,fresh:true,ageMs:25,gyroValid:true,eulerValid:true,gyroRadps:[1,2,3],rollDegrees:5,pitchDegrees:6,yawDegrees:7}};
  assert.equal(prepareImuDisplay(imu,0,50,true).roll,'5.00');
  assert.equal(prepareImuDisplay(imu,0,1000,true).eulerFresh,false);
  const track=new BoatTrack((latitude,longitude)=>({latitude,longitude}));
  track.start();
  for(let i=0;i<25;i++)track.record({...frame.velocity,latitude:31.1234567+i*.00002,xMps:i<10?.2:2.8,yMps:0},i*100,true);
  assert.equal(track.segments[0][0].latitude,31.1234567);
  assert.equal(track.polylines()[0].color,'#dc2626');
  track.record({...frame.velocity,latitude:31.2},5000,true);
  assert.equal(track.segments.length,2);
});
test('航向跨359°→1°曲线走最短角度',()=>{
  const boat={received:true,feedbackValid:true,ageMs:0,controlMode:2,speedLoop:true,headingValid:true,sbusValid:true,motorsValid:true,targetMps:1,actualMps:1,requestedMps:1,commonPercent:10,turnPercent:2,targetHeading:1,actualHeading:359,headingError:2};
  const first=createBoatChartSample({boat},0,0,true);
  const second=createBoatChartSample({boat:{...boat,actualHeading:1}},100,100,true,first);
  assert.equal(second.headingActualPlot-first.headingActualPlot,2);
  assert.equal(prepareBoatChart([first,second],'heading').summary.error,'0.00');
});
test('参数串行分片按属性写入，只有匹配序号响应才结束事务',async()=>{
  const {link}=loadTransport(),chunks=[];
  link.device={gatt:{connected:true}};link.tx={};
  link.rx={properties:{write:true},writeValueWithResponse:async bytes=>chunks.push([...bytes]),writeValueWithoutResponse:async()=>assert.fail('不应选择无响应写法')};
  const pending=link.request('read');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(chunks.map(x=>x.length),[20,20,16]);
  link.handleResponse({requestSequence:99,status:0});assert.ok(link.pending);
  const expected={requestSequence:1,status:3,parameters:{}};
  link.handleResponse(expected);assert.equal(await pending,expected);assert.equal(link.pending,null);
});
test('参数超时/并发/断开会取消事务，迟到响应不能结束新请求',async()=>{
  const {link,expire}=loadTransport();
  link.device={gatt:{connected:true,disconnect(){}},removeEventListener(){}};
  link.tx={removeEventListener(){}};link.rx={properties:{writeWithoutResponse:true},writeValueWithoutResponse:async()=>{}};
  const first=link.request('read');await assert.rejects(link.request('read'),/等待/);
  expire();await assert.rejects(first,/响应超时/);
  const second=link.request('read');link.handleResponse({requestSequence:1,status:0});assert.ok(link.pending);
  link.disconnect();await assert.rejects(second,/断开/);
});
test('静态服务器404、路径穿越、非法URL、HEAD及healthz',async(t)=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(url,method='GET')=>new Promise((resolve,reject)=>{
    http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method},r=>{
      const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(chunks).toString()}));
    }).on('error',reject).end();
  });
  const page=await request('/');assert.equal(page.status,200);assert.match(page.body,/无人船监测平台/);
  assert.equal((await request('/missing.js')).status,404);
  assert.equal((await request('/%2e%2e/server.js')).status,403);
  assert.equal((await request('/.git/config')).status,403);
  assert.equal((await request('/%')).status,400);
  assert.equal((await request('/','POST')).status,405);
  const head=await request('/assets/boat_mobile.glb','HEAD');assert.equal(head.status,200);assert.equal(head.body,'');assert.ok(Number(head.headers['content-length'])>1000000);
  assert.equal(JSON.parse((await request('/healthz')).body).app,'unmanned-boat-web');
});
