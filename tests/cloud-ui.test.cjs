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
function setup(){
  let now=10000,wall=1770000000000,authorized=true,brokerConnected=true;
  const streams=[],timers=new Map();let timerId=0;
  class FakeEventSource extends EventTarget {
    constructor(url){super();this.url=url;streams.push(this);}
    close(){this.closed=true;}
    send(type,data){this.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));}
  }
  class FakeBluetooth extends EventTarget {
    constructor(){super();this.connected=false;this.busy=false;this.parser=new P.UART4StreamParser();this.disconnects=0;this.requests=0;}
    async connect(){this.connected=true;this.dispatchEvent(new CustomEvent('connection',{detail:{connected:true,id:'ble',name:'T10'}}));}
    disconnect(){this.connected=false;this.disconnects++;this.dispatchEvent(new CustomEvent('connection',{detail:{connected:false}}));}
    request(){this.requests++;return Promise.resolve({});}
  }
  const context={EventTarget,CustomEvent,Uint8Array,atob,BoatModules:{uart4Protocol:P},BoatLink:FakeBluetooth,
    window:{},document:{hidden:false},EventSource:FakeEventSource,performance:{now:()=>now},Date:{now:()=>wall},
    setInterval:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),
    fetch:async(url,options)=>{
      let status=200,body={serverTime:wall};
      if(url.endsWith('/config'))body={...body,enabled:true,requiresLogin:true};
      else if(url.endsWith('/login')){authorized=true;body.ok=true;}
      else if(url.endsWith('/session')){authorized=false;body.ok=true;}
      else if(!authorized){status=401;body.error='auth';}
      else if(url.endsWith('/devices'))body={...body,brokerConnected,devices:[{id:'boat-123',online:true,status:'online'}]};
      return {ok:status===200,status,json:async()=>body};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(root,'public/cloud-transport.js'),'utf8'),context);
  const cloud=new context.window.CloudBoatLink();
  return {cloud,context,streams,timers,FakeBluetooth,
    packet:(extra={})=>({deviceId:'boat-123',receivedAt:wall,ageMs:0,payload:payload(),...extra}),
    advance:ms=>{now+=ms;wall+=ms;},setAuthorized:value=>authorized=value,setBroker:value=>brokerConnected=value};
}
async function connected(h){await h.cloud.initialize();await h.cloud.connect('boat-123');return h.streams.at(-1);}
test('云端通道建立不伪装成实时设备；完整176字节沿用UART4解析和接收年龄',async()=>{
  const h=setup(),frames=[],connections=[];h.cloud.addEventListener('frame',e=>frames.push(e.detail));h.cloud.addEventListener('connection',e=>connections.push(e.detail));
  const stream=await connected(h);stream.send('open',{});assert.equal(h.cloud.connected,false);
  stream.send('telemetry',h.packet({ageMs:300}));
  assert.equal(h.cloud.connected,true);assert.equal(frames.length,4);assert.equal(frames[0].sequence,42);
  assert.equal(frames[0].receivedAtMonotonic,9700);assert.equal(h.cloud.parser.getStats().framesReceived,4);
  assert.equal(connections.at(-1).readOnly,true);assert.equal(connections.at(-1).id,'cloud:boat-123');
  await assert.rejects(h.cloud.request('write',{}),/只读/);
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
test('单一数据源路由切换时断开旧连接，云端拒绝所有参数事务',async()=>{
  const h=setup(),ble=new h.FakeBluetooth(),link=new h.context.window.BoatSourceLink(ble,h.cloud),frames=[];
  link.addEventListener('frame',e=>frames.push(e.detail));await link.connect();assert.equal(link.connected,true);
  link.select('cloud');assert.equal(ble.connected,false);assert.equal(ble.disconnects,1);assert.equal(link.readOnly,true);
  ble.dispatchEvent(new CustomEvent('frame',{detail:{sequence:99}}));assert.equal(frames.length,0);
  for(const kind of ['read','write','flash'])await assert.rejects(link.request(kind,{}),/只读/);
  assert.equal(ble.requests,0);await connected(h);h.streams.at(-1).send('telemetry',h.packet());assert.equal(frames.length,4);
  link.select('bluetooth');assert.equal(h.streams.at(-1).closed,true);assert.equal(link.readOnly,false);assert.equal(link.connected,false);
  h.cloud.emit('frame',{sequence:100});assert.equal(frames.length,4);
});
function parameterPanel(){
  const ids={},inputs=[{dataset:{key:'speed'},value:'12'}],buttons=[{dataset:{action:'save',slot:'0'}},{dataset:{action:'use',slot:'0'}}],storage=new Map();
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
test('蓝牙参数响应在切到云端后迟到，不能恢复设备确认值或开启写入按钮',async()=>{
  const {panel,ids,inputs}=parameterPanel();let complete;
  panel.link.readOnly=false;panel.link.request=()=>new Promise(resolve=>complete=resolve);
  const pending=panel.command('read');panel.link.generation++;panel.link.readOnly=true;panel.reset(true);
  complete({status:0,parameters:{speed:77}});await assert.rejects(pending,/连接已切换/);
  assert.equal(panel.confirmed,null);assert.equal(inputs[0].value,'12');assert.equal(ids.writeParameters.disabled,true);
  assert.equal(panel.localDraft.speed,12);
});
