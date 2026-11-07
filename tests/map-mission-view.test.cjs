const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/map-mission-view.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const points = [{ latitude: 31.23, longitude: 121.47 }, { latitude: 31.231, longitude: 121.47 }, { latitude: 31.231, longitude: 121.472 }];
const active = (extra = {}) => ({ allowed: true, deviceId: 'boat-01', run: {
  active: true, deviceId: 'boat-01', runId: 'run-01', routeId: 'route-01', routeName: '湖区巡检',
  status: 'running', action: 'start', phase: 'route', targetIndex: 1, loopEnabled: true, currentLoop: 1, loopCount: 2,
}, route: { id: 'route-01', name: '湖区巡检', points, loopEnabled: true }, ...extra });

function fixture(initial, saved, brokenStorage = false, savedPoints) {
  const listeners = new Map(), mapListeners = new Map(), markers = [], layers = new Map();
  const storage = new Map(saved ? [['boat_web_mission_route_v1', saved]] : []);
  if(savedPoints)storage.set('boat_web_mission_waypoints_v1',savedPoints);
  const nodes = Object.fromEntries(['mapMissionToggle', 'mapMissionInfo', 'mapMissionStatus', 'mapMissionPointsToggle', 'driverMissionPointsToggle'].map(id => [id, {
    hidden: false, textContent: '', dataset: {}, attributes: {}, events: new Map(),
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.events.set(key, fn); }, removeEventListener(key) { this.events.delete(key); },
  }]));
  const localStorage = { getItem(key) { if (brokenStorage) throw Error('blocked'); return storage.get(key); },
    setItem(key, value) { if (brokenStorage) throw Error('blocked'); storage.set(key, value); } };
  const window = { BoatWorkspace:{current:'navigation'},BoatModules:{missionPath:require('../public/utils/missionPath')},BoatMissions: { navigationState: () => initial },
    addEventListener(key, fn) { listeners.set(key, fn); }, removeEventListener(key) { listeners.delete(key); } };
  const map = { ready: true, provider: 'osm', draws: 0,
    on(key, fn) { mapListeners.set(key, fn); }, off(key) { mapListeners.delete(key); },
    setOverlayLines(key, lines) { this.draws++; if (lines.length) layers.set(key, plain(lines)); else layers.delete(key); },
    createMarker(point, options) { const marker = { point, options, removed: false, remove() { this.removed = true; } }; markers.push(marker); return marker; },
  };
  vm.runInNewContext(source, { window, localStorage, document: { getElementById: id => nodes[id] },
    fetch() { assert.fail('A display toggle must never send control requests'); } });
  const view = new window.MapMissionView(map);
  return { view, map, nodes, layers, storage, markers, listeners, mapListeners,
    emit(detail) { listeners.get('boat-mission-change')({ detail }); }, click() { nodes.mapMissionToggle.events.get('click')(); },
    preview(value) { window.BoatWorkspace.current='driving'; view.setDriverPreview(value); },
    navigate(value) { window.BoatWorkspace.current=value; listeners.get('boat-view-change')({detail:{view:value}}); },
    clickPoints(id='mapMissionPointsToggle') { nodes[id].events.get('click')(); } };
}

test('驾驶选择已保存任务即可预览且无航点，不需启动，不改监测显隐偏好或原航线',()=>{
  const route=active().route,state=active({run:null,route:null}),f=fixture(state,'hidden'),before=plain(route);
  f.preview({deviceId:'boat-01',route});
  assert.deepEqual(f.layers.get('mission')[0].points,points);assert.equal(f.layers.get('mission').length,2);
  assert.equal(f.view.markers.length,0);assert.equal(f.markers.length,0);assert.match(f.nodes.mapMissionStatus.textContent,/湖区巡检.*预览.*航点已隐藏/);
  assert.equal(f.view.visible,false);assert.equal(f.view.pointsVisible,true);assert.equal(f.storage.get('boat_web_mission_route_v1'),'hidden');
  assert.equal(f.nodes.driverMissionPointsToggle.hidden,true);assert.equal(f.nodes.mapMissionToggle.hidden,true);
  assert.deepEqual(route,before);
  f.navigate('navigation');assert.equal(f.layers.size,0);assert.equal(f.nodes.mapMissionToggle.hidden,false);
  f.navigate('driving');assert.deepEqual(f.layers.get('mission')[0].points,points);
  f.view.setDriverPreview(null);assert.equal(f.layers.size,0);f.view.destroy();assert.equal(f.listeners.size,0);
});

