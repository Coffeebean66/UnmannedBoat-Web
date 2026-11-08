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
  }
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const document=Object.assign(new EventTarget(),{activeElement:null,modal:false,focused:true,hasFocus(){return this.focused;},getElementById:node,createElement:()=>new Node(),querySelector(){return this.modal?{open:true}:null;},querySelectorAll:()=>[]});
  const stored=new Map(),window=new EventTarget();Object.assign(window,{Event,isSecureContext:true,setTimeout,clearTimeout,localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)},BoatWorkspace:{current:'driving'}});
  let now=0,visible=true,role='admin',pads=[makePad()],failure;
  const navigator={getGamepads(){if(failure)throw failure;return pads;}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/driver-control.js'),'utf8'),{window,AbortController,performance:{now:()=>now}});
  const driver=Object.create(window.BoatDriverControl.prototype),calls=[],toasts=[],stops=[];
  Object.assign(driver,{document,nodes:{'view-driving':node('view-driving'),driverMode:node('driverMode'),driverLimit:node('driverLimit'),driverHeading:node('driverHeading'),driverEmergency:node('driverEmergency')},
    context:{deviceId:'boat-01'},keys:new Set(),generation:0,sequence:0,clientId:'1122334455667788',leaseId:'',active:false,pending:false,testMode:false,remote:{ready:true,testSupported:true},
    inputRequests:new Map(),lastInputSentAt:-Infinity,lastInputSignature:'',lastInputResponseAt:0,lastAcceptedSequence:0,lastPulse:0,lastPoll:0,layout:{editing:false},navigation:{mode:'manual'},destroyed:false,
    visible:()=>visible,admin:()=>['admin','driver'].includes(role),permitted:()=>visible&&['admin','driver'].includes(role)&&!driver.layout.editing&&driver.navigation.mode==='manual',
    toast:message=>toasts.push(message),renderKeys(){},headingMode(){},render(){this.gamepad?.render();},poll(){},setTestMode(value){this.testMode=value;},setMediaFocus(value){this.nodes['view-driving'].dataset.primary=value;},
    async api(body){calls.push(body);if(body.action==='acquire'&&h.deferAcquire)return h.deferAcquire();return {active:true,owned:true,state:1,status:'active',leaseId:'0011223344556677',testMode:!!body.testMode,sequence:body.sequence??0};}});
  const originalStop=driver.stop;driver.stop=function(message,emergency){if(this.active||this.pending)stops.push({message,emergency});return originalStop.call(this,message,emergency);};
  driver.nodes.driverMode.value='0';driver.nodes.driverLimit.value='20';driver.nodes.driverHeading.value='359';driver.nodes['view-driving'].dataset.primary='video';
  driver.nodes.driverEmergency.addEventListener('click',()=>driver.stop('手柄急停',true));
  driver.nodes.driverMode.addEventListener('change',()=>driver.gamepad.reset());
  const h={driver,document,window,node,calls,stops,toasts,stored,get pad(){return pads[0];},set pads(value){pads=value;},set failure(value){failure=value;},set role(value){role=value;},set visible(value){visible=value;},
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
