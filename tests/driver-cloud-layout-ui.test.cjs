'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {BoatDriverCloudLayout}=require('../public/driver-cloud-layout');
const {normalizeCloudLayout}=require('../public/utils/driverLayout');
const cloudLayout=()=>({version:1,profiles:{'desktop:video':{map:{width:400,height:250,opacity:80}}},preferences:{overlayOpacity:65,instrumentsVisible:true,primary:'map'}});
const snapshot=(extra={})=>({version:1,revision:0,enabled:false,layout:null,updatedAt:null,persistent:true,error:null,...extra});
const reply=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});
async function until(check){for(let count=0;count<120;count++){if(check())return;await Promise.resolve();}assert.fail('Expected asynchronous layout operation');}
function setup(role='admin'){
  class Node extends EventTarget{constructor(){super();this.hidden=false;this.disabled=false;this.dataset={};this.value='100';this.textContent='';}setAttribute(name,value){this[name]=value;}}
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const document=new EventTarget();document.hidden=false;document.getElementById=node;
  const scope=new EventTarget(),timers=new Map(),calls=[],notices=[],changes=[];let next,id=0;
  class Auth extends EventTarget{constructor(){super();this.enabled=true;this.ready=true;this.user=role?{role,username:role}:null;this.generation=1;}change(role){this.generation++;this.user=role?{role,username:role}:null;this.dispatchEvent(new Event('change'));}async verifyPlatformManage(){if(this.user?.role!=='admin')throw Error('administrator required');if(this.verify)await this.verify();this.dispatchEvent(new Event('change'));}expire(){this.change(null);}}
  const auth=new Auth(),localProfiles={'desktop:video':{map:{width:250,height:170}}};
  const layout={cloudLocked:false,profiles:structuredClone(localProfiles),personalProfiles:null,ui:{driverLayoutSaved:node('driverLayoutSaved')},
    useCloudProfiles(profiles){changes.push(profiles);if(profiles){if(!this.cloudLocked)this.personalProfiles=this.profiles;this.profiles=structuredClone(profiles);this.cloudLocked=true;}else if(this.cloudLocked){this.profiles=this.personalProfiles;this.personalProfiles=null;this.cloudLocked=false;}},
    snapshot(preferences){return normalizeCloudLayout({version:1,profiles:this.profiles,preferences});}};
  const driver={layout,nodes:{driverOverlayOpacity:node('driverOverlayOpacity'),driverInstrumentToggle:node('driverInstrumentToggle'),'view-driving':node('view-driving')},visible:()=>true,toast:message=>notices.push(message),
    setOverlayOpacity(value,options){assert.equal(options.persist,false);this.nodes.driverOverlayOpacity.value=String(value);},
    setInstrumentsVisible(value,options){assert.equal(options.persist,false);this.nodes['view-driving'].dataset.instrumentsHidden=String(!value);},
    setMediaFocus(value){this.nodes['view-driving'].dataset.primary=value;}};
  driver.nodes['view-driving'].dataset={primary:'video',instrumentsHidden:'true'};
  const panel=new BoatDriverCloudLayout({scope,document,auth,driver,fetch:async(url,options)=>{calls.push({url,...options});return next?next(url,options):reply(snapshot());},
    setTimeout(fn,duration){const key=++id;timers.set(key,{fn,duration});return key;},clearTimeout:key=>timers.delete(key)});
  return {panel,driver,layout,auth,nodes,node,timers,calls,notices,changes,localProfiles,document,next:fn=>{next=fn;},async ready(){await until(()=>panel.loaded&&!panel.busy);},
    timeout(){const [key,timer]=[...timers].find(([,value])=>value.duration===10000)||[];assert.ok(timer);timers.delete(key);timer.fn();}};
}
test('上传只保存本机布局，显式启用后锁定显示偏好；停用恢复个人布局而不保存云端副本到本机',async()=>{
  const h=setup();await h.ready();let state=snapshot();
  h.next(async(_,options)=>{const body=JSON.parse(options.body);if(options.method==='PUT')state=snapshot({revision:1,layout:body.layout,updatedAt:'2026-11-07T01:00:00Z'});else state={...state,revision:state.revision+1,enabled:body.enabled};return reply(state);});
  assert.equal(await h.panel.upload(),true);assert.equal(h.layout.cloudLocked,false);assert.equal(state.enabled,false);
  assert.deepEqual(state.layout.profiles,h.localProfiles);assert.equal(h.calls.at(-1).method,'PUT');
  state.layout=cloudLayout();assert.equal(await h.panel.setEnabled(true),true);assert.equal(h.layout.cloudLocked,true);assert.equal(h.driver.nodes.driverOverlayOpacity.value,'65');
  assert.equal(h.driver.nodes.driverInstrumentToggle.disabled,true);assert.equal(h.panel.preferredPrimary(),'map');assert.equal(h.node('driverCloudLayoutUpload').disabled,true);
  assert.equal(await h.panel.upload(),false);assert.equal(await h.panel.setEnabled(false),true);assert.equal(h.layout.cloudLocked,false);assert.deepEqual(h.layout.profiles,h.localProfiles);
  assert.equal(h.driver.nodes.driverOverlayOpacity.value,'100');assert.equal(h.driver.nodes['view-driving'].dataset.instrumentsHidden,'true');assert.equal(h.driver.nodes.driverInstrumentToggle.disabled,false);h.panel.destroy();
});
test('同版本轮询不重新应用布局或媒体主画面，服务器新版本会自动更新，断网保留已获取的统一布局',async()=>{
  const h=setup();await h.ready();let value=snapshot({revision:2,enabled:true,layout:cloudLayout(),updatedAt:'2026-11-07T01:00:00Z'});h.next(async()=>reply(value));
  assert.equal(await h.panel.read(),true);const count=h.changes.length;h.driver.setMediaFocus('video');await h.panel.read();assert.equal(h.changes.length,count);assert.equal(h.driver.nodes['view-driving'].dataset.primary,'video');
  value={...value,revision:3,layout:cloudLayout()};value.layout.preferences.overlayOpacity=45;await h.panel.read();assert.equal(h.driver.nodes.driverOverlayOpacity.value,'45');
  h.next(async()=>{throw Error('offline');});assert.equal(await h.panel.read(),false);assert.equal(h.layout.cloudLocked,true);assert.equal(h.driver.nodes.driverOverlayOpacity.value,'45');h.panel.destroy();
});
test('驾驶员和访客读取统一布局，但看不到管理员操作，也不能上传或启停',async()=>{
  for(const role of ['driver','guest']){const h=setup(role);await h.ready();assert.equal(h.node('driverCloudLayoutActions').hidden,true);assert.equal(await h.panel.upload(),false);assert.equal(await h.panel.setEnabled(true),false);assert.equal(h.calls.filter(call=>call.method!=='GET').length,0);h.panel.destroy();}
});
test('退出或切换身份取消请求，迟到的旧响应不能重新锁定新用户；原本机布局得到恢复',async()=>{
  const h=setup();await h.ready();const enabled=snapshot({revision:2,enabled:true,layout:cloudLayout(),updatedAt:'2026-11-07T01:00:00Z'});
  h.next(async()=>reply(enabled));await h.panel.read();assert.equal(h.layout.cloudLocked,true);let release;
  h.next(()=>new Promise(resolve=>{release=resolve;}));const waiting=h.panel.read();await until(()=>!!release);h.auth.change(null);assert.equal(await waiting,false);assert.equal(h.layout.cloudLocked,false);assert.deepEqual(h.layout.profiles,h.localProfiles);
  release(reply(enabled));await Promise.resolve();await Promise.resolve();assert.equal(h.panel.state,null);assert.equal(h.node('driverCloudLayoutActions').hidden,true);h.panel.destroy();
});
test('管理员校验途中降权不能发送写请求，操作冲突后刷新服务器状态',async()=>{
  const h=setup();await h.ready();let release;h.auth.verify=()=>new Promise(resolve=>{release=resolve;});const saving=h.panel.upload();await until(()=>!!release);h.auth.change('driver');release();assert.equal(await saving,false);assert.equal(h.calls.some(call=>call.method==='PUT'),false);h.panel.destroy();
  const g=setup();await g.ready();g.next(async(_,options)=>options.method==='PUT'?reply({error:'revision conflict'},409):reply(snapshot({revision:4,layout:cloudLayout(),updatedAt:'2026-11-07T01:00:00Z'})));
  assert.equal(await g.panel.upload(),false);await until(()=>g.panel.state.revision===4&&!g.panel.busy);assert.match(g.notices[0],/revision conflict/);assert.equal(g.panel.state.enabled,false);g.panel.destroy();
});
test('包含响应体的请求超时可重试，非法响应不会替换当前布局或确认发布',async()=>{
  const h=setup();await h.ready();let release;h.next(async()=>({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})}));
  const reading=h.panel.read();await until(()=>!!release);h.timeout();assert.equal(await reading,false);assert.match(h.node('driverCloudLayoutStatus').textContent,/超时/);assert.equal(h.panel.busy,false);
  h.next(async()=>reply(snapshot({enabled:true,layout:null})));assert.equal(await h.panel.read(),false);assert.equal(h.layout.cloudLocked,false);assert.match(h.node('driverCloudLayoutStatus').textContent,/响应无效/);
  h.next(async()=>reply(snapshot()));assert.equal(await h.panel.read(),true);release(snapshot({revision:7,enabled:true,layout:cloudLayout(),updatedAt:'2026-11-07T01:00:00Z'}));await Promise.resolve();await Promise.resolve();assert.equal(h.panel.state.revision,0);assert.equal(h.layout.cloudLocked,false);h.panel.destroy();
});
