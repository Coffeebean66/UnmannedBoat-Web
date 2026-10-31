const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const P=require('../public/utils/uart4Protocol');
const root=path.resolve(__dirname,'..');
function payload(){
  const frames=[];
  for(const [type,size,version] of [[1,64,1],[2,40,2],[3,36,2],[4,36,1]]){
    const b=new Uint8Array(size),v=new DataView(b.buffer);b.set([0xa5,0x5a,version,type,size,3]);
    v.setUint32(6,42,true);v.setUint16(size-2,P.crc16CcittFalse(b,2,size-4),true);frames.push(Buffer.from(b));
  }
  return Buffer.concat(frames).toString('base64');
}
function setup({serverClock=true,serverOffset=0,videoConfig,auth}={}){
  let now=10000,wall=1770000000000,authorized=true,brokerConnected=true;
  const streams=[],timers=new Map();let timerId=0;
  class FakeEventSource extends EventTarget {
    constructor(url){super();this.url=url;streams.push(this);}
    close(){this.closed=true;}
    send(type,data){this.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));}
  }
  const context={EventTarget,CustomEvent,Uint8Array,atob,BoatModules:{uart4Protocol:P},
    window:auth?{BoatAuth:auth}:{},document:{hidden:false},EventSource:FakeEventSource,performance:{now:()=>now},Date:{now:()=>wall},
    setInterval:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),
    fetch:async(url,options)=>{
      let status=200,body=serverClock?{serverTime:wall+serverOffset}:{};
      if(url.endsWith('/config'))body={...body,enabled:true,requiresLogin:true,...(videoConfig===undefined?{}:{video:videoConfig})};
      else if(url.endsWith('/login')){authorized=true;body.ok=true;}
      else if(url.endsWith('/session')){authorized=false;body.ok=true;}
      else if(!authorized){status=401;body.error='auth';}
      else if(url.endsWith('/devices'))body={...body,brokerConnected,devices:[{id:'boat-123',online:true,status:'online'}]};
      return {ok:status===200,status,json:async()=>body};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(root,'public/cloud-transport.js'),'utf8'),context);
  const cloud=new context.window.CloudBoatLink();
  return {cloud,context,streams,timers,
    packet:(extra={})=>({deviceId:'boat-123',receivedAt:wall+serverOffset,ageMs:0,payload:payload(),...extra}),
    advance:ms=>{now+=ms;wall+=ms;},setAuthorized:value=>authorized=value,setBroker:value=>brokerConnected=value};
}
async function connected(h){await h.cloud.initialize();await h.cloud.connect('boat-123');return h.streams.at(-1);}

