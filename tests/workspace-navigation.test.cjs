const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../public/workspace-navigation.js'),'utf8');
const names = ['overview','navigation','attitude','analysis','propulsion','diagnostics','video','driving','missions'];

function setup(hash = '', includeFleet = false, authState = {}) {
  const activeNames = includeFleet ? ['fleet',...names] : names;
  const nodes = new Map(), slots = new Map(), handlers = new Map(), events = [], scrolls = [];
  const location = {hash}, entries = [hash]; let cursor = 0;
  function node(id) {
    const value = {id,hidden:false,open:false,dataset:{},attributes:{},children:[],parentElement:null,textContent:'',classes:new Set(),
      classList:{toggle(name,enabled){enabled ? value.classes.add(name) : value.classes.delete(name);}},
      setAttribute(name,val){this.attributes[name]=val;},removeAttribute(name){delete this.attributes[name];},
      append(child){if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(item=>item!==child);this.children.push(child);child.parentElement=this;},
      focus(options){document.activeElement=this;this.focusOptions=options;},
      closest(){return this;}};
    nodes.set(id,value);return value;
  }
  const panels = activeNames.map(name => {const panel=node('view-'+name);panel.dataset.workspaceView=name;panel.hidden=name!==(includeFleet?'fleet':'overview');return panel;});
  for (const name of ['overview-map','overview-attitude','overview-sensors','navigation-map','attitude-model','attitude-sensors','video-playback','propulsion-motors','driving-map','driving-model','driving-sensors','driving-video','driving-motors']) {
    const slot=node(name);slots.set(name,slot);panels.find(panel=>panel.dataset.workspaceView===name.split('-')[0]).append(slot);
  }
  for (const [id,slot] of [['navigation','overview-map'],['attitude','overview-attitude'],['sensorTelemetry','overview-sensors'],['videoCard','video-playback'],['motors','propulsion-motors']]) slots.get(slot).append(node(id));
  for (const id of ['viewTitle','viewEnglish','viewSubtitle','singleBoatNav','singleBoatNavName','workspaceBreadcrumbView','workspaceBreadcrumbBoat']) node(id);
  const links = [...activeNames,...activeNames].map((name,index)=>Object.assign(node('link-'+index),{hash:'#'+name}));
  const document = {
    documentElement:{dataset:{}},activeElement:null,title:'',
    getElementById:id=>nodes.get(id),querySelectorAll:selector=>selector==='[data-workspace-view]'?panels:links,
    querySelector:selector=>slots.get(selector.match(/data-workspace-slot="([^"]+)"/)?.[1]),
    addEventListener(name,handler){handlers.set(name,handler);}
  };
  const window = new EventTarget();window.location=location;window.scrollTo=options=>scrolls.push(options);
  const auth = new EventTarget();Object.assign(auth,{ready:true,enabled:true,user:{username:'captain',role:'admin'}},authState);window.BoatAuth=auth;
  window.history = {
    state:{preserved:true},scrollRestoration:'auto',
    pushState(state,title,next){entries.splice(cursor+1);entries.push(next);cursor++;location.hash=next;},
    replaceState(state,title,next){entries[cursor]=next;location.hash=next;},
    back(){if(cursor>0){location.hash=entries[--cursor];window.dispatchEvent(new Event('popstate'));window.dispatchEvent(new Event('hashchange'));}},
    forward(){if(cursor<entries.length-1){location.hash=entries[++cursor];window.dispatchEvent(new Event('popstate'));window.dispatchEvent(new Event('hashchange'));}}
  };
  window.addEventListener('boat-view-change',event=>events.push({view:event.detail.view,previous:event.detail.previous,visible:panels.filter(panel=>!panel.hidden).map(panel=>panel.dataset.workspaceView),mapParent:nodes.get('navigation').parentElement.id}));
  vm.runInNewContext(source,{window,document,CustomEvent});
  return {window,document,nodes,slots,panels,links,events,scrolls,entries,auth,
    setAuth(values){Object.assign(auth,values);auth.dispatchEvent(new Event('change'));},
    click(name,options={}){let prevented=false;handlers.get('click')({button:0,target:links[activeNames.indexOf(name)],preventDefault(){prevented=true;},...options});return prevented;},
    hash(next){location.hash=next;window.dispatchEvent(new Event('hashchange'));}
  };
}