test('驾驶切换选择更新曲线与分段样式，空选择清除，轮询不反复重建，换底图可恢复',()=>{
  const P=require('../public/utils/missionPath'),f=fixture(active({run:null,route:null})),route=plain(active().route);
  route.segments=[{type:'curve',control:P.defaultControl(points[0],points[1]),record:false},{type:'line'}];
  f.preview({deviceId:'boat-01',route});
  const lines=f.layers.get('mission'),draws=f.map.draws;
  assert.deepEqual(lines[0].points,P.compile(route).segments[0].points);assert.deepEqual(lines.map(l=>l.dashed),[true,false,true]);
  for(let i=0;i<5;i++)f.preview({deviceId:'boat-01',route:plain(route)});
  assert.equal(f.map.draws,draws);
  f.map.provider='amap';f.mapListeners.get('providerchange')();assert.deepEqual(f.layers.get('mission'),lines);assert.equal(f.markers.length,0);
  const other={id:'other',name:'另一条航线',points:[points[1],points[2]]};
  f.preview({deviceId:'boat-01',route:other});assert.deepEqual(f.layers.get('mission')[0].points,other.points);
  f.preview({deviceId:'boat-01',route:null});assert.equal(f.layers.size,0);assert.match(f.nodes.mapMissionStatus.textContent,/请选择/);
});

test('驾驶任务组显示独立副本的不同颜色、各自返回与组间转场，不生成航点',()=>{
  const P=require('../public/utils/missionPath'),a=plain(active().route),b={id:'b',name:'副本B',points:[points[1],points[2]]};
  const queue={id:'q',name:'连续巡航',routes:[a,b],loopEnabled:true},before=plain(queue),f=fixture(active({run:null,route:null}));
  f.preview({deviceId:'boat-01',queue});const lines=f.layers.get('mission');
  assert.equal(lines.length,5);assert.equal(lines[0].color,P.routeColor(0));assert.equal(lines[3].color,P.routeColor(1));assert.notEqual(lines[0].color,lines[3].color);
  assert.deepEqual(lines[1].points,[points.at(-1),points[0]],'本航线循环返回');
  assert.deepEqual(lines[2].points,[points[0],b.points[0]],'本航线返回后再前往下一条');
  assert.deepEqual(lines[4].points,[b.points.at(-1),a.points[0]],'整组循环返回');
  assert.equal(f.view.markers.length,0);assert.deepEqual(queue,before);assert.match(f.nodes.mapMissionStatus.textContent,/连续巡航/);
});

test('驾驶预览不保留越权、过期或其他船的数据，离页恢复实际执行路线及原航点偏好',()=>{
  const state=active(),f=fixture(state),other={id:'other',name:'另选任务',points:[points[1],points[2]]};
  f.preview({deviceId:'boat-01',route:other});assert.equal(f.view.markers.length,0);assert.deepEqual(f.layers.get('mission')[0].points,other.points);
  f.navigate('navigation');assert.equal(f.view.markers.length,3);assert.deepEqual(f.layers.get('mission')[0].points,points);
  f.navigate('driving');assert.equal(f.view.markers.length,0);
  for(const change of [{allowed:false},{stale:true},{deviceId:'boat-02'}]){
    f.emit({...state,...change});assert.equal(f.layers.size,0);assert.equal(f.view.markers.length,0);f.emit(state);
    assert.deepEqual(f.layers.get('mission')[0].points,other.points);
  }
  const invalid=plain(other);invalid.points[0].latitude=NaN;
  f.preview({deviceId:'boat-01',route:invalid});assert.equal(f.layers.size,0);assert.equal(f.nodes.mapMissionInfo.dataset.visible,'false');
  const badCurve={...other,segments:[{type:'curve'}]};
  f.preview({deviceId:'boat-01',route:badCurve});assert.equal(f.layers.size,0);assert.match(f.nodes.mapMissionStatus.textContent,/曲线无效/);
  f.preview({deviceId:'boat-01',route:badCurve});assert.match(f.nodes.mapMissionStatus.textContent,/曲线无效/);assert.equal(f.nodes.mapMissionInfo.dataset.visible,'false');
});

test('按航段记录开关绘制实线和虚线，隐藏航点后仍保留分段样式',()=>{
  const state=active();state.route.segments=[{type:'line',record:false},{type:'line'}];
  const f=fixture(state);assert.deepEqual(f.layers.get('mission').map(line=>line.dashed),[true,false,true]);
  f.clickPoints();assert.deepEqual(f.layers.get('mission').map(line=>line.dashed),[true,false,true]);
  assert.match(f.nodes.mapMissionStatus.textContent,/虚线不记录/);assert.equal(f.view.markers.length,0);
});

