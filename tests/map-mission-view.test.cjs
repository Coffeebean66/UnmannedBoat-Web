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

function fixture(initial, saved, brokenStorage = false) {
  const listeners = new Map(), mapListeners = new Map(), markers = [], layers = new Map();
  const storage = new Map(saved ? [['boat_web_mission_route_v1', saved]] : []);
  const nodes = Object.fromEntries(['mapMissionToggle', 'mapMissionInfo', 'mapMissionStatus'].map(id => [id, {
    hidden: false, textContent: '', dataset: {}, attributes: {}, events: new Map(),
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.events.set(key, fn); }, removeEventListener(key) { this.events.delete(key); },
  }]));
  const localStorage = { getItem(key) { if (brokenStorage) throw Error('blocked'); return storage.get(key); },
    setItem(key, value) { if (brokenStorage) throw Error('blocked'); storage.set(key, value); } };
  const window = { BoatMissions: { navigationState: () => initial },
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
    emit(detail) { listeners.get('boat-mission-change')({ detail }); }, click() { nodes.mapMissionToggle.events.get('click')(); } };
}

test('当前任务显示独立虚线路线、编号航点、当前目标和循环返回线', () => {
  const f = fixture(active());
  assert.deepEqual(f.layers.get('mission')[0].points, points);
  assert.deepEqual(f.layers.get('mission')[1].points, [points.at(-1), points[0]]);
  assert.equal(f.layers.get('mission')[0].dashed, true);
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
});