test('首次恢复独立页面或修正无效片段，不额外增加历史记录、不抢焦点',()=>{
  for (const [hash,view] of [['#analysis','analysis'],['','overview'],['#missing','overview']]) {
    const s=setup(hash);
    assert.equal(s.window.BoatWorkspace.current,view);
    assert.equal(s.window.location.hash,'#'+view);assert.equal(s.entries.length,1);assert.equal(s.document.activeElement,null);
    assert.deepEqual(s.panels.filter(panel=>!panel.hidden).map(panel=>panel.dataset.workspaceView),[view]);
    assert.equal(s.document.documentElement.dataset.workspaceView,view);assert.equal(s.window.history.scrollRestoration,'manual');
    assert.ok(s.links.filter(link=>link.hash==='#'+view).every(link=>link.attributes['aria-current']==='page'));
    assert.ok(s.links.every(link=>link.attributes['aria-label']&&link.title&&link.attributes['aria-controls']));
  }
});

test('访客桌面与手机入口均隐藏，地址直达、代码导航和历史记录无法打开驾驶或任务页',()=>{
  const guest={username:'observer',role:'guest'};
  for(const destination of ['driving','missions']){
    const s=setup('#'+destination,true,{user:guest});
    assert.equal(s.window.BoatWorkspace.current,'fleet');assert.equal(s.window.location.hash,'#fleet');
    assert.equal(s.entries.length,1);assert.equal(s.nodes.get('view-'+destination).hidden,true);
    assert.ok(s.links.filter(link=>['#driving','#missions'].includes(link.hash)).every(link=>link.hidden));
    assert.ok(s.links.filter(link=>!['#driving','#missions'].includes(link.hash)).every(link=>!link.hidden));
    assert.equal(s.window.BoatWorkspace.navigate(destination),'fleet');assert.equal(s.click(destination),true);
    s.hash('#'+destination);assert.equal(s.window.location.hash,'#fleet');
    assert.ok(s.events.every(event=>!['driving','missions'].includes(event.view)));
  }
  const s=setup('#overview',true);s.click('driving');s.click('analysis');s.setAuth({user:guest});
  s.window.history.back();assert.equal(s.window.BoatWorkspace.current,'fleet');assert.equal(s.window.location.hash,'#fleet');
  s.window.history.forward();assert.equal(s.window.BoatWorkspace.current,'analysis');
});

test('管理员降为访客或退出立即离开驾驶/任务，恢复管理员入口无需刷新且保留监测面板',()=>{
  for(const destination of ['driving','missions']){
    const s=setup('#'+destination,true), map=s.nodes.get('navigation');
    assert.equal(s.window.BoatWorkspace.current,destination);
    s.setAuth({user:{username:'observer',role:'guest'}});
    assert.equal(s.window.BoatWorkspace.current,'fleet');assert.equal(s.nodes.get('view-'+destination).hidden,true);
    assert.equal(s.events.at(-1).previous,destination);assert.equal(s.events.at(-1).view,'fleet');
    assert.ok(s.links.filter(link=>['#driving','#missions'].includes(link.hash)).every(link=>link.hidden));
    s.click('overview');assert.equal(s.nodes.get('navigation'),map);assert.equal(map.parentElement,s.slots.get('overview-map'));
    s.setAuth({user:{username:'captain',role:'admin'}});s.click(destination);
    assert.equal(s.window.BoatWorkspace.current,destination);
    assert.ok(s.links.every(link=>!link.hidden));
    s.setAuth({user:null});assert.equal(s.window.BoatWorkspace.current,'fleet');assert.equal(s.nodes.get('view-'+destination).hidden,true);
  }
});

test('权限检查期间隐藏专用页，管理员登录后恢复原链接，访客登录放弃受限目标',()=>{
  for(const destination of ['driving','missions']){
    const s=setup('#'+destination,true,{ready:false,enabled:null,user:null});
    assert.equal(s.window.BoatWorkspace.current,'fleet');assert.equal(s.events.some(event=>event.view===destination),false);
    s.setAuth({ready:true,enabled:true,user:null});assert.equal(s.window.BoatWorkspace.current,'fleet');
    s.setAuth({user:{username:'captain',role:'admin'}});assert.equal(s.window.BoatWorkspace.current,destination);
    const g=setup('#'+destination,true,{ready:false,enabled:null,user:null});
    g.setAuth({ready:true,enabled:true,user:{username:'observer',role:'guest'}});assert.equal(g.window.BoatWorkspace.current,'fleet');
    g.setAuth({user:{username:'captain',role:'admin'}});assert.equal(g.window.BoatWorkspace.current,'fleet','访客已经拒绝的旧链接不在切换管理员后突然打开');
  }
});

