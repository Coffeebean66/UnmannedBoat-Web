/* 标准 Gamepad 输入与真实驾驶原型合测，验证轴值、接管确认和停船生命周期。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {BoatDriverGamepad,readPad}=require('../public/driver-gamepad');
const makePad=(index=0,id='Xbox test controller')=>({index,id,mapping:'standard',connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0})),timestamp:0});
const settle=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
function setup(){
  class Node extends EventTarget{
    constructor(){super();this.dataset={};this.value='';this.textContent='';this.hidden=false;this.disabled=false;}
    click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
    replaceChildren(...children){this.children=children;}
    setAttribute(name,value){this[name]=value;}
  }
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const document=Object.assign(new EventTarget(),{activeElement:null,modal:false,focused:true,hasFocus(){return this.focused;},getElementById:node,createElement:()=>new Node(),querySelector(){return this.modal?{open:true}:null;},querySelectorAll:()=>[]});
  const stored=new Map(),window=new EventTarget();Object.assign(window,{Event,isSecureContext:true,setTimeout,clearTimeout,localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)},BoatWorkspace:{current:'driving'}});
  let now=0,visible=true,role='admin',pads=[makePad()],failure;
  const navigator={getGamepads(){if(failure)throw failure;return pads;}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/driver-control.js'),'utf8'),{window,AbortController,performance:{now:()=>now}});
  const driver=Object.create(window.BoatDriverControl.prototype),calls=[],toasts=[],stops=[],pans=[],zooms=[],followChanges=[],cameraDirections=[];
  const cameraControl={direction:null,resets:0,setGamepadDirection(x,y,zoom=0){this.direction=zoom?[x,y,zoom]:[x,y];cameraDirections.push(this.direction);},resetGamepadPtz(){this.direction=null;this.resets++;}};
  node('mapFollow').addEventListener('change',()=>followChanges.push(node('mapFollow').checked));
  const map={ready:true,switching:false,zoom:12,maxZoom:19,getZoom(){return this.zoom;},setZoom(value,options){this.zoom=value;this.zoomOptions=options;zooms.push(value);},panScreenBy(offset){if(!this.ready||this.switching)return false;pans.push(Array.from(offset));return true;}};window.boatMonitor={map};
  Object.assign(driver,{document,cameraControl,nodes:{'view-driving':node('view-driving'),driverMode:node('driverMode'),driverLimit:node('driverLimit'),driverHeading:node('driverHeading'),driverEmergency:node('driverEmergency'),driverMapFollow:node('driverMapFollow')},
    context:{deviceId:'boat-01'},keys:new Set(),generation:0,sequence:0,clientId:'1122334455667788',leaseId:'',active:false,pending:false,testMode:false,remote:{ready:true,testSupported:true},
    inputRequests:new Map(),lastInputSentAt:-Infinity,lastInputSignature:'',lastInputResponseAt:0,lastAcceptedSequence:0,lastPulse:0,lastPoll:0,layout:{editing:false},navigation:{mode:'manual'},destroyed:false,
    visible:()=>visible,admin:()=>['admin','driver'].includes(role),permitted:()=>visible&&['admin','driver'].includes(role)&&!driver.layout.editing&&driver.navigation.mode==='manual',
    toast:message=>toasts.push(message),renderKeys(){},headingMode(){},render(){this.gamepad?.render();},poll(){},setTestMode(value){this.testMode=value;},setMediaFocus(value){this.nodes['view-driving'].dataset.primary=value;},
    async api(body){calls.push(body);if(body.action==='acquire'&&h.deferAcquire)return h.deferAcquire();return {active:true,owned:true,state:1,status:'active',leaseId:'0011223344556677',testMode:!!body.testMode,sequence:body.sequence??0};}});
  const originalStop=driver.stop;driver.stop=function(message,emergency){if(this.active||this.pending)stops.push({message,emergency});return originalStop.call(this,message,emergency);};
  driver.nodes.driverMode.value='0';driver.nodes.driverLimit.value='20';driver.nodes.driverHeading.value='359';driver.nodes['view-driving'].dataset.primary='video';
  driver.nodes.driverEmergency.addEventListener('click',()=>driver.stop('手柄急停',true));
  driver.nodes.driverMode.addEventListener('change',()=>driver.gamepad.reset());
  const h={driver,document,window,node,calls,stops,toasts,stored,map,pans,zooms,followChanges,cameraControl,cameraDirections,get pad(){return pads[0];},set pads(value){pads=value;},set failure(value){failure=value;},set role(value){role=value;},set visible(value){visible=value;},
    button(index,value=true){pads[0].buttons[index]={pressed:value,value:Number(value)};},tick(delta=100){now+=delta;driver.pulse();},
    async acquire(){await driver.acquire();await settle();},close(){driver.stop('test end');driver.gamepad.destroy();}};
  driver.gamepad=new BoatDriverGamepad({driver,scope:window,navigator,document});
  return h;
}
async function engage(h){h.driver.gamepad.selectSource('gamepad');await h.acquire();assert.equal(h.driver.active,true);h.tick();h.button(5);h.tick();assert.equal(h.driver.gamepad.engaged,true);await settle();}

test('Xbox 标准轴映射、死区缩放及无效设备拒绝；静止时间戳不视为断开',()=>{
  const pad=makePad();pad.axes=[0,-.5,1,0];const value=readPad(pad);
  assert.ok(Math.abs(value.forward-(.5-.15)/.85)<1e-8);assert.equal(value.turn,1);
  pad.axes=[.1,-.1,.15,0];assert.equal(readPad(pad).forward,0);assert.equal(readPad(pad).turn,0);assert.equal(readPad(pad).neutral,true);
  for(const change of [{mapping:''},{connected:false},{axes:[0,NaN,0,0]},{axes:[0,2,0,0]},{buttons:[]},{buttons:Array(17)}])assert.equal(readPad({...makePad(),...change}),null);
  assert.equal(readPad(makePad()).buttonsReleased,true);
});

test('十字键读取标准12—15按钮，相反方向抵消，较少按钮的手柄仍可驾驶',()=>{
  const pad=makePad();pad.buttons[12]={pressed:true,value:1};pad.buttons[15]={pressed:false,value:1};
  assert.equal(readPad(pad).mapX,1);assert.equal(readPad(pad).mapY,-1);
  pad.buttons[13]={pressed:true,value:1};pad.buttons[14]={pressed:true,value:1};
  assert.equal(readPad(pad).mapX,0);assert.equal(readPad(pad).mapY,0);
  pad.buttons.length=10;assert.equal(readPad(pad).mapX,0);assert.equal(readPad(pad).mapY,0);
});

test('RT 使用标准7号扳机，按下和值越过阈值均识别，非法扳机数据拒绝设备',()=>{
  const pad=makePad();assert.equal(readPad(pad).rt,false);pad.buttons[7]={pressed:true,value:.4};assert.equal(readPad(pad).rt,true);
  pad.buttons[7]={pressed:false,value:.7};assert.equal(readPad(pad).rt,true);pad.buttons[7]={pressed:false,value:.5};assert.equal(readPad(pad).rt,false);
  pad.buttons[7]={pressed:false,value:NaN};assert.equal(readPad(pad),null);
});

test('RT 连续缩放主地图、松开停止、保留跟随并遵守图层上下限',()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.node('mapFollow').checked=true;h.tick();h.tick();
  h.button(7);h.tick();assert.deepEqual(h.zooms,[13]);assert.equal(h.map.zoomOptions.animate,false);h.tick();h.tick();h.tick();assert.deepEqual(h.zooms,[13]);h.tick();assert.deepEqual(h.zooms,[13,14]);
  h.button(7,false);h.tick();h.tick(400);assert.deepEqual(h.zooms,[13,14]);assert.equal(h.node('mapFollow').checked,true);assert.deepEqual(h.followChanges,[]);
  h.map.zoom=19;h.button(7);h.tick();assert.equal(h.map.zoom,19);h.button(0);h.tick();assert.equal(h.map.zoom,18,'按住RT时加A立即改缩小');
  h.map.zoom=3;h.tick(400);assert.equal(h.map.zoom,3);assert.equal(h.calls.length,0);h.close();
});

test('A+RT 先后顺序不限，松开组合不恢复跟随，单独A松开后才恢复',()=>{
  for(const order of ['a-first','rt-first','together']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.node('mapFollow').checked=false;h.tick();h.tick();
    if(order==='a-first'){h.button(0);h.tick();assert.deepEqual(h.followChanges,[]);}
    if(order==='rt-first'){h.button(7);h.tick();}
    h.button(0);h.button(7);h.tick();assert.equal(h.zooms.at(-1),order==='rt-first'?12:11,order);
    h.button(7,false);h.tick();h.button(0,false);h.tick();assert.deepEqual(h.followChanges,[],order+' 组合释放不跟随');assert.equal(h.node('mapFollow').checked,false);
    h.button(0);h.tick();assert.deepEqual(h.followChanges,[]);h.button(0,false);h.tick();assert.deepEqual(h.followChanges,[true]);h.close();
  }
});

test('图传主画面RT与A+RT传入相机变焦，地图与船体输入不受影响',async()=>{
  const h=setup();h.role='driver';h.driver.gamepad.selectSource('gamepad');h.tick();h.tick();h.button(7);h.tick();assert.deepEqual(h.cameraControl.direction,[0,0,1]);
  h.button(0);h.tick();assert.deepEqual(h.cameraControl.direction,[0,0,-1]);h.button(0,false);h.tick();assert.deepEqual(h.cameraControl.direction,[0,0,1]);
  h.button(7,false);h.tick();assert.deepEqual(h.cameraControl.direction,[0,0]);assert.equal(h.zooms.length,0);assert.equal(h.calls.length,0);h.close();
  const driving=setup();await engage(driving);driving.pad.axes[1]=-1;driving.button(7);driving.tick();await settle();
  assert.deepEqual(driving.cameraControl.direction,[0,0,1]);assert.equal(driving.calls.filter(call=>call.action==='input').at(-1).throttle,200);driving.close();
});

test('缩放在切换目标、编辑、失焦、急停或采样中断时停止，恢复需先松RT',()=>{
  for(const condition of ['keyboard','hidden','guest','form','modal','layout','unfocused','disconnected','gap','stop','LB','boat','primary']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.tick();h.tick();h.button(7);h.tick();assert.equal(h.zooms.length,1);
    if(condition==='keyboard')h.driver.gamepad.selectSource('keyboard');
    if(condition==='hidden')h.visible=false;
    if(condition==='guest')h.role='guest';
    if(condition==='form')h.document.activeElement={closest:()=>true};
    if(condition==='modal')h.document.modal=true;
    if(condition==='layout')h.driver.layout.editing=true;
    if(condition==='unfocused')h.document.focused=false;
    if(condition==='disconnected')h.pads=[];
    if(condition==='stop')h.button(1);
    if(condition==='LB')h.button(4);
    if(condition==='boat')h.driver.context.deviceId='boat-02';
    if(condition==='primary')h.driver.nodes['view-driving'].dataset.primary='video';
    h.tick(condition==='gap'?1000:400);h.tick(400);assert.equal(h.zooms.length,1,condition);assert.ok(!h.cameraControl.direction?.[2],condition+' 不接着缩放另一目标');h.close();
  }
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.tick();h.tick();h.button(7);h.tick();h.tick(1000);h.tick(400);assert.equal(h.zooms.length,1);
  h.button(7,false);h.tick();h.button(7);h.tick();assert.equal(h.zooms.length,2);h.close();
});

test('图传主画面十字键传入云台八方向、松键归零，不移动地图或接管船体',()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.tick();
  for(const [buttons,x,y]of [[[12],0,-1],[[13],0,1],[[14],-1,0],[[15],1,0],[[12,14],-1,-1],[[12,15],1,-1],[[13,14],-1,1],[[13,15],1,1]]){
    for(const index of buttons)h.button(index);h.tick();assert.deepEqual(h.cameraControl.direction,[x,y]);
    for(const index of buttons)h.button(index,false);h.tick();assert.deepEqual(h.cameraControl.direction,[0,0]);
  }
  assert.equal(h.pans.length,0);assert.equal(h.calls.length,0);h.close();
});

test('云台十字键仅限前台图传主画面；编辑、急停、采样中断及权限失效停止',()=>{
  for(const condition of ['map','keyboard','hidden','guest','form','modal','layout','unfocused','disconnected','gap','stop','LB']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.tick();h.button(15);h.tick();assert.deepEqual(h.cameraControl.direction,[1,0]);
    if(condition==='map')h.driver.nodes['view-driving'].dataset.primary='map';
    if(condition==='keyboard')h.driver.gamepad.selectSource('keyboard');
    if(condition==='hidden')h.visible=false;
    if(condition==='guest')h.role='guest';
    if(condition==='form')h.document.activeElement={closest:()=>true};
    if(condition==='modal')h.document.modal=true;
    if(condition==='layout')h.driver.layout.editing=true;
    if(condition==='unfocused')h.document.focused=false;
    if(condition==='disconnected')h.pads=[];
    if(condition==='stop')h.button(1);
    if(condition==='LB')h.button(4);
    h.tick(condition==='gap'?500:100);assert.equal(h.cameraControl.direction,null,condition);h.close();
  }
});

test('手柄失焦、断开事件与销毁立即停止云台，不等待下次驾驶采样',()=>{
  for(const condition of ['blur','pagehide','visibility','disconnected','destroy']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.tick();h.button(12);h.tick();assert.deepEqual(h.cameraControl.direction,[0,-1]);
    if(condition==='visibility'){h.document.hidden=true;h.document.dispatchEvent(new Event('visibilitychange'));}
    else if(condition==='disconnected'){const event=new Event('gamepaddisconnected');Object.defineProperty(event,'gamepad',{value:h.pad});h.window.dispatchEvent(event);}
    else if(condition==='destroy')h.driver.gamepad.destroy();
    else h.window.dispatchEvent(new Event(condition));
    assert.equal(h.cameraControl.direction,null,condition);h.close();
  }
});

test('驾驶员自动任务中可控制云台，RB摇杆驾驶时十字键不改变运动输入',async()=>{
  const h=setup();h.role='driver';h.driver.gamepad.selectSource('gamepad');h.driver.navigation.mode='task';h.tick();h.button(15);h.tick();
  assert.deepEqual(h.cameraControl.direction,[1,0]);assert.equal(h.calls.length,0);h.button(15,false);h.driver.navigation.mode='manual';await engage(h);
  h.pad.axes[1]=-1;h.pad.axes[2]=.5;h.button(12);h.tick();await settle();assert.deepEqual(h.cameraControl.direction,[0,-1]);
  const input=h.calls.filter(call=>call.action==='input').at(-1);assert.equal(input.throttle,200);assert.equal(input.turn,82);h.close();
});

test('主地图十字键长按持续平移、松开即停，未接管也可浏览并关闭跟随',()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.node('mapFollow').checked=true;h.tick();
  h.button(15);h.tick();h.tick();assert.equal(h.pans.length,2);assert.deepEqual(h.pans[0],[30,0]);
  assert.equal(h.node('mapFollow').checked,false);assert.equal(h.node('driverMapFollow')['aria-pressed'],'false');
  h.button(15,false);h.tick();assert.equal(h.pans.length,2);assert.equal(h.calls.length,0,'浏览地图不发送接管或运动');
  h.button(12);h.tick();assert.deepEqual(h.pans.at(-1),[0,-30]);
  h.button(12,false);h.button(13);h.tick();assert.deepEqual(h.pans.at(-1),[0,30]);
  h.button(13,false);h.button(14);h.tick();assert.deepEqual(h.pans.at(-1),[-30,0]);h.close();
});

test('十字键斜向速度归一化、相反方向抵消，采样中断不积压平移距离',()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.tick();h.button(12);h.button(15);h.tick();
  assert.ok(Math.abs(Math.hypot(...h.pans.at(-1))-30)<1e-9);assert.ok(h.pans[0][0]>0&&h.pans[0][1]<0);
  h.button(13);h.button(14);h.tick();assert.equal(h.pans.length,1);
  h.button(12,false);h.button(13,false);h.button(14,false);h.tick(450);assert.deepEqual(h.pans.at(-1),[45,0]);
  const count=h.pans.length;h.tick(1000);assert.equal(h.pans.length,count);h.tick();assert.deepEqual(h.pans.at(-1),[30,0]);h.close();
});

test('仅前台主地图与所选手柄可平移，切图传、编辑、失焦、断开及急停即停止',()=>{
  for(const condition of ['video','keyboard','hidden','guest','form','modal','layout','unfocused','disconnected','not-ready','switching','stop']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.node('mapFollow').checked=true;h.tick();
    if(condition==='video')h.driver.nodes['view-driving'].dataset.primary='video';
    if(condition==='keyboard')h.driver.gamepad.selectSource('keyboard');
    if(condition==='hidden')h.visible=false;
    if(condition==='guest')h.role='guest';
    if(condition==='form')h.document.activeElement={closest:()=>true};
    if(condition==='modal')h.document.modal=true;
    if(condition==='layout')h.driver.layout.editing=true;
    if(condition==='unfocused')h.document.focused=false;
    if(condition==='not-ready')h.map.ready=false;
    if(condition==='switching')h.map.switching=true;
    if(condition==='stop')h.button(1);
    h.button(15);if(condition==='disconnected')h.pads=[];h.tick();
    assert.equal(h.pans.length,0,condition);assert.equal(h.node('mapFollow').checked,true,condition+' 不关闭跟随');h.close();
  }
});

test('自动任务 / 守位可浏览主地图；RB摇杆驾驶与十字键互不叠加',async()=>{
  for(const mode of ['task','home']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.navigation.mode=mode;h.driver.nodes['view-driving'].dataset.primary='map';h.tick();h.button(15);h.tick();
    assert.deepEqual(h.pans[0],[30,0]);assert.equal(h.calls.length,0);h.close();
  }
  const h=setup();await engage(h);h.driver.nodes['view-driving'].dataset.primary='map';h.pad.axes[1]=-1;h.pad.axes[2]=.5;h.button(15);h.tick();await settle();
  assert.deepEqual(h.pans[0],[30,0]);assert.equal(h.calls.filter(call=>call.action==='input').at(-1).throttle,200);assert.equal(h.calls.filter(call=>call.action==='input').at(-1).turn,82);
  h.button(15,false);h.tick();await settle();assert.equal(h.driver.active,true);assert.equal(h.pans.length,1);h.close();
});

test('主地图单独A松开恢复跟随并通知居中，长按不重复、再按保持开启且不接管',()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.tick();
  h.button(15);h.tick();assert.equal(h.node('mapFollow').checked,false);h.button(15,false);h.button(0);h.tick();
  assert.equal(h.driver.gamepad.sample.follow,true);assert.equal(h.node('mapFollow').checked,false);assert.deepEqual(h.followChanges,[]);
  h.tick();h.tick();assert.deepEqual(h.followChanges,[],'长按等待释放');h.button(0,false);h.tick();assert.equal(h.node('mapFollow').checked,true);assert.equal(h.node('driverMapFollow')['aria-pressed'],'true');assert.deepEqual(h.followChanges,[true]);
  h.button(0);h.tick();h.button(0,false);h.tick();assert.equal(h.node('mapFollow').checked,true,'A不切换为关闭');assert.deepEqual(h.followChanges,[true,true]);assert.equal(h.calls.length,0);h.close();
});

test('A与十字键同时按住暂停平移，松开A先恢复跟随，下一采样可继续浏览',()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.node('mapFollow').checked=false;h.tick();h.button(15);h.button(0);h.tick();h.tick();
  assert.equal(h.node('mapFollow').checked,false);assert.equal(h.pans.length,0);assert.deepEqual(h.followChanges,[]);
  h.button(0,false);h.tick();assert.equal(h.node('mapFollow').checked,true);assert.equal(h.pans.length,0);h.tick();assert.deepEqual(h.pans[0],[30,0]);assert.equal(h.node('mapFollow').checked,false);h.close();
});

test('A恢复跟随遵守主地图、手柄来源、前台/焦点、编辑、地图就绪及急停条件',()=>{
  for(const condition of ['video','keyboard','hidden','guest','form','modal','layout','unfocused','disconnected','not-ready','switching','stop','LB']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.node('mapFollow').checked=false;h.tick();
    if(condition==='video')h.driver.nodes['view-driving'].dataset.primary='video';
    if(condition==='keyboard')h.driver.gamepad.selectSource('keyboard');
    if(condition==='hidden')h.visible=false;
    if(condition==='guest')h.role='guest';
    if(condition==='form')h.document.activeElement={closest:()=>true};
    if(condition==='modal')h.document.modal=true;
    if(condition==='layout')h.driver.layout.editing=true;
    if(condition==='unfocused')h.document.focused=false;
    if(condition==='not-ready')h.map.ready=false;
    if(condition==='switching')h.map.switching=true;
    if(condition==='stop')h.button(1);
    if(condition==='LB')h.button(4);
    h.button(0);if(condition==='disconnected')h.pads=[];h.tick();if(h.pad)h.button(0,false);h.tick();
    assert.equal(h.node('mapFollow').checked,false,condition);assert.equal(h.followChanges.length,0,condition);assert.equal(h.calls.some(call=>call.action==='acquire'),false,condition);h.close();
  }
});

test('任务/守位可按A恢复跟随，RB驾驶中A不改变操控和运动输入',async()=>{
  for(const mode of ['task','home']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes['view-driving'].dataset.primary='map';h.driver.navigation.mode=mode;h.tick();h.button(0);h.tick();h.button(0,false);h.tick();
    assert.equal(h.node('mapFollow').checked,true);assert.equal(h.calls.length,0);h.close();
  }
  const h=setup();await engage(h);h.driver.nodes['view-driving'].dataset.primary='map';h.pad.axes[1]=-1;h.pad.axes[2]=.5;h.button(0);h.tick();h.button(0,false);h.tick();await settle();
  assert.equal(h.node('mapFollow').checked,true);assert.equal(h.driver.active,true);assert.equal(h.driver.gamepad.engaged,true);
  const input=h.calls.filter(call=>call.action==='input').at(-1);assert.equal(input.throttle,200);assert.equal(input.turn,82);h.close();
});

test('默认键盘，选手柄不会自动接管；回中并松开所有按钮后才可发接管请求',async()=>{
  const h=setup();assert.equal(h.driver.gamepad.enabled(),false);h.driver.gamepad.selectSource('gamepad');
  h.pad.axes[1]=-.5;await h.acquire();assert.equal(h.calls.length,0);assert.match(h.toasts.at(-1),/回中/);
  h.pad.axes[1]=0;h.button(5);await h.acquire();assert.equal(h.calls.length,0);
  h.button(5,false);h.button(0);await h.acquire();assert.equal(h.calls.length,0,'A cannot arm or bypass neutral');
  h.button(0,false);await h.acquire();assert.equal(h.calls[0].action,'acquire');assert.equal(h.calls[0].throttle,0);assert.equal(h.driver.active,true);
  assert.deepEqual(h.driver.gamepad.input(),{forward:0,turn:0});h.close();
});

test('LB 按下切换接管，长按不重复；船端确认后仍须 RB 使能，驾驶中 LB 零输入退出',async()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.tick();h.button(4);h.tick();
  assert.equal(h.driver.pending,true);assert.equal(h.driver.active,false);
  await settle();assert.equal(h.driver.active,true);assert.equal(h.calls.filter(call=>call.action==='acquire').length,1);
  h.tick();h.tick();await settle();assert.equal(h.driver.active,true);assert.equal(h.calls.filter(call=>call.action==='acquire').length,1);
  h.pad.axes[1]=-1;h.tick();await settle();assert.equal(h.calls.filter(call=>call.action==='input').at(-1).throttle,0,'LB alone cannot produce motion');
  h.button(4,false);h.pad.axes[1]=0;h.tick();h.button(5);h.tick();h.pad.axes[1]=-1;h.tick();await settle();
  assert.equal(h.calls.filter(call=>call.action==='input').at(-1).throttle,200);
  h.button(4);h.tick();await settle();assert.equal(h.driver.active,false);assert.match(h.stops.at(-1).message,/LB/);
  assert.ok(h.calls.some(call=>call.action==='release'&&call.throttle===0&&call.turn===0));
  h.tick();await settle();assert.equal(h.calls.filter(call=>call.action==='acquire').length,1);h.close();
});

test('LB 可取消正在等待的接管；迟到船端 ACK 不重新启用',async()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');let acknowledge;h.deferAcquire=()=>new Promise(resolve=>{acknowledge=resolve;});
  h.tick();h.button(4);h.tick();await settle();assert.equal(h.driver.pending,true);
  h.button(4,false);h.tick();h.button(4);h.tick();await settle();
  assert.equal(h.driver.pending,false);assert.equal(h.driver.active,false);assert.match(h.stops.at(-1).message,/取消/);
  acknowledge({active:true,owned:true,state:1,status:'active',leaseId:'0011223344556677',testMode:false});await settle();
  assert.equal(h.driver.active,false);assert.ok(h.calls.some(call=>call.action==='release'));assert.equal(h.calls.some(call=>call.action==='input'),false);h.close();
});

test('LB 不能绕过回中、其他按键、连接就绪、角色、手动模式及编辑条件',async()=>{
  for(const condition of ['axis','RB','A','X','Y','stop','not-ready','guest','task','home','form','modal','layout','unfocused','keyboard']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.tick();
    if(condition==='axis')h.pad.axes[1]=-.5;
    for(const [name,index]of [['RB',5],['A',0],['X',2],['Y',3],['stop',1]])if(condition===name)h.button(index);
    if(condition==='not-ready')h.driver.remote.ready=false;
    if(condition==='guest')h.role='guest';
    if(['task','home'].includes(condition))h.driver.navigation.mode=condition;
    if(condition==='form')h.document.activeElement={closest:()=>true};
    if(condition==='modal')h.document.modal=true;
    if(condition==='layout')h.driver.layout.editing=true;
    if(condition==='unfocused')h.document.focused=false;
    if(condition==='keyboard')h.driver.gamepad.selectSource('keyboard');
    h.button(4);h.tick();await settle();assert.equal(h.calls.some(call=>call.action==='acquire'),false,condition);
    assert.equal(h.driver.active,false,condition);h.close();
  }
});

test('连接、失焦、离页、采样中断或解除编辑后按住的 LB 不自动接管，松开重按才生效',async()=>{
  for(const transition of ['initial','reconnect','blur','hidden','gap','modal','role','mode']){
    const h=setup();h.driver.gamepad.selectSource('gamepad');h.tick();
    if(transition==='initial'){h.driver.gamepad.selectSource('keyboard');h.button(4);h.driver.gamepad.selectSource('gamepad');}
    if(transition==='reconnect'){const pad=h.pad;h.pads=[];h.tick();h.pads=[pad];h.button(4);}
    if(transition==='blur'){h.document.focused=false;h.window.dispatchEvent(new Event('blur'));h.document.focused=true;h.button(4);}
    if(transition==='hidden'){h.visible=false;h.tick();h.visible=true;h.button(4);}
    if(transition==='gap')h.button(4);
    if(transition==='modal'){h.document.modal=true;h.tick();h.document.modal=false;h.button(4);}
    if(transition==='role'){h.role='guest';h.tick();h.role='driver';h.button(4);}
    if(transition==='mode'){h.driver.navigation.mode='task';h.tick();h.driver.navigation.mode='manual';h.button(4);}
    h.tick(transition==='gap'?500:100);await settle();h.tick();await settle();
    assert.equal(h.calls.some(call=>call.action==='acquire'),false,transition);
    h.button(4,false);h.tick();h.button(4);h.tick();await settle();assert.equal(h.driver.active,true,transition);h.close();
  }
});

test('RB 居中使能后比例推进/转向并遵守运动幅度；键盘不能叠加，松 RB 释放操控',async()=>{
  const h=setup();await engage(h);h.pad.axes[1]=-1;h.pad.axes[2]=.5;h.driver.keys.add('KeyS');h.tick();await settle();
  let input=h.calls.filter(call=>call.action==='input').at(-1);assert.equal(input.throttle,200);assert.equal(input.turn,82);
  h.pad.axes[1]=1;h.pad.axes[2]=-1;h.tick();await settle();input=h.calls.filter(call=>call.action==='input').at(-1);assert.equal(input.throttle,-200);assert.equal(input.turn,-200);
  h.driver.nodes.driverLimit.value='100';h.tick();await settle();assert.equal(h.calls.filter(call=>call.action==='input').at(-1).throttle,-1000);
  h.pad.axes[1]=.1;h.pad.axes[2]=-.1;h.tick();await settle();assert.equal(h.calls.filter(call=>call.action==='input').at(-1).throttle,0);
  h.button(5,false);h.tick();await settle();assert.equal(h.driver.active,false);assert.match(h.stops.at(-1).message,/松开 RB/);
  assert.ok(h.calls.some(call=>call.action==='release'&&call.throttle===0&&call.turn===0));h.close();
});

test('接管 ACK 迟到期间动杆/按 RB 不会产生运动；必须重新松键回中',async()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');let release;h.deferAcquire=()=>new Promise(resolve=>{release=resolve;});
  const acquiring=h.driver.acquire();await settle();assert.equal(h.driver.pending,true);h.button(5);h.pad.axes[1]=-1;h.tick();
  assert.equal(h.calls.filter(call=>call.action==='input').length,0);
  release({active:true,owned:true,state:1,status:'active',leaseId:'0011223344556677',testMode:false});await acquiring;await settle();h.tick();await settle();
  assert.equal(h.driver.active,true);assert.ok(h.calls.filter(call=>call.action==='input').every(call=>call.throttle===0));
  h.pad.axes[1]=0;h.tick();await settle();assert.equal(h.driver.gamepad.engaged,false,'Held RB must first be released');
  h.button(5,false);h.tick();await settle();h.button(5);h.tick();await settle();h.pad.axes[1]=-1;h.tick();await settle();
  assert.equal(h.calls.filter(call=>call.action==='input').at(-1).throttle,200);h.close();
});

test('断开后不替换另一只手柄，重连不恢复操控；索引被其他型号重用也拒绝',async()=>{
  const h=setup();await engage(h);const original=h.pad,selected=h.driver.gamepad.selectedKey;h.pads=[null,makePad(1,'second controller')];h.tick();await settle();
  assert.equal(h.driver.active,false);assert.equal(h.driver.gamepad.selectedKey,selected);assert.equal(h.driver.gamepad.sample,null);assert.equal(h.stops.at(-1).emergency,true);
  h.pads=[original,makePad(1,'second controller')];h.tick();assert.equal(h.driver.active,false);assert.equal(h.driver.gamepad.sample.id,original.id);
  await h.acquire();h.pads=[makePad(0,'different controller')];h.tick();assert.equal(h.driver.active,false);assert.equal(h.driver.gamepad.sample,null);h.close();
});

test('接管等待中失去手柄会取消；迟到 ACK 仅发送释放，不激活旧会话',async()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');let release;h.deferAcquire=()=>new Promise(resolve=>{release=resolve;});
  const task=h.driver.acquire();await settle();h.pads=[];h.tick();assert.equal(h.driver.pending,false);
  release({active:true,owned:true,state:1,status:'active',leaseId:'0011223344556677',testMode:false});await task;await settle();
  assert.equal(h.driver.active,false);assert.ok(h.calls.some(call=>call.action==='release'));assert.equal(h.calls.some(call=>call.action==='input'),false);h.close();
});

test('航向模式右杆改变目标角并跨北展开，turn 保持零；回中不继续累加',async()=>{
  const h=setup();h.driver.actualHeading=359;h.driver.nodes.driverMode.value='2';await engage(h);
  h.pad.axes[1]=-1;h.pad.axes[2]=1;h.tick();await settle();const input=h.calls.filter(call=>call.action==='input').at(-1);
  assert.equal(input.mode,2);assert.equal(input.turn,0);assert.equal(input.targetHeading,200);assert.equal(input.throttle,200);
  h.pad.axes[2]=0;h.tick();await settle();assert.equal(h.driver.nodes.driverHeading.value,'2.00');h.close();
});

test('B/菜单急停优先于表单，Y 按下沿交换画面，X 只能在未接管时切换模式',async()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.button(3);h.tick();assert.equal(h.driver.nodes['view-driving'].dataset.primary,'map');h.tick();assert.equal(h.driver.nodes['view-driving'].dataset.primary,'map');
  h.button(3,false);h.button(2);h.tick();assert.equal(h.driver.nodes.driverMode.value,'1');h.button(2,false);await engage(h);
  h.button(2);h.tick();assert.equal(h.driver.nodes.driverMode.value,'1');h.document.modal=true;h.button(1);h.tick();await settle();
  assert.equal(h.driver.active,false);assert.equal(h.stops.at(-1).emergency,true);assert.ok(h.calls.some(call=>call.action==='stop'));h.close();
});

test('读取异常、映射变化、浏览器采样停顿以及输入框编辑均撤销手柄控制',async()=>{
  for(const failure of ['api','mapping','gap','form']){
    const h=setup();await engage(h);
    if(failure==='api')h.failure=Error('permission denied');
    if(failure==='mapping')h.pad.mapping='';
    if(failure==='form')h.document.activeElement={closest:()=>true};
    h.tick(failure==='gap'?500:100);await settle();assert.equal(h.driver.active,false,failure);assert.deepEqual(h.driver.gamepad.input(),{forward:0,turn:0});h.close();
  }
});

test('切换输入源先释放，刷新仍默认键盘，死区仅保存本机；访客不能用手柄接管',async()=>{
  const h=setup();await engage(h);h.driver.gamepad.selectSource('keyboard');await settle();assert.equal(h.driver.active,false);assert.equal(h.driver.gamepad.enabled(),false);assert.equal(h.driver.keys.size,0);
  h.node('driverGamepadDeadzone').value='60';h.node('driverGamepadDeadzone').dispatchEvent(new Event('change'));assert.equal(h.driver.gamepad.deadzone,.3);assert.equal(h.stored.get('boat-driver-gamepad-deadzone'),'0.3');
  h.role='guest';h.driver.gamepad.selectSource('gamepad');await h.acquire();assert.equal(h.driver.active,false);assert.equal(h.node('driverInputSource').disabled,true);h.close();
  const fresh=setup();assert.equal(fresh.driver.gamepad.source,'keyboard');fresh.close();
});

test('测试场景手柄沿用真实 PWM 参数；X 跳过缺少航向反馈的定向模式',async()=>{
  const h=setup();h.driver.gamepad.selectSource('gamepad');h.driver.nodes.driverMode.value='1';h.button(2);h.tick();assert.equal(h.driver.nodes.driverMode.value,'0');
  h.button(2,false);h.driver.testMode=true;h.driver.nodes.driverMode.disabled=true;await h.acquire();h.tick();h.button(5);h.tick();await settle();h.pad.axes[1]=-1;h.tick();await settle();
  const input=h.calls.filter(call=>call.action==='input').at(-1);assert.equal(input.mode,0);assert.equal(input.testMode,true);assert.equal(input.throttle,200);h.close();
});