test('手动断开保留选择，退出和身份切换在通知前清理选船及能力，使新会话可自动选船',async()=>{
  const auth=new EventTarget();
  Object.assign(auth,{enabled:true,generation:1,canMonitor:true,canManage:true,async whenReady(){},
    assertMonitor(){if(!this.canMonitor)throw Error('请登录');}});
  const change=(monitor,manage=monitor)=>{
    auth.canMonitor=monitor;auth.canManage=manage;auth.generation++;
    auth.dispatchEvent(new CustomEvent('change'));
  };
  const h=setup({auth}),stream=await connected(h),snapshots=[];
  stream.send('telemetry',h.packet());h.cloud.parameterCapableId='boat-123';
  h.cloud.disconnect();
  assert.equal(h.cloud.selectedId,'boat-123','手动断开只停止订阅，不清除用户选择');
  assert.equal(h.cloud.parameterCapableId,'boat-123');
  await h.cloud.connect('boat-123');
  const previous=h.streams.at(-1);
  h.cloud.addEventListener('cloudstate',event=>snapshots.push({selectedId:event.detail.selectedId,capable:h.cloud.parameterCapableId}));
  change(false);
  assert.equal(h.cloud.authenticated,false);assert.equal(h.cloud.wanted,false);
  assert.equal(previous.closed,true);
  assert.ok(snapshots.length>=1);
  assert.ok(snapshots.every(snapshot=>snapshot.selectedId===''&&snapshot.capable===''),'所有通知均已移除上一会话的选择和能力');
  previous.send('telemetry',h.packet());assert.equal(h.cloud.connected,false);
  change(true,false);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.cloud.authenticated,true);assert.equal(h.cloud.selectedId,'');
  assert.equal(h.cloud.wanted,false);assert.equal(h.cloud.parameterCapableId,'');
  assert.ok(h.cloud.devices.some(device=>device.id==='boat-123'),'新会话设备目录可供自动选择');
  await h.cloud.connect('boat-123');h.cloud.parameterCapableId='boat-123';
  auth.dispatchEvent(new CustomEvent('change'));
  assert.equal(h.cloud.selectedId,'boat-123','同一鉴权代的重复通知不取消新选择');
  change(true,true);
  assert.equal(h.cloud.selectedId,'','已登录身份切换同样取消上一账户选船');
  assert.equal(h.cloud.parameterCapableId,'');
});
test('视频来源配置随云端状态公开，旧后台或无效配置按仅同源处理且不恢复遥测',async()=>{
  for(const [config,expected]of [[undefined,[]],[null,[]],[{allowedOrigins:'https://video.test'},[]],
    [{allowedOrigins:['https://video.test','http://127.0.0.1:9000',null,123]},['https://video.test','http://127.0.0.1:9000']]]){
    const h=setup({videoConfig:config});let last;
    h.cloud.addEventListener('cloudstate',event=>last=event.detail);
    assert.deepEqual(Array.from(h.cloud.videoConfig.allowedOrigins),[]);
    await h.cloud.initialize();
    assert.deepEqual(Array.from(h.cloud.videoConfig.allowedOrigins),expected);
    assert.deepEqual(Array.from(last.videoConfig.allowedOrigins),expected);
    assert.equal(h.cloud.connected,false);assert.equal(h.cloud.lastPayloadAt,null);
  }
});
test('云端通道建立不伪装成实时设备；完整176字节沿用UART4解析和接收年龄',async()=>{
  const h=setup(),frames=[],connections=[];h.cloud.addEventListener('frame',e=>frames.push(e.detail));h.cloud.addEventListener('connection',e=>connections.push(e.detail));
  const stream=await connected(h);stream.send('open',{});assert.equal(h.cloud.connected,false);
  stream.send('telemetry',h.packet({ageMs:300}));
  assert.equal(h.cloud.connected,true);assert.equal(frames.length,4);assert.equal(frames[0].sequence,42);
  assert.equal(frames[0].receivedAtMonotonic,9700);assert.equal(h.cloud.parser.getStats().framesReceived,4);
  assert.equal(connections.at(-1).readOnly,true);assert.equal(connections.at(-1).id,'cloud:boat-123');
  await assert.rejects(h.cloud.request('write',{}),/只读/);
});
test('转发延迟使用校时后的服务器接收时间，独立于遥测年龄且不出现负值',async()=>{
  const h=setup({serverOffset:120000}),frames=[];h.cloud.addEventListener('frame',e=>frames.push(e.detail));
  const stream=await connected(h);assert.equal(h.cloud.clockKnown,true);assert.equal(h.cloud.serverOffset,120000);
  stream.send('telemetry',h.packet({receivedAt:1770000000000+120000-125,ageMs:350}));
  assert.equal(frames.length,4);
  for(const frame of frames){assert.equal(frame.cloudForwardDelayMs,125);assert.equal(frame.receivedAtMonotonic,9650);}
  stream.send('telemetry',h.packet({receivedAt:1770000000000+120000+30}));
  assert.equal(frames.length,8);assert.equal(frames.at(-1).cloudForwardDelayMs,0);
});
test('未校时或缺少有效服务器接收时间时，转发延迟明确为未知而不是0ms',async()=>{
  for(const [label,options,extra] of [
    ['未校时',{serverClock:false},{}],
    ['缺少时间戳',{}, {receivedAt:undefined}],
    ['空时间戳',{}, {receivedAt:null}],
    ['非数值时间戳',{}, {receivedAt:'1770000000000'}]
  ]){
    const h=setup(options),frames=[];h.cloud.addEventListener('frame',e=>frames.push(e.detail));
    const stream=await connected(h);stream.send('telemetry',h.packet(extra));
    assert.equal(frames.length,4,label);assert.equal(h.cloud.connected,true,label);
    for(const frame of frames)assert.equal(frame.cloudForwardDelayMs,null,label);
  }
});

test('船云延迟元数据独立于转发与遥测年龄，旧固件逐包恢复未知',async()=>{
  const h=setup(),frames=[];h.cloud.addEventListener('frame',e=>frames.push(e.detail));
  const stream=await connected(h);
  stream.send('telemetry',h.packet({receivedAt:1770000000000-80,ageMs:230,
    uplinkDelayMs:120.25,uplinkRttMs:160.5,uplinkUncertaintyMs:82.25}));
  assert.equal(frames.length,4);
  for(const frame of frames){
    assert.equal(frame.cloudUplinkDelayMs,120.25);assert.equal(frame.cloudUplinkRttMs,160.5);
    assert.equal(frame.cloudUplinkUncertaintyMs,82.25);assert.equal(frame.cloudForwardDelayMs,80);
    assert.equal(frame.receivedAtMonotonic,9770,'上行估计不改变原有遥测年龄');
  }
  stream.send('telemetry',h.packet());assert.equal(frames.length,8);
  for(const frame of frames.slice(4)){
    assert.equal(frame.cloudUplinkDelayMs,null);assert.equal(frame.cloudUplinkRttMs,null);assert.equal(frame.cloudUplinkUncertaintyMs,null);
  }
});