test('当前任务显示独立实线路线、编号航点、当前目标和循环返回线', () => {
  const f = fixture(active());
  assert.deepEqual(f.layers.get('mission')[0].points, points);
  assert.deepEqual(f.layers.get('mission')[1].points, [points.at(-1), points[0]]);
  assert.equal(f.layers.get('mission')[0].dashed, false);
  assert.equal(f.view.markers.length, 3);
  assert.match(f.view.markers[1].options.html, /data-current="true"/);
  assert.equal(f.nodes.mapMissionInfo.dataset.visible, 'true');
  assert.match(f.nodes.mapMissionStatus.textContent, /湖区巡检.*沿线航行.*1 \/ 2/);
  const draws = f.map.draws;
  for (let i = 0; i < 5; i++) f.emit(active());
  assert.equal(f.map.draws, draws, 'Repeated status polling does not rebuild unchanged geometry');
});

test('隐藏/显示仅改变覆盖物，刷新保留偏好且禁用存储时可用', () => {
  const state = active(), f = fixture(state);
  f.click();
  assert.equal(f.layers.has('mission'), false);
  assert.equal(f.view.markers.length, 0);
  assert.ok(f.markers.every(marker => marker.removed));
  assert.equal(state.run.active, true);
  assert.match(f.nodes.mapMissionStatus.textContent, /任务继续执行/);
  assert.equal(f.storage.get('boat_web_mission_route_v1'), 'hidden');
  const refreshed = fixture(state, 'hidden');
  assert.equal(refreshed.layers.size, 0);
  refreshed.click(); assert.equal(refreshed.layers.get('mission').length, 2);
  const blocked = fixture(state, undefined, true);
  blocked.click(); blocked.click(); assert.equal(blocked.view.markers.length, 3);
});

test('切船、访客、结束、失去状态或错误船只的路线及时移除', () => {
  const f = fixture(active());
  for (const state of [active({ deviceId: 'boat-02' }), active({ allowed: false }),
    active({ run: { ...active().run, active: false, status: 'completed' } }), active({ run: null }),
    active({ route: { ...active().route, id: 'other-route' } }), active({ stale: true })]) {
    f.emit(state); assert.equal(f.layers.size, 0); assert.equal(f.view.markers.length, 0);
    f.emit(active()); assert.equal(f.layers.size, 1);
  }
  f.emit(active({ allowed: false }));
  assert.equal(f.nodes.mapMissionToggle.hidden, true);
  assert.equal(f.nodes.mapMissionPointsToggle.hidden, true);
  assert.equal(f.nodes.driverMissionPointsToggle.hidden, true);
  assert.equal(f.nodes.mapMissionInfo.hidden, true);
  assert.equal(f.nodes.mapMissionStatus.textContent, '');
});

test('前往起点不绘制循环返回线，返回阶段突出起点，拒绝异常坐标', () => {
  const f = fixture(active());
  f.emit(active({ run: { ...active().run, action: 'goto', targetIndex: 0, loopEnabled: false } }));
  assert.equal(f.layers.get('mission').length, 1);
  assert.match(f.nodes.mapMissionStatus.textContent, /前往起点/);
  f.emit(active({ run: { ...active().run, phase: 'returning', targetIndex: 0 } }));
  assert.match(f.view.markers[0].options.html, /data-current="true"/);
  assert.match(f.nodes.mapMissionStatus.textContent, /返回起点/);
  f.emit(active({ route: { ...active().route, points: [{ latitude: NaN, longitude: 0 }, points[1]] } }));
  assert.equal(f.layers.size, 0);
});

test('底图完成或切换后恢复航点，销毁解绑监听与覆盖物', () => {
  const f = fixture(active());
  f.map.ready = false; f.emit(active({ run: { ...active().run, targetIndex: 2 } }));
  assert.equal(f.view.markers.length, 0);
  f.map.ready = true; f.mapListeners.get('ready')(); assert.equal(f.view.markers.length, 3);
  f.map.provider = 'amap'; f.mapListeners.get('providerchange')(); assert.equal(f.view.markers.length, 3);
  assert.deepEqual(f.layers.get('mission')[0].points, points, 'Projection belongs to the map facade');
  f.view.destroy(); assert.equal(f.layers.size, 0); assert.equal(f.listeners.size, 0); assert.equal(f.mapListeners.size, 0);
  assert.equal(f.nodes.mapMissionPointsToggle.events.size,0);assert.equal(f.nodes.driverMissionPointsToggle.events.size,0);
});

test('仅隐藏航点保留完整路线与循环线，驾驶和导航按钮同步且不改任务',()=>{
  const state=active(),before=plain(state),f=fixture(state),lines=plain(f.layers.get('mission'));
  f.clickPoints();
  assert.equal(f.view.markers.length,0);assert.ok(f.markers.every(m=>m.removed));
  assert.deepEqual(f.layers.get('mission'),lines);assert.deepEqual(state,before);
  assert.equal(f.nodes.mapMissionInfo.dataset.visible,'true');assert.match(f.nodes.mapMissionStatus.textContent,/航点已隐藏/);
  for(const id of ['mapMissionPointsToggle','driverMissionPointsToggle']){
    assert.equal(f.nodes[id].attributes['aria-pressed'],'false');assert.equal(f.nodes[id].textContent,'显示任务航点');
  }
  assert.equal(f.storage.get('boat_web_mission_waypoints_v1'),'hidden');
  f.clickPoints('driverMissionPointsToggle');
  assert.equal(f.view.markers.length,3);assert.deepEqual(f.layers.get('mission'),lines);
  assert.equal(f.nodes.mapMissionPointsToggle.attributes['aria-pressed'],'true');
  assert.equal(f.storage.get('boat_web_mission_waypoints_v1'),'visible');
});

