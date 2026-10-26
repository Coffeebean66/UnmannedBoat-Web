const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../public/workspace-navigation.js'),'utf8');
const names = ['overview','navigation','attitude','analysis','propulsion','diagnostics'];

function setup(hash = '', includeFleet = false) {
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
  for (const name of ['overview-map','overview-attitude','overview-sensors','navigation-map','attitude-model','attitude-sensors']) {
    const slot=node(name);slots.set(name,slot);panels.find(panel=>panel.dataset.workspaceView===name.split('-')[0]).append(slot);
  }
  for (const [id,slot] of [['navigation','overview-map'],['attitude','overview-attitude'],['sensorTelemetry','overview-sensors']]) slots.get(slot).append(node(id));
  for (const id of ['viewTitle','viewEnglish','viewSubtitle','singleBoatNav','singleBoatNavName','workspaceBreadcrumbView','workspaceBreadcrumbBoat']) node(id);
  const links = [...activeNames,...activeNames].map((name,index)=>Object.assign(node('link-'+index),{hash:'#'+name}));
  const document = {
    documentElement:{dataset:{}},activeElement:null,title:'',
    getElementById:id=>nodes.get(id),querySelectorAll:selector=>selector==='[data-workspace-view]'?panels:links,
    querySelector:selector=>slots.get(selector.match(/data-workspace-slot="([^"]+)"/)?.[1]),
    addEventListener(name,handler){handlers.set(name,handler);}
  };
  const window = new EventTarget();window.location=location;window.scrollTo=options=>scrolls.push(options);
  window.history = {
    state:{preserved:true},scrollRestoration:'auto',
    pushState(state,title,next){entries.splice(cursor+1);entries.push(next);cursor++;location.hash=next;},
    replaceState(state,title,next){entries[cursor]=next;location.hash=next;},
    back(){if(cursor>0){location.hash=entries[--cursor];window.dispatchEvent(new Event('popstate'));window.dispatchEvent(new Event('hashchange'));}},
    forward(){if(cursor<entries.length-1){location.hash=entries[++cursor];window.dispatchEvent(new Event('popstate'));window.dispatchEvent(new Event('hashchange'));}}
  };
  window.addEventListener('boat-view-change',event=>events.push({view:event.detail.view,previous:event.detail.previous,visible:panels.filter(panel=>!panel.hidden).map(panel=>panel.dataset.workspaceView),mapParent:nodes.get('navigation').parentElement.id}));
  vm.runInNewContext(source,{window,document,CustomEvent});
  return {window,document,nodes,slots,panels,links,events,scrolls,entries,
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
