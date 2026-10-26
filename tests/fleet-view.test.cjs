'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/fleet-view.js'),'utf8');
const makeSummary=(now,changes={})=>({receivedAt:now,speedMps:1.2,targetSpeedMps:1.5,headingDegrees:45,latitude:31.23,longitude:121.47,voltageV:24.2,controlMode:1,
  validUntil:{speedMps:now+1000,targetSpeedMps:now+1000,headingDegrees:now+1000,position:now+1000,voltageV:now+1000,controlMode:now+1000},...changes});
function fixture(){
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();this.textContent='';this.value='';this.hidden=false;}
    append(child){if(child.parentElement)child.remove();this.children.push(child);child.parentElement=this;}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
    setAttribute(name,value){this.attributes[name]=value;}
    addEventListener(name,handler){this.listeners.set(name,handler);}
    removeEventListener(name){this.listeners.delete(name);}
    fire(name){this.listeners.get(name)?.({target:this});}
  }
  const ids=['fleetTotal','fleetOnline','fleetOffline','fleetMoving','fleetVisibleCount','fleetStreamState','fleetSearch','fleetFilter','fleetCards','fleetEmpty','fleetEmptyTitle','fleetEmptyDescription','fleetRecentList','fleetRecentSummary','fleetRecentEmpty'];
  const nodes=Object.fromEntries(ids.map(id=>[id,new Element('div')]));nodes.fleetFilter.value='all';
  const document={hidden:false,getElementById:id=>nodes[id],createElement:tag=>new Element(tag)};
  let now=1700000000000,tick,cleared=false;const selections=[];
  const window={setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{cleared=true;},document};
  vm.runInNewContext(source,{window,Date});
  const view=new window.BoatFleetView({onSelect:id=>selections.push(id),document,now:()=>now});
  const state={authenticated:true,enabled:true,brokerConnected:true,streamConnected:true,serverOffset:0,devices:[]};
  return {view,nodes,state,selections,prepare:window.BoatFleetView.prepareDevice,get now(){return now;},advance:milliseconds=>{now+=milliseconds;tick();},get cleared(){return cleared;}};
}
test('两船速度、定位、电压互相独立，点击详情只选择对应设备，更新保留原按钮节点',()=>{
  const f=fixture();f.state.devices=[{id:'boat-01',online:true,lastReceivedAt:f.now,summary:makeSummary(f.now)},{id:'boat-02',online:true,lastReceivedAt:f.now,summary:makeSummary(f.now,{speedMps:2.6,latitude:32.5,voltageV:25.4})}];
  f.view.update(f.state);assert.equal(f.nodes.fleetTotal.textContent,'2');assert.equal(f.nodes.fleetMoving.textContent,'2');
  const a=f.view.cards.get('boat-01'),b=f.view.cards.get('boat-02');assert.equal(a.speed.textContent,'1.20');assert.equal(b.speed.textContent,'2.60');assert.equal(b.latitude.textContent,'32.500000');assert.equal(a.voltage.textContent,'24.2');
  b.button.fire('click');assert.deepEqual(f.selections,['boat-02']);
  f.state.selectedId='boat-02';f.state.devices[0].summary.speedMps=1.8;f.view.update(f.state);
  assert.equal(f.view.cards.get('boat-02').button,b.button);assert.equal(b.article.dataset.selected,'true');assert.equal(a.speed.textContent,'1.80');assert.equal(b.speed.textContent,'2.60');f.view.destroy();
});
test('源失效时间独立：速度仍有效时过期定位和航向不显示；一秒无新包所有测量清空',()=>{
  const f=fixture(),summary=makeSummary(f.now);summary.validUntil.position=f.now+100;summary.validUntil.headingDegrees=f.now+200;
  f.state.devices=[{id:'boat-01',online:true,lastReceivedAt:f.now,summary}];f.view.update(f.state);const a=f.view.cards.get('boat-01');
  f.advance(250);assert.equal(a.latitude.textContent,'--');assert.equal(a.longitude.textContent,'--');assert.equal(a.heading.textContent,'--');assert.equal(a.speed.textContent,'1.20');assert.equal(a.fix.dataset.valid,'false');
  f.advance(750);assert.equal(a.speed.textContent,'--');assert.equal(a.voltage.textContent,'--');assert.equal(a.mode.textContent,'--');assert.equal(f.nodes.fleetMoving.textContent,'0');assert.equal(a.status.textContent,'等待新数据');f.view.destroy();
});
test('Broker和SSE任一断线不把历史测量当实时，船卡保留且离线数量正确',()=>{
  for(const field of ['brokerConnected','streamConnected']){
    const f=fixture();f.state.devices=[{id:'boat-01',online:true,lastReceivedAt:f.now,summary:makeSummary(f.now)}];f.view.update(f.state);f.state[field]=false;f.view.update(f.state);
    assert.equal(f.nodes.fleetTotal.textContent,'1');assert.equal(f.nodes.fleetOnline.textContent,'0');assert.equal(f.nodes.fleetOffline.textContent,'1');assert.equal(f.view.cards.get('boat-01').speed.textContent,'--');f.view.destroy();
  }
});
test('搜索与在线过滤保持各船选择对象，账号退出立即移除船卡与测量',()=>{
  const f=fixture();f.state.devices=[{id:'boat-01',online:true,lastReceivedAt:f.now,summary:makeSummary(f.now)},{id:'boat-02',online:false,lastReceivedAt:f.now-5000,summary:null}];f.view.update(f.state);
  f.nodes.fleetSearch.value='BOAT-02';f.nodes.fleetSearch.fire('input');assert.equal(f.view.cards.get('boat-01').article.hidden,true);assert.equal(f.view.cards.get('boat-02').article.hidden,false);
  f.nodes.fleetFilter.value='online';f.nodes.fleetFilter.fire('change');assert.equal(f.nodes.fleetEmpty.hidden,false);assert.match(f.nodes.fleetEmptyTitle.textContent,/没有匹配/);
  f.view.update({...f.state,authenticated:false});assert.equal(f.view.cards.size,0);assert.equal(f.nodes.fleetTotal.textContent,'0');assert.match(f.nodes.fleetEmptyTitle.textContent,/登录/);f.view.destroy();assert.equal(f.cleared,true);
});
test('新增设备未知值不显示零，NaN、非法坐标和无源期限均不当有效数据',()=>{
  const f=fixture(),device={id:'boat-new',online:true,lastReceivedAt:null,summary:null};let value=f.prepare(device,{now:f.now,brokerConnected:true,streamConnected:true});
  assert.equal(value.speed,'--');assert.equal(value.ageText,'尚无遥测');assert.equal(value.mode,'--');
  device.summary=makeSummary(f.now,{speedMps:NaN,latitude:91,voltageV:'24',validUntil:{}});value=f.prepare(device,{now:f.now,brokerConnected:true,streamConnected:true});
  for(const key of ['speed','voltage','heading','mode','latitude','longitude'])assert.equal(value[key],'--');f.view.destroy();
});
test('服务器时钟偏移参与源过期判断、64台上限和移除设备不会遗留旧船卡',()=>{
  const f=fixture();f.state.serverOffset=60000;f.state.devices=Array.from({length:65},(_,i)=>({id:'boat-'+i,online:true,lastReceivedAt:f.now+60000,summary:makeSummary(f.now+60000)}));f.view.update(f.state);
  assert.equal(f.view.cards.size,64);assert.equal(f.nodes.fleetOnline.textContent,'64');assert.equal(f.view.cards.get('boat-0').speed.textContent,'1.20');
  f.state.devices=f.state.devices.slice(1);f.view.update(f.state);assert.equal(f.view.cards.has('boat-0'),false);assert.equal(f.view.cards.has('boat-64'),true);assert.equal(f.view.cards.size,64);f.view.destroy();
});
test('最近遥测按服务端收帧时间排序，只展示有真实收帧时间的船并可选中详情',()=>{
  const f=fixture();f.state.devices=[
    {id:'boat-old',online:true,lastReceivedAt:f.now-5000,summary:makeSummary(f.now-5000)},
    {id:'boat-new',online:true,lastReceivedAt:f.now,summary:makeSummary(f.now)},
    {id:'boat-unknown',online:false,lastReceivedAt:null,summary:null}
  ];f.view.update(f.state);
  const rows=f.nodes.fleetRecentList.children;assert.equal(rows.length,2);assert.equal(rows[0].children[0].textContent,'boat-new');
  assert.match(rows[0].children[1].textContent,/在线/);assert.match(rows[0].children[2].textContent,/刚刚更新/);
  rows[0].fire('click');assert.deepEqual(f.selections,['boat-new']);
  f.state.devices=f.state.devices.slice(0,1);f.view.update(f.state);assert.equal(f.nodes.fleetRecentList.children.length,1);assert.equal(f.nodes.fleetRecentList.children[0].children[0].textContent,'boat-old');
  f.view.update({...f.state,authenticated:false});assert.equal(f.nodes.fleetRecentList.children.length,0);assert.equal(f.nodes.fleetRecentEmpty.hidden,false);f.view.destroy();
});
test('平台和调参是独立dialog，平台模块不进入单船参数表，所有UI资源均被加载',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const platform=html.match(/<dialog id="platformSettingsDialog"[\s\S]*?<\/dialog>/)[0],parameters=html.match(/<dialog id="settingsDialog"[\s\S]*?<\/dialog>/)[0];
  for(const id of ['userManagement','mqttDeviceSettings','mapSettings']){assert.ok(platform.includes('id="'+id+'"'));assert.ok(!parameters.includes('id="'+id+'"'));}
  for(const id of ['parameterDeviceName','parameterDeviceNotice','parameterFields','readParameters','writeParameters','saveFlash'])assert.ok(parameters.includes('id="'+id+'"'));
  for(const asset of ['fleet-view.js','fleet-map-view.js','fleet.css','settings-layout.css','fleet-transport.js'])assert.ok(html.includes('"'+asset+'"'));
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size);assert.ok(!html.includes('????'));
});