test('非法上行延迟不显示为有效值，迟到与错设备数据不能覆盖当前估计',async()=>{
  const h=setup(),frames=[];h.cloud.addEventListener('frame',e=>frames.push(e.detail));
  const stream=await connected(h);
  for(const value of [null,undefined,'100',-1,Infinity,NaN,60001]){
    stream.send('telemetry',h.packet({uplinkDelayMs:value,uplinkRttMs:value,uplinkUncertaintyMs:value}));
    assert.equal(frames.at(-1).cloudUplinkDelayMs,null);assert.equal(frames.at(-1).cloudUplinkRttMs,null);assert.equal(frames.at(-1).cloudUplinkUncertaintyMs,null);
  }
  stream.send('telemetry',h.packet({uplinkDelayMs:0,uplinkRttMs:0,uplinkUncertaintyMs:1}));
  assert.equal(frames.at(-1).cloudUplinkDelayMs,0);
  const count=frames.length;
  stream.send('telemetry',h.packet({deviceId:'boat-second',uplinkDelayMs:999}));
  stream.send('telemetry',h.packet({ageMs:1000,uplinkDelayMs:999}));
  assert.equal(frames.length,count);assert.equal(frames.at(-1).cloudUplinkDelayMs,0);
  await h.cloud.connect('boat-second');const next=h.streams.at(-1);
  stream.send('telemetry',h.packet({uplinkDelayMs:999}));assert.equal(frames.length,count);
  next.send('telemetry',h.packet({deviceId:'boat-second',uplinkDelayMs:42}));
  assert.equal(frames.at(-1).cloudUplinkDelayMs,42);
});
test('切换MQTT设备后旧SSE不能更新船名、有效帧或转发延迟',async()=>{
  const h=setup(),frames=[],connections=[];h.cloud.addEventListener('frame',e=>frames.push(e.detail));h.cloud.addEventListener('connection',e=>connections.push(e.detail));
  const previous=await connected(h);previous.send('telemetry',h.packet({receivedAt:1770000000000-111}));
  assert.equal(frames.length,4);assert.equal(frames.at(-1).cloudForwardDelayMs,111);
  await h.cloud.connect('boat-second');const current=h.streams.at(-1);
  assert.notEqual(current,previous);assert.equal(previous.closed,true);assert.equal(h.cloud.selectedId,'boat-second');assert.equal(h.cloud.connected,false);
  previous.send('telemetry',h.packet({receivedAt:1770000000000-222}));
  current.send('telemetry',h.packet());assert.equal(frames.length,4);assert.equal(h.cloud.connected,false);
  current.send('telemetry',h.packet({deviceId:'boat-second',receivedAt:1770000000000-24}));
  assert.equal(frames.length,8);assert.equal(frames.at(-1).cloudForwardDelayMs,24);
  assert.equal(connections.at(-1).id,'cloud:boat-second');assert.equal(connections.at(-1).name,'boat-second');
  assert.equal(h.cloud.parser.getStats().framesReceived,4);
});
test('迟到、错设备、损坏和超长遥测都不会恢复云端实时状态',async()=>{
  const h=setup(),stream=await connected(h);let count=0;h.cloud.addEventListener('frame',()=>count++);
  const bad=Buffer.from(payload(),'base64');for(const offset of [14,78,118,154])bad[offset]^=1;
  for(const packet of [h.packet({receivedAt:1770000000000-1001}),h.packet({ageMs:1000}),h.packet({deviceId:'other'}),h.packet({payload:'!'}),h.packet({payload:'a'.repeat(5000)}),h.packet({payload:bad.toString('base64')})])stream.send('telemetry',packet);
  assert.equal(count,0);assert.equal(h.cloud.connected,false);
  stream.send('telemetry',h.packet());assert.equal(count,4);assert.equal(h.cloud.connected,true);
});
test('Broker/设备离线和1秒断流立即失效，晚到旧SSE不能覆盖新会话',async()=>{
  const h=setup(),stream=await connected(h);stream.send('telemetry',h.packet());assert.equal(h.cloud.connected,true);
  stream.send('state',{brokerConnected:false,device:{id:'boat-123',online:true}});assert.equal(h.cloud.connected,false);
  stream.send('telemetry',h.packet());assert.equal(h.cloud.connected,false);
  stream.send('state',{brokerConnected:true,device:{id:'boat-123',online:true}});stream.send('telemetry',h.packet());assert.equal(h.cloud.connected,true);
  h.advance(1000);for(const tick of h.timers.values())tick();assert.equal(h.cloud.connected,false);
  stream.send('telemetry',h.packet());assert.equal(h.cloud.connected,true);
  stream.send('state',{brokerConnected:true,device:{id:'boat-123',online:false}});assert.equal(h.cloud.connected,false);
  h.cloud.disconnect();assert.equal(stream.closed,true);stream.send('telemetry',h.packet());assert.equal(h.cloud.connected,false);
});
test('后台恢复使用新SSE，旧队列与缓存不会复活姿态；401会关闭流并要求登录',async()=>{
  const h=setup(),stream=await connected(h);stream.send('telemetry',h.packet());
  h.context.document.hidden=true;h.cloud.suspend();assert.equal(h.cloud.connected,false);assert.equal(stream.closed,true);
  h.advance(5000);stream.send('telemetry',h.packet());assert.equal(h.cloud.connected,false);
  h.context.document.hidden=false;h.cloud.resume();const next=h.streams.at(-1);assert.notEqual(next,stream);
  assert.equal(h.cloud.connected,false);stream.send('telemetry',h.packet());assert.equal(h.cloud.connected,false);
  next.send('telemetry',h.packet());assert.equal(h.cloud.connected,true);
  h.setAuthorized(false);next.send('error',{});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.cloud.connected,false);assert.equal(h.cloud.authenticated,false);assert.equal(next.closed,true);assert.equal(h.cloud.wanted,false);
});
function parameterPanel(){
  const ids={controlAlgorithmSelect:{dataset:{},options:[{},{}]}},inputs=[{dataset:{key:'speed'},value:'12'}],buttons=[{dataset:{action:'save',slot:'0'}},{dataset:{action:'use',slot:'0'}}],storage=new Map();
  const context={window:{},document:{getElementById:id=>ids[id]||(ids[id]={dataset:{}}),querySelectorAll:selector=>selector.startsWith('#parameterFields')?inputs:buttons},
    localStorage:{setItem:(key,value)=>storage.set(key,value)},BoatModules:{parameterExport:{formatParameterExport:(values,confirmed)=>JSON.stringify({values,confirmed})}},Date};
  vm.runInNewContext(fs.readFileSync(path.join(root,'public/parameter-panel.js'),'utf8'),context);
  const panel=Object.create(context.window.ParameterPanel.prototype);
  Object.assign(panel,{link:{readOnly:true,connected:true,generation:1,request:()=>assert.fail('云端不能发参数命令')},busy:false,confirmed:{speed:10},localDraft:null,keys:['speed'],config:{ranges:{speed:[0,100]}},slots:[{values:{speed:3}},null,null],storageKey:'preset',renderSlots(){}});
  return {panel,ids,inputs,buttons,storage};
}
test('云端参数界面和直接调用均拦截读写/Flash/一键使用，允许保存及导出本地草稿',async()=>{
  const {panel,ids,buttons,storage}=parameterPanel();panel.reset(true);
  assert.equal(panel.confirmed,null);assert.equal(panel.localDraft.speed,12);
  for(const id of ['readParameters','writeParameters','saveFlash'])assert.equal(ids[id].disabled,true);
  assert.equal(buttons[1].disabled,true);assert.equal(buttons[0].disabled,false);assert.equal(ids.exportParameters.disabled,false);
  for(const kind of ['read','write','flash'])await assert.rejects(panel.command(kind),/只读/);
  await assert.rejects(panel.actSlot(0,'use'),/只读/);await panel.actSlot(0,'save');assert.equal(JSON.parse(storage.get('preset'))[0].values.speed,12);
  const exported=JSON.parse(panel.exportText());assert.equal(exported.values.speed,12);assert.equal(!!exported.confirmed,false);
});
test('切换MQTT设备后旧参数响应迟到，不能恢复设备确认值或开启写入按钮',async()=>{
  const {panel,ids,inputs}=parameterPanel();let complete;
  panel.link.readOnly=false;panel.link.request=()=>new Promise(resolve=>complete=resolve);
  const pending=panel.command('read');panel.link.generation++;panel.link.readOnly=true;panel.reset(true);
  complete({status:0,parameters:{speed:77}});await assert.rejects(pending,/连接已切换/);
  assert.equal(panel.confirmed,null);assert.equal(inputs[0].value,'12');assert.equal(ids.writeParameters.disabled,true);
  assert.equal(panel.localDraft.speed,12);
});