test('旧访问密码模式保留专用页展示，账户检查失败仍隐藏',()=>{
  const legacy=setup('#driving',true,{enabled:false,user:null});assert.equal(legacy.window.BoatWorkspace.current,'driving');
  assert.ok(legacy.links.every(link=>!link.hidden));
  legacy.setAuth({ready:false,enabled:true,user:null});assert.equal(legacy.window.BoatWorkspace.current,'fleet');
  assert.ok(legacy.links.filter(link=>['#driving','#missions'].includes(link.hash)).every(link=>link.hidden));
});

test('点击切换页面、只移动同一面板实例，返回概览恢复面板且不丢失内部状态',()=>{
  const s=setup(), map=s.nodes.get('navigation'), model=s.nodes.get('attitude'), sensors=s.nodes.get('sensorTelemetry');
  map.testCenter=[31,121];model.testPose={yaw:42};sensors.testSample=15;
  assert.equal(s.click('navigation'),true);assert.equal(s.window.BoatWorkspace.current,'navigation');
  assert.equal(map.parentElement,s.slots.get('navigation-map'));assert.equal(s.document.activeElement.id,'viewTitle');
  assert.deepEqual(s.events.at(-1),{view:'navigation',previous:'overview',visible:['navigation'],mapParent:'navigation-map'});
  assert.equal(s.click('attitude'),true);assert.equal(model.parentElement,s.slots.get('attitude-model'));assert.equal(sensors.parentElement,s.slots.get('attitude-sensors'));
  assert.equal(s.click('overview'),true);assert.equal(map.parentElement,s.slots.get('overview-map'));assert.equal(model.parentElement,s.slots.get('overview-attitude'));assert.equal(sensors.parentElement,s.slots.get('overview-sensors'));
  assert.deepEqual(map.testCenter,[31,121]);assert.deepEqual(model.testPose,{yaw:42});assert.equal(sensors.testSample,15);
  for (const panel of [map,model,sensors]) assert.equal([...s.slots.values()].flatMap(slot=>slot.children).filter(child=>child===panel).length,1);
  assert.equal(s.document.title,'船况概览 · 无人船监测平台');assert.equal(s.scrolls.at(-1).behavior,'instant');
});

test('前进后退与手动片段同步可见页面；重复事件不重复发切页通知，修饰点击保留浏览器行为',()=>{
  const s=setup();s.click('navigation');s.click('analysis');
  const count=s.events.length;s.window.history.back();
  assert.equal(s.window.BoatWorkspace.current,'navigation');assert.equal(s.events.length,count+1);
  s.window.history.forward();assert.equal(s.window.BoatWorkspace.current,'analysis');
  s.hash('#propulsion');assert.equal(s.window.BoatWorkspace.current,'propulsion');
  assert.equal(s.click('attitude',{ctrlKey:true}),false);assert.equal(s.window.BoatWorkspace.current,'propulsion');
  assert.equal(s.click('attitude',{button:1}),false);assert.equal(s.window.BoatWorkspace.current,'propulsion');
  s.hash('#invalid');assert.equal(s.window.location.hash,'#overview');assert.equal(s.window.BoatWorkspace.current,'overview');
});

test('驾驶页共享视频地图姿态仪表和电机，返回原页恢复原实例',()=>{
  const s=setup(),objects=['navigation','attitude','sensorTelemetry','videoCard','motors'].map(id=>s.nodes.get(id));
  for(const [index,node] of objects.entries())node.savedState=index;
  s.click('driving');assert.equal(s.window.BoatWorkspace.current,'driving');
  for(const [index,slot]of ['driving-map','driving-model','driving-sensors','driving-video','driving-motors'].entries())assert.equal(objects[index].parentElement,s.slots.get(slot));
  s.click('video');assert.equal(objects[3].parentElement,s.slots.get('video-playback'));
  s.click('propulsion');assert.equal(objects[4].parentElement,s.slots.get('propulsion-motors'));
  assert.equal(s.slots.get('driving-motors').children.length,0,'推进页面恢复同一份电机遥测，不残留副本');
  s.click('overview');
  for(const [index,slot]of ['overview-map','overview-attitude','overview-sensors'].entries())assert.equal(objects[index].parentElement,s.slots.get(slot));
  objects.forEach((node,index)=>assert.equal(node.savedState,index));
  assert.equal(s.document.title,'船况概览 · 无人船监测平台');
});

