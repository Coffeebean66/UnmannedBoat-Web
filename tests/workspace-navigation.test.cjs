const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../public/workspace-navigation.js'),'utf8');
const names = ['overview','navigation','attitude','analysis','propulsion','diagnostics'];

function setup(hash = '') {
  const nodes = new Map(), slots = new Map(), handlers = new Map(), events = [], scrolls = [];
  const location = {hash}, entries = [hash]; let cursor = 0;
  function node(id) {
    const value = {id,hidden:false,dataset:{},attributes:{},children:[],parentElement:null,textContent:'',classes:new Set(),
      classList:{toggle(name,enabled){enabled ? value.classes.add(name) : value.classes.delete(name);}},
      setAttribute(name,val){this.attributes[name]=val;},removeAttribute(name){delete this.attributes[name];},
      append(child){if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(item=>item!==child);this.children.push(child);child.parentElement=this;},
      focus(options){document.activeElement=this;this.focusOptions=options;},
      closest(){return this;}};
    nodes.set(id,value);return value;
  }
  const panels = names.map(name => {const panel=node('view-'+name);panel.dataset.workspaceView=name;panel.hidden=name!=='overview';return panel;});
  for (const name of ['overview-map','overview-attitude','overview-sensors','navigation-map','attitude-model','attitude-sensors']) {
    const slot=node(name);slots.set(name,slot);panels.find(panel=>panel.dataset.workspaceView===name.split('-')[0]).append(slot);
  }
  for (const [id,slot] of [['navigation','overview-map'],['attitude','overview-attitude'],['sensorTelemetry','overview-sensors']]) slots.get(slot).append(node(id));
  for (const id of ['viewTitle','viewEnglish','viewSubtitle']) node(id);
  const links = [...names,...names].map((name,index)=>Object.assign(node('link-'+index),{hash:'#'+name}));
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
    click(name,options={}){let prevented=false;handlers.get('click')({button:0,target:links[names.indexOf(name)],preventDefault(){prevented=true;},...options});return prevented;},
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
