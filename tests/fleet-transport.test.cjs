/* 船队摘要与单船详情互不依赖，旧会话、迟到快照和断流不会恢复旧船况。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
  let wall=100000,response,block;
  const streams=[],calls=[],document=new EventTarget();document.hidden=false;
  class Stream extends EventTarget{
    constructor(url){super();this.url=url;streams.push(this);}
    close(){this.closed=true;}
    send(name,value){this.dispatchEvent(new MessageEvent(name,{data:JSON.stringify(value)}));}
  }
  const auth={generation:1,expire(){this.generation++;}},cloud=new EventTarget();
  Object.assign(cloud,{enabled:true,authenticated:true,selectedId:'boat-a',serverOffset:0,
    async api(route,options){calls.push({route,options});if(block)await block();if(response instanceof Error)throw response;return response||{brokerConnected:true,devices:[],serverTime:wall};},
    disconnect(){cloud.dispatchEvent(new CustomEvent('cloudstate'));}});
  const context={window:{BoatAuth:auth},EventTarget,CustomEvent,EventSource:Stream,document,Date:{now:()=>wall},AbortController,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/fleet-transport.js'),'utf8'),context);
  const fleet=new context.window.BoatFleetLink(cloud);
  const device=(id,speed=1)=>({id,online:true,parametersReady:true,lastReceivedAt:wall,summary:{receivedAt:wall,speedMps:speed,targetSpeedMps:2,headingDegrees:90,latitude:31,longitude:121,voltageV:24,controlMode:2,
    validUntil:{speedMps:wall+900,targetSpeedMps:wall+1000,headingDegrees:wall+800,position:wall+700,voltageV:wall+600,controlMode:wall+1000}}});
  return {fleet,cloud,auth,document,streams,calls,device,change:()=>cloud.dispatchEvent(new CustomEvent('cloudstate')),advance:ms=>wall+=ms,
    response:value=>response=value,block:value=>block=value,packet:devices=>({brokerConnected:true,devices,serverTime:wall})};
}
test('一条船队SSE同时接收多船摘要，选择/断开单船不关闭总览',async t=>{
  const h=setup();t.after(()=>h.fleet.destroy());h.change();await flush();
  assert.equal(h.streams.length,1);const stream=h.streams[0];assert.equal(stream.url,'/api/cloud/fleet/events');
  stream.send('open',{});stream.send('fleet',h.packet([h.device('boat-a',1),h.device('boat-b',2)]));
  assert.deepEqual(Array.from(h.fleet.state().devices,d=>d.id),['boat-a','boat-b']);
  assert.equal(h.fleet.state().devices[1].summary.speedMps,2);
  h.cloud.selectedId='boat-b';h.change();h.cloud.disconnect();
  assert.equal(h.streams.length,1);assert.notEqual(stream.closed,true);assert.equal(h.fleet.state().selectedId,'boat-b');
  h.advance(1);stream.send('fleet-device',{...h.packet([]),device:h.device('boat-a',3)});
  assert.equal(h.fleet.state().devices.find(d=>d.id==='boat-a').summary.speedMps,3);
  assert.equal(h.fleet.state().devices.find(d=>d.id==='boat-b').summary.speedMps,2);
});
test('全量替换可淘汰设备，独立源过期/非法字段保持未知',async t=>{
  const h=setup();t.after(()=>h.fleet.destroy());h.change();await flush();const stream=h.streams[0];
  const first=h.device('boat-a');first.summary.validUntil.speedMps=99999;first.summary.headingDegrees='90';
  stream.send('fleet',h.packet([first,h.device('boat-b')]));
  let value=h.fleet.state().devices[0].summary;assert.equal(value.speedMps,null);assert.equal(value.headingDegrees,null);assert.equal(value.voltageV,24);
  h.advance(1);stream.send('fleet',h.packet([h.device('boat-b')]));assert.equal(h.fleet.state().devices.length,1);
  assert.equal(h.fleet.state().devices[0].id,'boat-b');
  stream.send('fleet-device',{...h.packet([]),device:{...h.device('boat-b'),online:false}});
  assert.equal(h.fleet.state().devices[0].summary,null);
});
test('Broker断连清除全部摘要，迟到快照不覆盖较新的多船状态',async t=>{
  const h=setup();t.after(()=>h.fleet.destroy());h.change();await flush();const stream=h.streams[0];
  const older=h.packet([h.device('old-boat')]);h.advance(10);stream.send('fleet',h.packet([h.device('boat-a'),h.device('boat-b')]));
  stream.send('fleet',older);assert.equal(h.fleet.state().devices.length,2);assert.equal(h.fleet.state().devices[0].id,'boat-a');
  h.advance(1);stream.send('fleet',{...h.packet([h.device('boat-a'),h.device('boat-b')]),brokerConnected:false});
  assert.ok(h.fleet.state().devices.every(d=>d.online===false&&d.summary===null));
});

test('视频字段随船队快照独立保留，视频更新和视频单独上线不续期遥测',async t=>{
  const h=setup();t.after(()=>h.fleet.destroy());h.change();await flush();const stream=h.streams[0];
  const video={version:1,url:'https://video.test/live.m3u8',format:'hls',title:'船载摄像头',receivedAt:100000,retained:true};
  const first={...h.device('boat-a'),video};stream.send('fleet',h.packet([first]));
  let result=h.fleet.state().devices[0];assert.equal(result.video.url,video.url);assert.equal(result.summary.speedMps,1);
  h.advance(1000);stream.send('fleet-device',{...h.packet([]),device:{...first,video:{...video,url:'https://video.test/new.m3u8',receivedAt:101000}}});
  result=h.fleet.state().devices[0];assert.equal(result.summary,null);assert.equal(result.lastReceivedAt,100000);
  assert.equal(result.video.url,'https://video.test/new.m3u8');
  stream.send('fleet-device',{...h.packet([]),device:{id:'boat-camera',online:false,lastReceivedAt:null,parametersReady:false,video}});
  result=h.fleet.state().devices.find(device=>device.id==='boat-camera');
  assert.equal(result.online,false);assert.equal(result.lastReceivedAt,null);assert.equal(result.summary,null);assert.equal(result.parametersReady,false);assert.equal(result.video.url,video.url);
  stream.send('fleet',{...h.packet([{...first,online:false,video}]),brokerConnected:false});
  result=h.fleet.state().devices[0];assert.equal(result.online,false);assert.equal(result.summary,null);assert.equal(result.video.url,video.url);
  stream.send('fleet-device',{...h.packet([]),device:{...first,video:null}});assert.equal(h.fleet.state().devices[0].video,null);
});
test('退出/更换身份立即清空，旧SSE和迟到HTTP不能恢复上一会话',async t=>{
  const h=setup();t.after(()=>h.fleet.destroy());let release;h.block(()=>new Promise(resolve=>release=resolve));
  h.change();const stream=h.streams[0];stream.send('fleet',h.packet([h.device('boat-a')]));
  h.cloud.authenticated=false;h.auth.generation++;h.change();
  assert.equal(stream.closed,true);assert.equal(h.fleet.state().devices.length,0);
  stream.send('fleet',h.packet([h.device('old-account')]));release();await flush();
  assert.equal(h.fleet.state().devices.length,0);h.block(null);h.cloud.authenticated=true;h.change();await flush();
  assert.equal(h.streams.length,2);stream.send('fleet',h.packet([h.device('old-account')]));assert.equal(h.fleet.state().devices.length,0);
});
test('后台暂停后不续旧摘要，返回只建一条新船队通道，destroy清理监听',async t=>{
  const h=setup();t.after(()=>h.fleet.destroy());h.change();await flush();let stream=h.streams[0];stream.send('fleet',h.packet([h.device('boat-a')]));
  h.document.hidden=true;h.document.dispatchEvent(new Event('visibilitychange'));assert.equal(stream.closed,true);
  assert.equal(h.fleet.state().devices[0].summary,null);
  h.document.hidden=false;h.document.dispatchEvent(new Event('visibilitychange'));await flush();
  assert.equal(h.streams.length,2);h.change();assert.equal(h.streams.length,2);
  h.fleet.destroy();h.change();h.document.dispatchEvent(new Event('visibilitychange'));assert.equal(h.streams.length,2);
});
test('401关闭全部总览，快照不自动重试写入或发单船控制',async t=>{
  const h=setup();t.after(()=>h.fleet.destroy());h.response(Object.assign(Error('expired'),{status:401}));h.change();await flush();
  assert.equal(h.cloud.authenticated,false);assert.equal(h.streams[0].closed,true);assert.equal(h.fleet.state().devices.length,0);
  assert.ok(h.calls.every(call=>call.route==='fleet'&&!call.options.method));
});