test('航点偏好独立于整体路线，刷新和换底图后保留，禁用存储仍可切换',()=>{
  const f=fixture(active(),'hidden',false,'hidden');
  assert.equal(f.layers.size,0);assert.equal(f.view.pointsVisible,false);
  f.click();assert.equal(f.layers.get('mission').length,2);assert.equal(f.view.markers.length,0);
  const draws=f.map.draws;f.emit(active());assert.equal(f.map.draws,draws);
  f.map.provider='amap';f.mapListeners.get('providerchange')();
  assert.equal(f.layers.get('mission').length,2);assert.equal(f.view.markers.length,0);
  f.click();f.clickPoints('driverMissionPointsToggle');assert.equal(f.layers.size,0);
  f.click();assert.equal(f.view.markers.length,3);
  const blocked=fixture(active(),undefined,true);blocked.clickPoints();
  assert.equal(blocked.view.markers.length,0);assert.equal(blocked.layers.get('mission').length,2);
  blocked.clickPoints('driverMissionPointsToggle');assert.equal(blocked.view.markers.length,3);
});

test('隐藏航点时曲线仍按实际几何显示，状态与权限清理规则继续生效',()=>{
  const P=require('../public/utils/missionPath'),state=active();state.route.segments=[{type:'curve',control:P.defaultControl(points[0],points[1])},{type:'line'}];
  const f=fixture(state,undefined,false,'hidden'),line=P.compile(state.route).points;
  assert.deepEqual(f.layers.get('mission')[0].points,line);assert.equal(f.view.markers.length,0);
  f.emit({...state,run:{...state.run,active:false,status:'paused'}});
  assert.deepEqual(f.layers.get('mission')[0].points,line);assert.equal(f.view.markers.length,0);
  for(const change of [{deviceId:'boat-02'},{allowed:false},{stale:true},{run:{...state.run,active:false,status:'completed'}}]){
    f.emit({...state,...change});assert.equal(f.layers.size,0);assert.equal(f.view.markers.length,0);
    f.emit(state);assert.deepEqual(f.layers.get('mission')[0].points,line);assert.equal(f.view.markers.length,0);
  }
});

test('当前曲线任务绘制实际曲线，弯点调整触发更新且不增加必达航点',()=>{
  const N=require('../public/utils/missionNavigation'),P=require('../public/utils/missionPath');
  const state=active(),control=P.defaultControl(points[0],points[1]);state.route.segments=[{type:'curve',control},{type:'line'}];
  const f=fixture(state),line=f.layers.get('mission')[0].points;
  assert.ok(line.length>points.length);assert.deepEqual(line,P.compile(state.route).points);assert.equal(f.view.markers.length,3);
  const changed=structuredClone(state);changed.route.segments[0].control=N.destination(control,90,10);f.emit(changed);
  assert.notDeepEqual(f.layers.get('mission')[0].points,line);assert.equal(f.view.markers.length,3);
  f.click();assert.equal(f.layers.size,0);f.click();assert.deepEqual(f.layers.get('mission')[0].points,P.compile(changed.route).points);
});

test('队列转场显示当前实际航线及转场线，隐藏航点或进入下一阶段保留正确路径',()=>{
  const state=active(),from={latitude:31.229,longitude:121.469};state.run.phase='transit';state.run.transitionFrom=from;
  state.run.queue={name:'两段巡航',routeIndex:1,routeCount:2,currentLoop:1,loopCount:2};
  const f=fixture(state);assert.equal(f.layers.get('mission').length,3);assert.deepEqual(f.layers.get('mission')[2].points,[from,points[0]]);
  assert.match(f.nodes.mapMissionStatus.textContent,/两段巡航.*航线 2 \/ 2.*前往下一航线/);
  f.clickPoints();assert.equal(f.view.markers.length,0);assert.deepEqual(f.layers.get('mission')[2].points,[from,points[0]]);
  f.emit({...state,run:{...state.run,phase:'route',transitionFrom:null}});assert.equal(f.layers.get('mission').length,2);
  f.emit({...state,run:{...state.run,phase:'queueReturning'}});assert.match(f.nodes.mapMissionStatus.textContent,/队列返回起点/);assert.equal(f.layers.get('mission').length,3);
});
