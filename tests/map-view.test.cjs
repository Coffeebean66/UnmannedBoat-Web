const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/map-view'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const configured = { provider: 'amap', version: '2.0', enabled: true, configured: true,
  key: 'key with+characters', securityJsCode: 'test-security-code' };

function fixture(config = configured, preferences = {}, behavior = {}) {
  const listeners = new Map(), timers = new Map();
  const documentListeners = new Map();
  const scripts = [], maps = [], markers = [], lines = [], conversions = [], fetches = [],tiles=[];
  const storage = new Map(Object.entries(preferences));
  let timerSequence = 0;
  const node = tag => ({ tag, style: {}, children: [], className: '', events: {}, attributes: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(name, callback) { this.events[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() { this.removed = true; } });
  const container = { ...node('div'), clientWidth: 400, clientHeight: 300 };
  const document = {
    documentElement: { dataset: { theme: 'dark' } },
    addEventListener(name, fn) {
      if (!documentListeners.has(name)) documentListeners.set(name, new Set());
      documentListeners.get(name).add(fn);
    },
    removeEventListener(name, fn) {
      documentListeners.get(name)?.delete(fn);
      if (documentListeners.get(name)?.size === 0) documentListeners.delete(name);
    },
    getElementById(id) { return id === 'map' ? container : null; },
    createElement: node,
    head: { appendChild(script) {
      scripts.push(script);
      script.securityAtAppend = plain(window._AMapSecurityConfig);
    } }
  };
  const window = {
    document, AbortController,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return { ok: true, json: async () => config };
    },
    setTimeout(fn, duration) { const id = ++timerSequence; timers.set(id, { fn, duration }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    BoatModules: { mapCoordinates: { wgs84ToGcj02(latitude, longitude) {
      conversions.push([latitude, longitude]);
      return { latitude: latitude + .002, longitude: longitude + .004 };
    }, gcj02ToWgs84(latitude, longitude) {
      return { latitude: latitude - .002, longitude: longitude - .004 };
    } } }
  };
  function mapInstance(options, provider) {
    const events = new Map();
    return {
      options, provider, center: options.center, zoom: options.zoom ?? 5,
      on(name, fn) {
        if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(fn);
        if (provider === 'amap' && name === 'complete' && behavior.autoComplete !== false && !this.completionScheduled) {
          this.completionScheduled = true;
          Promise.resolve().then(() => this.emit('complete'));
        }
        return this;
      },
      off(name, fn) {
        if (fn) events.get(name)?.delete(fn); else events.delete(name);
        return this;
      },
      emit(name, value) { for (const fn of [...(events.get(name) || [])]) fn(value); },
      listenerCount(name) { return events.get(name)?.size || 0; },
      setView(position, zoom, options) { this.center = position; this.zoom = zoom; this.viewOptions = options; return this; },
      setZoomAndCenter(zoom, center, immediately) { this.zoom = zoom; this.center = center; this.immediately = immediately; },
      setCenter(center) { this.center = center; },
      getCenter() {
        const [first, second] = this.center || [];
        return provider === 'amap' ? { lng: first, lat: second } : { lat: first, lng: second };
      },
      getZoom() { return this.zoom; },
      setZoom(zoom) { this.zoom = zoom; },
      getSize() { return { width: 400, height: 300 }; },
      panBy(...args) { this.pan = args; },
      lngLatToContainer([lng, lat]) { return { x: lng * 10, y: lat * 10 }; },
      latLngToContainerPoint([lat, lng]) { return { x: lng * 10, y: lat * 10 }; },
      setMapStyle(style) { this.style = style; },
      resize() { this.resized = true; this.emit('resize'); },
      invalidateSize(options) { this.resized = options; this.emit('resize'); },
      destroy() { this.destroyed = true; },
      remove() { this.removed = true; }
    };
  }
  const AMap = {
    Map: function (_container, options) { const map = mapInstance(options, 'amap'); maps.push(map); return map; },
    Pixel: function (x, y) { this.x = x; this.y = y; },
    Marker: function (options) {
      this.options = options; this.position = options.position;
      this.setMap = map => { this.map = map; };
      this.setPosition = position => { this.position = position; };
      this.getContent = () => options.content;
      markers.push(this);
    },
    Polyline: function (options) {
      this.options = options;
      this.setMap = map => { this.map = map; };
      lines.push(this);
    }
  };
  window.L = {
    map(_container, options) { const map = mapInstance(options, 'osm'); maps.push(map); return map; },
    tileLayer(url, options) {
      const layer = { url, options, events: {},
        on(name, fn) { this.events[name] = fn; return this; },
        off() { this.events={};this.detached=true;return this; },
        addTo(map) { this.map = map; return this; } };
      window.tiles = layer;tiles.push(layer);
      return layer;
    },
    divIcon(options) { return options; },
    marker(position, options) {
      const element = node('div');
      element.innerHTML = options.icon.html;
      const marker = { position, options,
        addTo(map) { this.map = map; return this; },
        setLatLng(position) { this.position = position; return this; },
        setOpacity(value) { this.opacity = value; return this; },
        getElement() { return element; },
        remove() { this.removed = true; } };
      markers.push(marker);
      return marker;
    },
    polyline(path, options) {
      const line = { path, options,
        addTo(map) { this.map = map; return this; }, remove() { this.removed = true; } };
      lines.push(line);
      return line;
    }
  };
  vm.runInNewContext(source, { window, Map, Set, Date, Promise, module: { exports: {} } });
  const view = new window.BoatMapView('map');
  return { window, view, scripts, maps, markers, lines, conversions, fetches, tiles, timers, listeners, documentListeners, AMap, storage,
    emitDocument(name, event) {
      for (const fn of [...(documentListeners.get(name) || [])]) fn(event);
    },
    finishSdk() {
      window.AMap = AMap;
      const callback = new URL(scripts.at(-1).src).searchParams.get('callback');
      window[callback]();
      return callback;
    },
    runTimer(duration) {
      const entry = [...timers].find(([, timer]) => timer.duration === duration);
      assert.ok(entry, 'timer ' + duration + ' exists');
      timers.delete(entry[0]);
      entry[1].fn();
    } };
}

async function until(predicate) {
  for (let i = 0; i < 30; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.fail('expected asynchronous phase was not reached');
}

async function readyAmap(f) {
  const pending = f.view.initialize();
  await until(() => f.scripts.length === 1);
  f.finishSdk();
  await pending;
  assert.equal(f.view.ready, true);
}

test('卫星来源切换保持 WGS84 船位、轨迹、视野、点击坐标和像素锚点，切回原平面图',async()=>{
  const f=fixture({...configured,tianditu:{configured:true,key:'a'.repeat(32)}});
  await readyAmap(f);
  const raw={latitude:31.1234567,longitude:121.7654321},points=[raw,{latitude:31.2,longitude:121.8}];
  const marker=f.view.createMarker(raw);
  f.view.setTrackLines([{points,color:'#123456',width:5}]);f.view.setView(raw,17,{animate:false});
  for(const provider of ['arcgis','tianditu','arcgis']){
    assert.equal(await f.view.switchProvider(provider),true);
    assert.equal(f.view.mode,'satellite');assert.equal(f.view.ready,true);
    assert.deepEqual(plain(marker.position),raw);assert.deepEqual(plain(marker.native.position),[raw.latitude,raw.longitude]);
    assert.deepEqual(plain(f.view.getCenter()),raw);assert.equal(f.view.getZoom(),17);
    assert.deepEqual(plain(f.view.lastTrackLines),[{points,color:'#123456',width:5}]);
    assert.deepEqual(plain(f.lines.at(-1).path),points.map(p=>[p.latitude,p.longitude]));
    assert.deepEqual(plain(f.view.latLngToContainerPoint(raw)),{x:raw.longitude*10,y:raw.latitude*10});
    const clicks=[];const click=p=>clicks.push(p);f.view.on('click',click);
    f.view.map.emit('click',{latlng:{lat:raw.latitude,lng:raw.longitude}});
    assert.deepEqual(plain(clicks),[raw]);f.view.off('click',click);
    let fitted;f.view.map.fitBounds=(bounds)=>{fitted=bounds;};
    assert.equal(f.view.fitLocations(points),true);assert.deepEqual(plain(fitted),points.map(p=>[p.latitude,p.longitude]));
  }
  assert.equal(f.storage.get('boat.map.planar'),'amap');assert.equal(f.storage.get('boat.map.satellite'),'arcgis');
  await f.view.switchMode('planar');assert.equal(f.view.provider,'amap');
  assert.deepEqual(plain(marker.getLatLng()),{lat:raw.latitude,lng:raw.longitude});
  await f.view.switchMode('satellite');assert.equal(f.view.provider,'arcgis');
  f.view.destroy();assert.ok(f.tiles.every(layer=>layer.detached));
});

test('卫星瓦片使用官方 HTTPS 地址与正确 XY 顺序，天地图影像与注记独立清理',async()=>{
  const token='1'.repeat(32),f=fixture({configured:false,tianditu:{configured:true,key:token}},{'boat.map.provider':'arcgis'});
  await f.view.initialize();assert.equal(f.view.provider,'arcgis');assert.equal(f.scripts.length,0);
  assert.equal(f.tiles[0].url,'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
  assert.match(f.tiles[0].options.attribution,/Esri/);
  await f.view.switchProvider('tianditu');assert.equal(f.tiles[0].detached,true);
  const [image,labels]=f.tiles.slice(-2);
  for(const [layer,kind] of [[image,'img'],[labels,'cia']]){
    const url=new URL(layer.url.replace('{s}','0').replace('{z}','12').replace('{x}','3456').replace('{y}','789'));
    assert.equal(url.origin,'https://t0.tianditu.gov.cn');assert.equal(url.pathname,'/'+kind+'_w/wmts');
    for(const [key,value] of Object.entries({TILEMATRIX:'12',TILEROW:'789',TILECOL:'3456',LAYER:kind,tk:token,TILEMATRIXSET:'w'}))assert.equal(url.searchParams.get(key),value);
    assert.equal(layer.options.maxNativeZoom,18);assert.equal(layer.options.maxZoom,19);
  }
  labels.events.tileerror();image.events.load();assert.match(f.view.status.message,/天地图.*注记.*Key/);
  labels.events.loading();labels.events.load();assert.match(f.view.status.message,/天地图.*卫星.*WGS84/);
  const late=image.events.tileerror;
  await f.view.switchProvider('osm');assert.ok(image.detached&&labels.detached);
  const status=f.view.status.message;late();assert.equal(f.view.status.message,status);
  f.view.destroy();
});

test('天地图缺失或非法凭据保留旧地图与偏好，ArcGIS 无需 Key 可用',async()=>{
  for(const tianditu of [undefined,{configured:false,key:''},{configured:true,key:'https://evil.test'}]){
    const f=fixture({configured:false,tianditu},{'boat.map.provider':'osm'});
    await f.view.initialize();const previous=f.view.map;
    await assert.rejects(f.view.switchProvider('tianditu'),/天地图.*平台地图设置/);
    assert.equal(f.view.map,previous);assert.equal(f.view.ready,true);assert.equal(f.storage.get('boat.map.provider'),'osm');
    assert.match(f.view.status.message,/切换失败.*天地图.*继续使用/);
    await f.view.switchMode('satellite');assert.equal(f.view.provider,'arcgis');assert.equal(f.scripts.length,0);
    f.view.destroy();
  }
});

test('地图菜单隔离航点点击，记忆卫星来源且刷新恢复，无定位也能显示',async()=>{
  const f=fixture({configured:false,tianditu:{configured:true,key:'2'.repeat(32)}},
    {'boat.map.provider':'tianditu','boat.map.satellite':'tianditu','boat.map.planar':'osm'});
  await f.view.initialize();assert.equal(f.view.ready,true);assert.equal(f.view.provider,'tianditu');
  assert.match(f.view.status.message,/天地图.*WGS84/);
  let stopped=0;for(const event of ['click','dblclick','pointerdown','mousedown','touchstart','wheel','keydown']){
    f.view._layerControls.events[event]({stopPropagation(){stopped++;}});
  }
  assert.equal(stopped,7);assert.equal(f.view._sourceSelect.attributes['aria-label'],'卫星地图来源');
  f.view._setSwitching(true);assert.ok(f.view._sourceSelect.disabled&&f.view._modeButtons.every(({button})=>button.disabled));
  f.view._setSwitching(false);
  await f.view.switchMode('planar');assert.equal(f.view.provider,'osm');
  await f.view.switchMode('satellite');assert.equal(f.view.provider,'tianditu');
  assert.equal(f.view._modeButtons[1].button.attributes['aria-pressed'],'true');
  assert.equal(f.view._sourceSelect.value,'tianditu');f.view.destroy();
});

test('停用高德后旧平面偏好回退 OSM，失效天地图偏好显示错误且菜单允许恢复 ArcGIS',async()=>{
  const stopped=fixture({configured:false,enabled:false},{'boat.map.provider':'amap'});
  await stopped.view.initialize();assert.equal(stopped.view.provider,'osm');stopped.view.destroy();
  const f=fixture({configured:false},{'boat.map.provider':'tianditu'});
  await f.view.initialize();assert.equal(f.view.ready,false);assert.match(f.view.status.message,/天地图.*尚未配置/);
  assert.equal(f.view._sourceSelect.disabled,false);
  await f.view.switchProvider('arcgis');assert.equal(f.view.ready,true);f.view.destroy();
});

test('unconfigured AMap retains explicit OSM status and raw WGS84 throughout', async () => {
  const f = fixture({ enabled: false, configured: false, reason: '尚未配置 Key' });
  await f.view.initialize();
  assert.equal(f.view.ready, true);
  assert.equal(f.view.provider, 'osm');
  assert.match(f.view.status.message, /高德未配置.*OpenStreetMap.*WGS84/);
  assert.equal(f.scripts.length, 0);
  assert.equal(f.fetches[0].url, '/api/map/config');
  assert.equal(f.fetches[0].options.credentials, 'same-origin');
  assert.equal(f.fetches[0].options.cache, 'no-store');
  const marker = f.view.createMarker({ latitude: 31, longitude: 121 });
  assert.deepEqual(plain(marker.native.position), [31, 121]);
  marker.setPosition({ latitude: 32, longitude: 122 }).setOpacity(.3);
  assert.deepEqual(plain(marker.getLatLng()), { lat: 32, lng: 122 });
  assert.equal(marker.native.opacity, .3);
  f.view.setTrackLines([{ points: [{ latitude: 31, longitude: 121 }, { latitude: 32, longitude: 122 }], color: '#123456' }]);
  assert.deepEqual(plain(f.lines[0].path), [[31, 121], [32, 122]]);
  f.view.setView([33, 123], 16, { animate: false });
  assert.deepEqual(plain(f.maps[0].center), [33, 123]);
  assert.equal(f.conversions.length, 0);
  f.window.tiles.events.tileerror();
  assert.match(f.view.status.message, /高德未配置.*网络不可用/);
  f.window.tiles.events.loading();
  f.window.tiles.events.load();
  assert.match(f.view.status.message, /高德未配置.*OpenStreetMap/);
  f.view.destroy();
  assert.equal(f.maps[0].removed, true);
  assert.equal(marker.native.removed, true);
  assert.equal(f.lines[0].removed, true);
});

test('map clicks expose WGS84 on both providers and native listeners are detached on destroy',async()=>{
  for(const provider of ['osm','amap']){
    const f=fixture(provider==='osm'?{enabled:false,configured:false}:undefined),pending=f.view.initialize();
    if(provider==='amap'){await until(()=>f.scripts.length===1);f.finishSdk();}
    await pending;const points=[];f.view.on('click',p=>points.push(plain(p)));const map=f.view.map;
    if(provider==='osm')map.emit('click',{latlng:{lat:31,lng:121}});
    else map.emit('click',{lnglat:{getLat:()=>31.002,getLng:()=>121.004}});
    assert.ok(Math.abs(points[0].latitude-31)<1e-8);assert.ok(Math.abs(points[0].longitude-121)<1e-8);
    f.view.destroy();map.emit('click',{latlng:{lat:32,lng:122},lnglat:{lat:32.002,lng:122.004}});assert.equal(points.length,1);
  }
});

test('official SDK loads only once after security code and initialization stays north-up 2D', async () => {
  const f = fixture();
  const first = f.view.initialize();
  assert.equal(f.view.initialize(), first);
  await until(() => f.scripts.length === 1);
  const script = f.scripts[0], url = new URL(script.src);
  assert.equal(url.origin, 'https://webapi.amap.com');
  assert.equal(url.pathname, '/maps');
  assert.equal(url.searchParams.get('v'), '2.0');
  assert.equal(url.searchParams.get('key'), configured.key);
  assert.equal(script.securityAtAppend.securityJsCode, configured.securityJsCode);
  const callback = f.finishSdk();
  await first;
  assert.equal(f.view.provider, 'amap');
  assert.equal(f.view.ready, true);
  assert.equal(f.window[callback], undefined);
  assert.equal(script.removed, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.maps[0].options.viewMode, '2D');
  assert.equal(f.maps[0].options.rotation, 0);
  assert.equal(f.maps[0].options.pitch, 0);
  assert.equal(f.maps[0].options.rotateEnable, false);
  assert.equal(f.maps[0].options.pitchEnable, false);
  assert.equal(f.maps[0].style, 'amap://styles/darkblue');
  const zoom = f.view._zoomControls;
  assert.equal(zoom.children[0].attributes['aria-label'], '地图放大');
  zoom.children[0].events.click({ stopPropagation() {} });
  assert.equal(f.view.getZoom(), 6);
  f.view.setZoom(20);
  zoom.children[0].events.click({ stopPropagation() {} });
  assert.equal(f.view.getZoom(), 20);
  f.view.setZoom(3);
  zoom.children[1].events.click({ stopPropagation() {} });
  assert.equal(f.view.getZoom(), 3);
  f.view.setTheme('light');
  assert.equal(f.maps[0].style, 'amap://styles/normal');
  f.view.destroy();
  assert.equal(zoom.removed, true);
});

test('markers, track and center convert once without mutating raw WGS84 or SVG anchor', async () => {
  const f = fixture();
  await readyAmap(f);
  f.conversions.length = 0;
  const position = Object.freeze({ latitude: 31, longitude: 121 });
  const marker = f.view.createMarker(position, { className: 'boat-pin', iconSize: [30, 30], iconAnchor: [15, 15] });
  assert.deepEqual(plain(marker.native.position), [121.004, 31.002]);
  assert.deepEqual(plain(marker.native.options.offset), { x: -15, y: -15 });
  assert.equal(marker.native.options.anchor, 'top-left');
  assert.deepEqual(plain(marker.getLatLng()), { lat: 31, lng: 121 });
  assert.equal(f.conversions.length, 1);
  const vector = f.view.createMarker(position, { className: 'map-velocity-anchor', html: '<svg></svg>',
    iconSize: [0, 0], iconAnchor: [0, 0], zIndexOffset: 200, interactive: false });
  assert.equal(vector.getElement().style.width, '0px');
  assert.equal(vector.getElement().style.height, '0px');
  assert.equal(vector.native.options.offset.x, 0);
  assert.equal(vector.native.options.offset.y, 0);
  assert.equal(vector.native.options.anchor, 'top-left');
  assert.equal(vector.native.options.clickable, false);
  assert.equal(vector.native.options.zIndex, 320);
  assert.deepEqual(plain(marker.native.position), plain(vector.native.position));
  vector.native.setOpacity = value => { vector.native.opacity = value; };
  vector.setOpacity(.3);
  assert.equal(vector.native.opacity, .3);
  assert.equal(vector.getElement().style.opacity, undefined, 'native opacity is not multiplied by child opacity');
  const next = Object.freeze({ latitude: 32, longitude: 122 });
  marker.setPosition(next);
  assert.deepEqual(plain(marker.native.position), [122.004, 32.002]);
  assert.deepEqual(plain(marker.getLatLng()), { lat: 32, lng: 122 });
  marker.setOpacity(.25);
  assert.equal(marker.getElement().style.opacity, '0.25');
  f.view.setTrackLines([{ points: [position, next], color: '#abcdef', width: 5 }]);
  assert.deepEqual(plain(f.lines[0].options.path), [[121.004, 31.002], [122.004, 32.002]]);
  assert.equal(f.lines[0].options.strokeWeight, 5);
  assert.deepEqual(plain(f.view.lastTrackLines[0].points), [position, next]);
  f.view.setView([31, 121], 16, { animate: false });
  assert.deepEqual(plain(f.maps[0].center), [121.004, 31.002]);
  assert.equal(f.maps[0].immediately, true);
  const point = f.view.latLngToContainerPoint(marker.getLatLng());
  assert.equal(point.x, 122.004 * 10);
  assert.equal(point.y, 32.002 * 10);
  assert.equal(f.conversions.length, 7, 'one conversion per marker creation/update, each line point, center, projection');
  marker.remove();
  assert.equal(marker.getElement(), null);
  assert.equal(marker.native.map, null);
  f.view.destroy();
  assert.equal(f.lines[0].map, null);
  assert.equal(vector.native.map, null);
  assert.equal(f.maps[0].destroyed, true);
});

test('invalid coordinates never become zero or bridge missing track points', async () => {
  const f = fixture();
  await readyAmap(f);
  assert.equal(f.view.project({ latitude: NaN, longitude: 121 }), null);
  assert.equal(f.view.project({ latitude: 91, longitude: 121 }), null);
  assert.equal(f.view.createMarker({ latitude: '31', longitude: 121 }), null);
  const marker = f.view.createMarker([31, 121]);
  marker.setPosition([Infinity, 122]);
  assert.deepEqual(plain(marker.getLatLng()), { lat: 31, lng: 121 });
  f.view.setTrackLines([{ points: [[31, 121], [32, 122], null, [33, 123], [34, 124]], color: '#fff' }]);
  assert.equal(f.lines.length, 2);
  assert.deepEqual(plain(f.lines[0].options.path), [[121.004, 31.002], [122.004, 32.002]]);
  assert.deepEqual(plain(f.lines[1].options.path), [[123.004, 33.002], [124.004, 34.002]]);
  f.view.setTrackLines([]);
  assert.equal(f.lines[0].map, null);
  assert.equal(f.lines[1].map, null);
  f.view.destroy();
});

test('configured SDK error and timeout are visible and never fall back to OSM', async () => {
  for (const fail of ['network', 'timeout']) {
    const f = fixture();
    const pending = f.view.initialize();
    await until(() => f.scripts.length === 1);
    const callback = new URL(f.scripts[0].src).searchParams.get('callback');
    if (fail === 'network') f.scripts[0].onerror(); else f.runTimer(15000);
    await pending;
    assert.equal(f.view.provider, 'amap');
    assert.equal(f.view.ready, false);
    assert.match(f.view.status.message, /高德地图加载失败/);
    assert.equal(f.view.status.tone, 'error');
    assert.equal(f.maps.length, 0);
    assert.equal(f.window.tiles, undefined);
    assert.equal(f.scripts[0].removed, true);
    assert.equal(f.window[callback], undefined);
    assert.equal(f.timers.size, 0);
    f.view.destroy();
  }
});

test('pagehide cancels in-flight config or SDK and never resurrects a map', async () => {
  {
    const f = fixture();
    let respond;
    f.window.fetch = (_url, options) => {
      f.signal = options.signal;
      return new Promise(resolve => { respond = resolve; });
    };
    const pending = f.view.initialize();
    await until(() => !!respond);
    f.listeners.get('pagehide')();
    await pending;
    assert.equal(f.signal.aborted, true);
    respond({ ok: true, json: async () => configured });
    await until(() => f.timers.size === 0);
    await Promise.resolve();
    assert.equal(f.view.ready, false);
    assert.equal(f.scripts.length, 0);
    assert.equal(f.maps.length, 0);
  }
  {
    const f = fixture();
    const pending = f.view.initialize();
    await until(() => f.scripts.length === 1);
    const callback = new URL(f.scripts[0].src).searchParams.get('callback');
    const lateCallback = f.window[callback];
    f.listeners.get('pagehide')();
    await pending;
    f.window.AMap = f.AMap;
    lateCallback();
    assert.equal(f.view.ready, false);
    assert.equal(f.maps.length, 0);
    assert.equal(f.window[callback], undefined);
    assert.equal(f.scripts[0].removed, true);
    assert.equal(f.timers.size, 0);
  }
});

test('config error/timeout stays explicit and ready event/resize lifecycle is stable', async () => {
  const failed = fixture();
  failed.window.fetch = async () => ({ ok: false, status: 401 });
  await failed.view.initialize();
  assert.equal(failed.view.ready, false);
  assert.match(failed.view.status.message, /HTTP 401/);
  assert.equal(failed.scripts.length, 0);
  failed.view.destroy();
  const timeout = fixture();
  timeout.window.fetch = () => new Promise(() => {});
  const pending = timeout.view.initialize();
  timeout.runTimer(5000);
  await pending;
  assert.equal(timeout.view.ready, false);
  assert.match(timeout.view.status.message, /配置请求超时/);
  timeout.view.destroy();
  const f = fixture();
  let ready = 0, resize = 0, drag = 0;
  const resizeListener = () => resize++;
  f.view.on('ready', () => ready++).on('resize', resizeListener).on('dragstart', () => drag++);
  await readyAmap(f);
  assert.equal(ready, 1);
  assert.deepEqual(plain(f.view.getSize()), { x: 400, y: 300 });
  f.view.invalidateSize();
  f.maps[0].emit('dragstart');
  assert.equal(resize, 1);
  assert.equal(drag, 1);
  f.view.off('resize', resizeListener).invalidateSize();
  assert.equal(resize, 1);
  f.view.setZoom(18).panBy([10, -5]);
  assert.equal(f.view.getZoom(), 18);
  assert.deepEqual(f.maps[0].pan, [10, -5]);
  f.view.destroy();
  f.view.destroy();
  assert.equal(f.view.ready, false);
  assert.equal(f.listeners.size, 0);
});

test('saved OSM preference overrides configured AMap and switching preserves live map state', async () => {
  const f = fixture(configured, { 'boat.map.provider': 'osm' });
  await f.view.initialize();
  assert.equal(f.view.provider, 'osm');
  assert.equal(f.scripts.length, 0, 'saved OSM starts without requesting the AMap SDK');
  const oldMap = f.view.map;
  const marker = f.view.createMarker([31, 121], { html: '<svg>initial</svg>', iconSize: [0, 0], iconAnchor: [0, 0] });
  const oldMarker = marker.native;
  marker.setPosition([32, 122]).setOpacity(.35);
  marker.getElement().innerHTML = '<svg>live heading</svg>';
  f.view.setTrackLines([{ points: [[31, 121], [32, 122]], color: '#abcdef', width: 5 }]);
  const oldLine = f.lines[0];
  oldMap.setView([33, 123], 16);
  const switching = [], changed = [];
  f.view.on('switching', value => switching.push(value));
  f.view.on('providerchange', value => changed.push(value));
  const pending = f.view.switchProvider('amap');
  await until(() => f.scripts.length === 1);
  assert.equal(f.view.switching, true);
  assert.equal(f.view.ready, true, 'existing map remains usable while SDK is loading');
  assert.equal(f.view.map, oldMap);
  assert.equal(oldMap.removed, undefined);
  assert.equal(f.storage.get('boat.map.provider'), 'osm');
  const duplicate = f.view.switchProvider('amap');
  const competing = f.view.switchProvider('osm');
  assert.equal(f.scripts.length, 1, 'concurrent button presses cannot start another switch');
  f.finishSdk();
  await pending;
  await Promise.all([duplicate, competing]);
  assert.equal(f.view.provider, 'amap');
  assert.equal(f.view.ready, true);
  assert.equal(f.view.switching, false);
  assert.equal(oldMap.removed, true);
  assert.equal(oldMarker.removed, true);
  assert.equal(oldLine.removed, true);
  assert.notEqual(marker.native, oldMarker, 'wrapper is stable while native marker is rebuilt');
  assert.deepEqual(plain(marker.getLatLng()), { lat: 32, lng: 122 });
  assert.deepEqual(plain(marker.native.position), [122.004, 32.002]);
  assert.equal(marker.getElement().innerHTML, '<svg>live heading</svg>');
  assert.equal(marker.getElement().style.opacity, '0.35');
  assert.deepEqual(plain(f.lines.at(-1).options.path), [[121.004, 31.002], [122.004, 32.002]]);
  assert.equal(f.lines.at(-1).options.strokeColor, '#abcdef');
  assert.equal(f.lines.at(-1).options.strokeWeight, 5);
  assert.deepEqual(plain(f.view.map.center), [123.004, 33.002]);
  assert.equal(f.view.getZoom(), 16);
  assert.equal(f.storage.get('boat.map.provider'), 'amap');
  assert.equal(changed.length, 1);
  assert.ok(switching.length >= 2, 'start and completion are observable by the UI');
  marker.setPosition([34, 124]).setOpacity(.5);
  assert.deepEqual(plain(marker.native.position), [124.004, 34.002], 'existing marker handle updates the new native marker');
  marker.remove();
  assert.equal(marker.native.map, null);
  f.view.destroy();
});

test('AMap to OSM converts the dragged viewport back to WGS84 without moving raw telemetry', async () => {
  const f = fixture();
  await readyAmap(f);
  const marker = f.view.createMarker([31, 121], { html: '<svg>boat</svg>' });
  marker.setOpacity(.2);
  const oldMarker = marker.native, oldMap = f.view.map;
  oldMap.setZoomAndCenter(15, [123.004, 33.002]);
  await f.view.switchProvider('osm');
  assert.equal(f.view.provider, 'osm');
  assert.equal(f.view.ready, true);
  assert.equal(oldMap.destroyed, true);
  assert.equal(oldMarker.map, null);
  assert.deepEqual(plain(f.view.map.center), [33, 123]);
  assert.equal(f.view.getZoom(), 15);
  assert.deepEqual(plain(marker.native.position), [31, 121]);
  assert.deepEqual(plain(marker.getLatLng()), { lat: 31, lng: 121 });
  assert.equal(marker.native.opacity, .2);
  assert.equal(marker.getElement().innerHTML, '<svg>boat</svg>');
  assert.equal(f.storage.get('boat.map.provider'), 'osm');
  await f.view.switchProvider('amap');
  assert.deepEqual(plain(f.view.map.center), [123.004, 33.002]);
  assert.equal(f.scripts.length, 1, 'a loaded SDK is reused when returning to AMap');
  assert.deepEqual(plain(marker.native.position), [121.004, 31.002]);
  f.view.destroy();
});

test('unconfigured AMap and failed SDK switches keep the current map and successful preference', async () => {
  const unconfigured = fixture({ enabled: false, configured: false });
  await unconfigured.view.initialize();
  const available = unconfigured.view.map;
  await assert.rejects(unconfigured.view.switchProvider('amap'), /Key/);
  assert.equal(unconfigured.view.provider, 'osm');
  assert.equal(unconfigured.view.map, available);
  assert.equal(unconfigured.view.ready, true);
  assert.equal(unconfigured.view.switching, false);
  assert.equal(unconfigured.scripts.length, 0);
  assert.equal(unconfigured.storage.has('boat.map.provider'), false);
  unconfigured.view.destroy();
  for (const fail of ['network', 'timeout']) {
    const f = fixture(configured, { 'boat.map.provider': 'osm' });
    await f.view.initialize();
    const map = f.view.map;
    const marker = f.view.createMarker([31, 121]);
    const native = marker.native;
    let changes = 0;
    f.view.on('providerchange', () => changes++);
    const pending = f.view.switchProvider('amap');
    await until(() => f.scripts.length === 1);
    if (fail === 'network') f.scripts[0].onerror(); else f.runTimer(15000);
    await assert.rejects(pending, /SDK/);
    assert.equal(f.view.provider, 'osm');
    assert.equal(f.view.map, map);
    assert.equal(f.view.ready, true);
    assert.equal(f.view.switching, false);
    assert.equal(marker.native, native);
    assert.equal(map.removed, undefined);
    assert.equal(f.storage.get('boat.map.provider'), 'osm');
    assert.equal(changes, 0);
    assert.equal(f.timers.size, 0);
    f.view.destroy();
  }
});

test('native map creation failure rolls back the old provider, content, viewport and preference', async () => {
  const f = fixture(configured, { 'boat.map.provider': 'osm' });
  await f.view.initialize();
  const marker = f.view.createMarker([31, 121]);
  marker.setOpacity(.4);
  marker.getElement().innerHTML = '<svg>current</svg>';
  f.view.setTrackLines([{ points: [[31, 121], [32, 122]], color: '#123456' }]);
  f.view.map.setView([33, 123], 14);
  const pending = f.view.switchProvider('amap');
  await until(() => f.scripts.length === 1);
  f.AMap.Map = function () { throw new Error('native map creation failed'); };
  f.finishSdk();
  await assert.rejects(pending, /native map creation failed/);
  assert.equal(f.view.provider, 'osm');
  assert.equal(f.view.ready, true);
  assert.equal(f.view.switching, false);
  assert.equal(f.storage.get('boat.map.provider'), 'osm');
  assert.deepEqual(plain(f.view.map.center), [33, 123]);
  assert.equal(f.view.getZoom(), 14);
  assert.deepEqual(plain(marker.native.position), [31, 121]);
  assert.equal(marker.native.opacity, .4);
  assert.equal(marker.getElement().innerHTML, '<svg>current</svg>');
  assert.deepEqual(plain(f.lines.at(-1).path), [[31, 121], [32, 122]]);
  f.view.destroy();
});

test('destroy cancels an in-flight provider switch and late SDK callbacks cannot resurrect it', async () => {
  const f = fixture(configured, { 'boat.map.provider': 'osm' });
  await f.view.initialize();
  const map = f.view.map;
  const pending = f.view.switchProvider('amap');
  await until(() => f.scripts.length === 1);
  const callback = new URL(f.scripts[0].src).searchParams.get('callback');
  const lateCallback = f.window[callback];
  f.view.destroy();
  await pending;
  f.window.AMap = f.AMap;
  lateCallback();
  assert.equal(map.removed, true);
  assert.equal(f.view.ready, false);
  assert.equal(f.view.map, null);
  assert.equal(f.view.switching, false);
  assert.equal(f.maps.length, 1);
  assert.equal(f.storage.get('boat.map.provider'), 'osm');
  assert.equal(f.window[callback], undefined);
  assert.equal(f.timers.size, 0);
  await f.view.switchProvider('amap');
  assert.equal(f.maps.length, 1);
});

test('storage restrictions cannot prevent initialization or an otherwise successful switch', async () => {
  const f = fixture();
  f.window.localStorage = {
    getItem() { throw new Error('storage is blocked'); },
    setItem() { throw new Error('storage is blocked'); }
  };
  await readyAmap(f);
  await f.view.switchProvider('osm');
  assert.equal(f.view.provider, 'osm');
  assert.equal(f.view.ready, true);
  assert.equal(f.view.switching, false);
  f.view.destroy();
});

test('AMap initialization waits for rendered complete instead of treating SDK or construction as ready', async () => {
  const f = fixture(configured, {}, { autoComplete: false });
  let ready = 0, finished = false;
  f.view.on('ready', () => ready++);
  const pending = f.view.initialize().then(() => { finished = true; });
  await until(() => f.scripts.length === 1);
  f.finishSdk();
  await until(() => f.maps.length === 1 && f.maps[0].listenerCount('complete') > 0);
  assert.equal(f.view.provider, 'amap');
  assert.equal(f.view.ready, false);
  assert.equal(ready, 0);
  assert.equal(finished, false);
  assert.notEqual(f.view.status.tone, 'success');
  f.maps[0].emit('complete');
  await pending;
  assert.equal(f.view.ready, true);
  assert.equal(ready, 1);
  assert.equal(finished, true);
  assert.equal(f.view.status.tone, 'success');
  assert.equal(f.timers.size, 0);
  f.maps[0].emit('complete');
  assert.equal(ready, 1, 'repeated complete cannot emit ready twice');
  f.view.destroy();
  assert.equal(f.maps[0].listenerCount('complete'), 0);
});

test('AMap render error or timeout leaves an explicit failure that can recover by switching to OSM', async () => {
  for (const fail of ['error', 'timeout']) {
    const f = fixture(configured, {}, { autoComplete: false });
    let ready = 0;
    f.view.on('ready', () => ready++);
    const pending = f.view.initialize();
    await until(() => f.scripts.length === 1);
    f.finishSdk();
    await until(() => f.maps.length === 1 && f.maps[0].listenerCount('complete') > 0);
    const map = f.maps[0];
    if (fail === 'error') map.emit('error', { message: 'render failed' }); else f.runTimer(15000);
    await pending;
    assert.equal(f.view.ready, false);
    assert.equal(f.view.switching, false);
    assert.equal(f.view.status.tone, 'error');
    assert.match(f.view.status.message, /高德地图加载失败/);
    assert.equal(ready, 0);
    assert.equal(map.destroyed, true);
    assert.equal(map.listenerCount('complete'), 0);
    assert.equal(map.listenerCount('error'), 0);
    assert.equal(f.timers.size, 0);
    map.emit('complete');
    assert.equal(f.view.ready, false, 'late complete cannot erase render failure');
    await f.view.switchProvider('osm');
    assert.equal(f.view.provider, 'osm');
    assert.equal(f.view.ready, true);
    assert.equal(f.storage.get('boat.map.provider'), 'osm');
    f.view.destroy();
  }
});

test('switching to AMap remains pending and cannot save its preference until rendered complete', async () => {
  const f = fixture(configured, { 'boat.map.provider': 'osm' }, { autoComplete: false });
  await f.view.initialize();
  let changed = 0, finished = false;
  f.view.on('providerchange', () => changed++);
  const pending = f.view.switchProvider('amap').then(() => { finished = true; });
  await until(() => f.scripts.length === 1);
  f.finishSdk();
  await until(() => f.maps.length === 2 && f.maps[1].listenerCount('complete') > 0);
  assert.equal(f.view.switching, true);
  assert.equal(f.view.ready, false);
  assert.equal(finished, false);
  assert.equal(changed, 0);
  assert.equal(f.storage.get('boat.map.provider'), 'osm');
  f.maps[1].emit('complete');
  await pending;
  assert.equal(f.view.switching, false);
  assert.equal(f.view.ready, true);
  assert.equal(finished, true);
  assert.equal(changed, 1);
  assert.equal(f.storage.get('boat.map.provider'), 'amap');
  assert.equal(f.timers.size, 0);
  f.view.destroy();
});

test('AMap render failure during a switch rolls back the usable map and does not save a failed selection', async () => {
  for (const fail of ['error', 'timeout']) {
    const f = fixture(configured, { 'boat.map.provider': 'osm' }, { autoComplete: false });
    await f.view.initialize();
    const marker = f.view.createMarker([31, 121]);
    marker.setOpacity(.4);
    marker.getElement().innerHTML = '<svg>current</svg>';
    f.view.setTrackLines([{ points: [[31, 121], [32, 122]], color: '#123456' }]);
    f.view.map.setView([33, 123], 14);
    let changed = 0;
    f.view.on('providerchange', () => changed++);
    const pending = f.view.switchProvider('amap');
    const rejected = assert.rejects(pending);
    await until(() => f.scripts.length === 1);
    f.finishSdk();
    await until(() => f.maps.length === 2 && f.maps[1].listenerCount('complete') > 0);
    const failedMap = f.maps[1];
    assert.equal(f.view.switching, true);
    assert.equal(f.storage.get('boat.map.provider'), 'osm');
    if (fail === 'error') failedMap.emit('error', { message: 'render failed' }); else f.runTimer(15000);
    await rejected;
    assert.equal(f.view.provider, 'osm');
    assert.equal(f.view.ready, true);
    assert.equal(f.view.switching, false);
    assert.equal(f.storage.get('boat.map.provider'), 'osm');
    assert.equal(changed, 0);
    assert.equal(failedMap.destroyed, true);
    assert.equal(failedMap.listenerCount('complete'), 0);
    assert.equal(failedMap.listenerCount('error'), 0);
    assert.deepEqual(plain(f.view.map.center), [33, 123]);
    assert.equal(f.view.getZoom(), 14);
    assert.deepEqual(plain(marker.native.position), [31, 121]);
    assert.equal(marker.native.opacity, .4);
    assert.equal(marker.getElement().innerHTML, '<svg>current</svg>');
    assert.deepEqual(plain(f.lines.at(-1).path), [[31, 121], [32, 122]]);
    failedMap.emit('complete');
    assert.equal(f.view.provider, 'osm');
    assert.equal(f.storage.get('boat.map.provider'), 'osm');
    assert.equal(f.timers.size, 0);
    f.view.destroy();
  }
});

test('destroy cancels initial and switched render waits and late complete never resurrects a map', async () => {
  for (const switching of [false, true]) {
    const f = fixture(configured, switching ? { 'boat.map.provider': 'osm' } : {}, { autoComplete: false });
    if (switching) await f.view.initialize();
    let ready = 0, changed = 0;
    f.view.on('ready', () => ready++).on('providerchange', () => changed++);
    const pending = switching ? f.view.switchProvider('amap') : f.view.initialize();
    await until(() => f.scripts.length === 1);
    f.finishSdk();
    await until(() => f.maps.at(-1)?.provider === 'amap' && f.maps.at(-1).listenerCount('complete') > 0);
    const map = f.maps.at(-1), mapCount = f.maps.length;
    f.view.destroy();
    await pending;
    map.emit('complete');
    map.emit('error', { message: 'late error' });
    assert.equal(map.destroyed, true);
    assert.equal(map.listenerCount('complete'), 0);
    assert.equal(map.listenerCount('error'), 0);
    assert.equal(f.view.ready, false);
    assert.equal(f.view.switching, false);
    assert.equal(f.view.map, null);
    assert.equal(f.maps.length, mapCount);
    assert.equal(ready, 0);
    assert.equal(changed, 0);
    assert.notEqual(f.storage.get('boat.map.provider'), 'amap');
    assert.equal(f.timers.size, 0);
    assert.equal(f.listeners.size, 0);
  }
});

test('AMap CSP violations before or after complete stay visible and cannot leak into OSM or a disposed view', async () => {
  for (const timing of ['before', 'after']) {
    const f = fixture(configured, {}, { autoComplete: false });
    const pending = f.view.initialize();
    await until(() => f.scripts.length === 1);
    f.finishSdk();
    await until(() => f.maps.length === 1 && f.maps[0].listenerCount('complete') > 0);
    const loading = plain(f.view.status);
    for (const uri of ['https://example.com/asset.js', 'https://amap.com.example.com/asset.js']) {
      f.emitDocument('securitypolicyviolation', { sourceFile: uri, blockedURI: uri });
      assert.deepEqual(plain(f.view.status), loading, 'unrelated domains cannot produce an AMap warning');
    }
    const violation = timing === 'before'
      ? { sourceFile: 'https://webapi.amap.com/maps?v=2.0', blockedURI: 'eval' }
      : { sourceFile: '', blockedURI: 'https://vdata.amap.com/tiles' };
    if (timing === 'before') f.emitDocument('securitypolicyviolation', violation);
    f.maps[0].emit('complete');
    await pending;
    assert.equal(f.view.ready, true);
    if (timing === 'after') {
      assert.equal(f.view.status.tone, 'success');
      f.emitDocument('securitypolicyviolation', violation);
    }
    assert.equal(f.view.status.tone, 'warning');
    assert.match(f.view.status.message, /CSP/);
    f.maps[0].emit('complete');
    assert.equal(f.view.status.tone, 'warning', 'complete cannot overwrite a known CSP warning with success');
    await f.view.switchProvider('osm');
    const osmStatus = plain(f.view.status);
    assert.equal(f.view.provider, 'osm');
    assert.equal(osmStatus.tone, 'neutral');
    f.emitDocument('securitypolicyviolation', { sourceFile: 'https://webapi.amap.com/maps', blockedURI: 'https://restapi.amap.com/' });
    assert.deepEqual(plain(f.view.status), osmStatus, 'late AMap violations cannot affect OSM');
    const back = f.view.switchProvider('amap');
    await until(() => f.maps.at(-1).provider === 'amap' && f.maps.at(-1).listenerCount('complete') > 0);
    f.maps.at(-1).emit('complete');
    await back;
    assert.equal(f.view.status.tone, 'success', 'a new map does not inherit the disposed map CSP warning');
    f.emitDocument('securitypolicyviolation', { sourceFile: 'https://webrd.autonavi.com/assets.js', blockedURI: 'blob' });
    assert.equal(f.view.status.tone, 'warning', 'Autonavi sources are recognized alongside AMap');
    const late = [...f.documentListeners.get('securitypolicyviolation')][0];
    f.view.destroy();
    const disposedStatus = plain(f.view.status);
    assert.equal(f.documentListeners.size, 0);
    f.emitDocument('securitypolicyviolation', violation);
    late(violation);
    assert.deepEqual(plain(f.view.status), disposedStatus, 'queued policy events cannot change a destroyed view');
    assert.equal(f.view.ready, false);
    assert.equal(f.view.map, null);
  }
});