test('多船页面默认和无效地址进入船队总览，单船面板在返回船队时保留同一实例',()=>{
  for(const hash of ['', '#fleet', '#unknown']){
    const s=setup(hash,true);assert.equal(s.window.BoatWorkspace.current,'fleet');assert.equal(s.window.location.hash,'#fleet');
    assert.deepEqual(s.panels.filter(panel=>!panel.hidden).map(panel=>panel.dataset.workspaceView),['fleet']);assert.equal(s.document.activeElement,null);
    const map=s.nodes.get('navigation'),model=s.nodes.get('attitude');map.testBoat='boat-02';
    s.click('overview');assert.equal(s.window.BoatWorkspace.current,'overview');assert.equal(map.parentElement,s.slots.get('overview-map'));
    s.click('navigation');s.click('fleet');assert.equal(s.window.BoatWorkspace.current,'fleet');assert.equal(map.testBoat,'boat-02');assert.equal(map.parentElement,s.slots.get('navigation-map'));
    s.window.history.back();assert.equal(s.window.BoatWorkspace.current,'navigation');assert.equal(s.nodes.get('attitude'),model);
  }
});

test('未选船时隐藏单船菜单，但保留单船地址直达；明确选择后显示船名与面包屑',()=>{
  const s=setup('#navigation',true), nav=s.nodes.get('singleBoatNav'), crumb=s.nodes.get('workspaceBreadcrumbBoat');
  assert.equal(s.window.BoatWorkspace.current,'navigation');
  assert.equal(nav.hidden,true);assert.equal(nav.open,false);assert.equal(crumb.hidden,true);
  assert.equal(s.nodes.get('workspaceBreadcrumbView').textContent,'船位与轨迹');
  s.window.dispatchEvent(new CustomEvent('boat-selection-change',{detail:{selectedId:'boat-alpha'}}));
  assert.equal(nav.hidden,false);assert.equal(nav.open,true);
  assert.equal(s.nodes.get('singleBoatNavName').textContent,'boat-alpha');
  assert.equal(crumb.textContent,'boat-alpha');assert.equal(crumb.hidden,false);
});

test('同一船遥测更新保留手动折叠，新选船重新展开，返回船队后不被重复状态打开',()=>{
  const s=setup('#overview',true), nav=s.nodes.get('singleBoatNav'), select=s.window.BoatWorkspace.setBoatSelected;
  select('boat-alpha');assert.equal(nav.open,true);
  nav.open=false;select('boat-alpha');select('boat-alpha');
  assert.equal(nav.open,false,'同一船连续状态更新不重新打开菜单');
  select('boat-beta');assert.equal(nav.hidden,false);assert.equal(nav.open,true);
  assert.equal(s.nodes.get('singleBoatNavName').textContent,'boat-beta');
  s.click('fleet');assert.equal(nav.open,false);assert.equal(s.nodes.get('workspaceBreadcrumbBoat').hidden,true);
  select('boat-beta');assert.equal(nav.open,false,'总览中的相同船状态不重新展开菜单');
  select('boat-gamma');assert.equal(nav.open,true,'在总览新选一艘船也可展开详情入口');
});

test('单船页面导航与历史返回会展开当前船菜单，退出清空选择后保持隐藏',()=>{
  const s=setup('#fleet',true), nav=s.nodes.get('singleBoatNav'), crumb=s.nodes.get('workspaceBreadcrumbBoat');
  s.window.BoatWorkspace.setBoatSelected('boat-alpha');s.click('analysis');
  assert.equal(nav.open,true);assert.equal(crumb.hidden,false);assert.equal(s.nodes.get('workspaceBreadcrumbView').textContent,'控制曲线');
  s.click('fleet');assert.equal(nav.open,false);
  s.window.history.back();assert.equal(s.window.BoatWorkspace.current,'analysis');assert.equal(nav.open,true);assert.equal(crumb.hidden,false);
  nav.open=false;s.window.BoatWorkspace.navigate('analysis');assert.equal(nav.open,true,'再次主动进入当前详情页也展开菜单');
  s.window.dispatchEvent(new CustomEvent('boat-selection-change',{detail:{selectedId:''}}));
  assert.equal(nav.hidden,true);assert.equal(nav.open,false);assert.equal(crumb.hidden,true);assert.equal(crumb.textContent,'');
  assert.equal(s.nodes.get('singleBoatNavName').textContent,'未选择');
  s.click('navigation');assert.equal(s.window.BoatWorkspace.current,'navigation');assert.equal(nav.hidden,true);assert.equal(nav.open,false);
  assert.equal(s.nodes.get('workspaceBreadcrumbView').textContent,'船位与轨迹');assert.equal(crumb.hidden,true);
});
