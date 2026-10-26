'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mapSource = fs.readFileSync(path.join(__dirname, '../public/map-view.js'), 'utf8');
const fleetSource = fs.readFileSync(path.join(__dirname, '../public/fleet-map-view.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function element(tag = 'div') {
  const classes = new Set();
  return {
    tagName: tag, children: [], style: { setProperty(name, value) { this[name] = value; } }, dataset: {},
    listeners: new Map(), hidden: false, textContent: '', value: '', className: '',
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); },
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); return !!force; } },
    append(...items) { for (const item of items) { item.parentElement?.removeChild(item); item.parentElement = this; this.children.push(item); } },
    appendChild(item) { this.append(item); return item; },
    removeChild(item) { this.children = this.children.filter(child => child !== item); item.parentElement = null; return item; },
    replaceChildren(...items) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...items); },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    removeEventListener(name, handler) { if (this.listeners.get(name) === handler) this.listeners.delete(name); },
    fire(name) { this.listeners.get(name)?.({ target: this }); },
    setAttribute(name, value) { (this.attributes ||= {})[name] = value; },
    remove() { this.parentElement?.removeChild(this); this.removed = true; },
    closest(selector) {
      const names = selector.split(',').map(value => value.trim().slice(1));
      for (let node = this; node; node = node.parentElement) if (names.some(name => node.className.split(/\s+/).includes(name))) return node;
      return null;
    },
    requestFullscreen() { this.ownerDocument.fullscreenElement = this; this.ownerDocument.dispatch('fullscreenchange'); return Promise.resolve(); }
  };
}

function fleetFixture(initialView = 'overview') {
  const ids = ['fleetMap', 'fleetMapStatus', 'fleetMapLegend', 'fleetMapFit', 'fleetMapFullscreen', 'fleet-map-panel', 'view-fleet'];
  const nodes = Object.fromEntries(ids.map(id => [id, element(id === 'fleetMap' ? 'section' : 'div')]));
  const documentListeners = new Map(), windowListeners = new Map();
  nodes['fleet-map-panel'].className = 'fleet-map-panel';
  const document = {
    documentElement: { dataset: { theme: 'dark' } }, hidden: false, fullscreenElement: null,
    getElementById(id) { return nodes[id] || null; }, createElement: element,
    addEventListener(name, handler) { documentListeners.set(name, handler); },
    removeEventListener(name, handler) { if (documentListeners.get(name) === handler) documentListeners.delete(name); },
    dispatch(name) { documentListeners.get(name)?.({}); },
    exitFullscreen() { this.fullscreenElement = null; this.dispatch('fullscreenchange'); return Promise.resolve(); }
  };
  nodes.fleetMap.ownerDocument = document;
  nodes['fleet-map-panel'].ownerDocument = document;
  nodes['fleet-map-panel'].append(nodes.fleetMap);
  const intervalCalls = new Map(); let intervalId = 0;
  const window = {
    document, BoatWorkspace: { current: initialView },
    setInterval(fn) { const id = ++intervalId; intervalCalls.set(id, fn); return id; },
    clearInterval(id) { intervalCalls.delete(id); },
    addEventListener(name, fn) { if (!windowListeners.has(name)) windowListeners.set(name, new Set()); windowListeners.get(name).add(fn); },
    removeEventListener(name, fn) { windowListeners.get(name)?.delete(fn); },
    dispatch(name, detail) { for (const fn of [...(windowListeners.get(name) || [])]) fn({ detail }); }
  };
  class MockMapView {
    constructor() { this.events = new Map(); this.markers = []; this.fitCalls = []; this.invalidateCalls = 0; this.destroyed = false; this.ready = false; this.initializeCalls = 0; }
    on(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); return this; }
    off(name, fn) { this.events.get(name)?.delete(fn); return this; }
    emit(name, value) { for (const fn of [...(this.events.get(name) || [])]) fn(value); }
    initialize() { this.initializeCalls++; this.ready = true; this.emit('ready', this); return Promise.resolve(this); }
    setTheme(theme) { this.theme = theme; }
    invalidateSize() { this.invalidateCalls++; }
    createMarker(location, options) {
      const marker = { position: { ...location }, options, updates: [], removed: false,
        setPosition(value) { this.position = { ...value }; this.updates.push(this.position); },
        click() { this.options.onClick?.(); },
        remove() { this.removed = true; } };
      this.markers.push(marker); return marker;
    }
    fitLocations(locations, options) { this.fitCalls.push({ locations: plain(locations), options: plain(options) }); return true; }
    destroy() { this.destroyed = true; }
  }
  vm.runInNewContext(fleetSource, { window, Date });
  const map = new MockMapView();
  let now = 1700000000000;const selected=[];
  const view = new window.BoatFleetMapView({ document, mapView: map, now: () => now, onSelect:id=>selected.push(id) });
  return { window, document, nodes, map, view, selected, intervalCalls, windowListeners,
    setNow(value) { now = value; }, now: () => now };
}

function device(id, now, changes = {}) {
  return { id, online: true, lastReceivedAt: now, summary: {
    receivedAt: now, latitude: 31.23, longitude: 121.47,
    validUntil: { position: now + 1000 }, ...changes
  } };
}

function state(devices, changes = {}) {
  return { devices, authenticated: true, enabled: true, brokerConnected: true,
    streamConnected: true, serverOffset: 0, ...changes };
}

function mapApiFixture(provider) {
  const mapContainer = element('div'), listeners = new Map(), maps = [], tileLayers = [], nativeMarkers = [];
  const document = {
    documentElement: { dataset: { theme: 'dark' } },
    addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'map' ? mapContainer : null; },
    createElement: element, head: { appendChild() {} }
  };
  const map = {
    provider, center: provider === 'amap' ? [121.47, 31.23] : [31.23, 121.47], zoom: 5,
    events: new Map(),
    on(name, fn) {
      if (!this.events.has(name)) this.events.set(name, new Set());
      this.events.get(name).add(fn);
      if (provider === 'amap' && name === 'complete') Promise.resolve().then(() => this.emit('complete'));
      return this;
    },
    off(name, fn) { if (fn) this.events.get(name)?.delete(fn); else this.events.delete(name); },
    emit(name) { for (const fn of [...(this.events.get(name) || [])]) fn(); },
    setView(position, zoom, options) { this.center = position; this.zoom = zoom; this.viewOptions = options; return this; },
    setZoomAndCenter(zoom, center, immediately) { this.zoom = zoom; this.center = center; this.immediately = immediately; },
    setCenter(center) { this.center = center; },
    getCenter() { return provider === 'amap' ? { lng: this.center[0], lat: this.center[1] } : { lat: this.center[0], lng: this.center[1] }; },
    getZoom() { return this.zoom; }, setZoom(zoom) { this.zoom = zoom; },
    setBounds(bounds, immediately) { this.bounds = bounds; this.boundsImmediate = immediately; },
    fitBounds(bounds, options) { this.fit = { bounds, options }; },
    getSize() { return { width: 400, height: 300 }; },
    setMapStyle() {}, resize() {}, invalidateSize() {}, destroy() {}, remove() {}
  };
  const makeMarker = (position, options) => {
    const handlers = new Map();
    const marker = { position, options, handlers,
      on(name, handler) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(handler); return this; },
      off(name, handler) { handlers.get(name)?.delete(handler); return this; },
      fire(name) { for (const handler of [...(handlers.get(name) || [])]) handler({ target: this }); },
      setPosition(value) { this.position = value; }, setLatLng(value) { this.position = value; },
      setMap(value) { this.map = value; }, addTo(value) { this.map = value; return this; },
      remove() { this.map = null; }, getElement() { return element('div'); }
    };
    nativeMarkers.push(marker);return marker;
  };
  const L = {
    map(_container, options) { Object.assign(map, { options }); maps.push(map); return map; },
    marker(position, options) { return makeMarker(position, options); },
    divIcon(options) { return options; },
    tileLayer(url, options) {
      const layer = { url, options, on() { return this; }, addTo(target) { this.map = target; return this; } };
      tileLayers.push(layer); return layer;
    }
  };
  const conversions = [];
  function Bounds(southwest, northeast) { this.southwest = southwest; this.northeast = northeast; }
  const AMap = provider === 'amap' ? {
    Bounds,
    LngLat: function (lng, lat) { this.lng = lng; this.lat = lat; },
    Map: function (_container, options) { Object.assign(map, { options }); maps.push(map); return map; },
    Pixel: function (x, y) { this.x = x; this.y = y; },
    Marker: function (options) { return makeMarker(options.position, options); }
  } : null;
  const storage = new Map(provider === 'osm' ? [['boat.map.provider', 'osm']] : []);
  const window = {
    document, L, ...(AMap ? { AMap } : {}),
    localStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, value); } },
    fetch: async () => ({ ok: true, json: async () => provider === 'osm' ?
      { enabled: false, configured: false, reason: 'none' } :
      { enabled: true, configured: true, key: 'test-key', securityJsCode: 'test-code' } }),
    setTimeout, clearTimeout, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
    BoatModules: { mapCoordinates: { wgs84ToGcj02(latitude, longitude) {
      conversions.push([latitude, longitude]); return { latitude: latitude + .002, longitude: longitude + .004 };
    } } }
  };
  vm.runInNewContext(mapSource, { window, Map, Set, Date, Promise, module: { exports: {} } });
  const view = new window.BoatMapView('map');
  return { view, map, maps, tileLayers, conversions, nativeMarkers, Bounds };
}

test('BoatMapView fits WGS84 locations on OSM and uses projected bounds on AMap', async () => {
  const osm = mapApiFixture('osm');
  await osm.view.initialize();
  assert.equal(osm.view.fitLocations([{ latitude: 31, longitude: 121 }, { latitude: 32, longitude: 122 }],
    { padding: [20, 24], maxZoom: 13, animate: false }), true);
  assert.deepEqual(plain(osm.map.fit), { bounds: [[31, 121], [32, 122]], options: { padding: [20, 24], maxZoom: 13, animate: false } });
  assert.equal(osm.view.fitLocations([{ latitude: 31, longitude: 121 }, { latitude: 31, longitude: 121 }]), true);
  assert.equal(osm.map.zoom, 15);
  assert.equal(osm.view.fitLocations([{ latitude: 91, longitude: 0 }, null]), false);
  assert.equal(osm.tileLayers.length, 1, 'test uses a stub tile layer and never requests network tiles');
  osm.view.destroy();

  const amap = mapApiFixture('amap');
  await amap.view.initialize();
  assert.equal(amap.view.fitLocations([{ latitude: 31, longitude: 121 }, { latitude: 32, longitude: 122 }],
    { maxZoom: 14, animate: false }), true);
  assert.ok(amap.map.bounds instanceof amap.Bounds);
  assert.deepEqual(plain(amap.map.bounds.southwest), { lng: 121.004, lat: 31.002 });
  assert.deepEqual(plain(amap.map.bounds.northeast), { lng: 122.004, lat: 32.002 });
  assert.equal(amap.map.boundsImmediate, true);
  assert.deepEqual(amap.conversions, [[31.23, 121.47], [31, 121], [32, 122]]);
  amap.view.destroy();
});

test('BoatMapView click callbacks stay interactive on OSM and AMap and are detached on remove', async () => {
  for (const provider of ['osm','amap']) {
    const fixture = mapApiFixture(provider);await fixture.view.initialize();let clicks=0;
    const marker=fixture.view.createMarker({latitude:31.23,longitude:121.47},{interactive:false,title:'boat-01',onClick:()=>clicks++});
    const native=marker.native;assert.equal(native.options.clickable ?? native.options.interactive,true);
    native.fire('click');assert.equal(clicks,1);
    marker.remove();native.fire('click');assert.equal(clicks,1);assert.equal(native.handlers.get('click').size,0);
    fixture.view.destroy();
  }
});

test('fleet map defers initialization, updates current markers and fits only fresh locations', () => {
  const f = fleetFixture('overview'), now = f.now();
  f.view.update(state([device('boat-01', now)]));
  assert.equal(f.map.initializeCalls, 0);
  assert.equal(f.map.ready, false, 'hidden fleet view does not initialize its basemap');
  f.window.dispatch('boat-view-change', { view: 'fleet' });
  assert.equal(f.map.ready, true);
  assert.equal(f.map.markers.length, 1);
  const marker = f.map.markers[0];
  assert.equal(marker.options.className, 'fleet-map-pin-shell');
  assert.match(marker.options.html, /boat-01/);
  assert.equal(f.map.fitCalls.length, 1);
  marker.click();assert.deepEqual(f.selected,['boat-01']);
  const legendItem = f.nodes.fleetMapLegend.children[0];
  assert.equal(legendItem.dataset.online, 'true');
  assert.equal(legendItem.children[0].className, 'fleet-map-legend-swatch');
  assert.match(legendItem.children[0].style['--vessel-color'], /^hsl\(/);

  const next = device('boat-01', now + 100);
  next.summary.latitude = 31.5;
  f.view.update(state([next]));
  assert.equal(f.map.markers[0], marker, 'marker identity remains stable as its position changes');
  assert.deepEqual(plain(marker.position), { latitude: 31.5, longitude: 121.47 });
  assert.equal(marker.updates.length, 1);
  assert.equal(f.map.fitCalls.length, 1, 'telemetry updates do not reset a user-adjusted map view');

  f.setNow(now + 1100);
  f.view.render();
  assert.equal(marker.removed, true);
  assert.equal(f.map.markers.length, 1, 'the map object and basemap remain initialized');
  assert.match(f.nodes.fleetMapStatus.textContent, /暂无有效定位/);
  assert.equal(f.view.fitLocations(), false);
  f.nodes.fleetMapFit.fire('click');
  assert.equal(f.map.fitCalls.length, 1, 'fit control is a no-op when no fresh position exists');
  f.view.destroy();
});

test('fleet map excludes invalid/expired positions, clears on disconnect, reapplies theme and invalidates when shown', () => {
  const f = fleetFixture('fleet'), now = f.now();
  const valid = device('boat-01', now);
  const old = device('boat-02', now - 1000);
  old.online = false;
  const invalid = device('boat-03', now, { latitude: 91, longitude: 10 });
  const stale = device('boat-04', now - 1000);
  f.view.update(state([valid, old, invalid, stale]));
  assert.equal(f.map.markers.length, 1);
  assert.equal(f.map.markers[0].options.html.includes('boat-01'), true);
  assert.equal(f.nodes.fleetMapLegend.children.length, 4);
  assert.equal(f.nodes.fleetMapLegend.children[1].dataset.online, 'false');
  assert.equal(f.nodes.fleetMapLegend.children[1].dataset.located, 'false');
  assert.equal(f.nodes.fleetMapLegend.children[3].dataset.online, 'true');
  assert.equal(f.nodes.fleetMapLegend.children[3].dataset.located, 'false');

  f.view.update(state([valid], { streamConnected: false }));
  assert.equal(f.map.markers[0].removed, true);
  assert.equal(f.view.markers.size, 0);
  assert.match(f.nodes.fleetMapStatus.textContent, /数据通道已断开/);
  assert.equal(f.map.destroyed, false);

  f.document.documentElement.dataset.theme = 'light';
  f.window.dispatch('boat-theme-change');
  assert.equal(f.map.theme, 'light');
  f.view.update(state([valid]));
  f.window.dispatch('boat-view-change', { view: 'overview' });
  const before = f.map.invalidateCalls;
  f.window.dispatch('boat-view-change', { view: 'fleet' });
  assert.equal(f.map.invalidateCalls, before + 1);
  assert.equal(f.map.markers.length, 2);

  const marker = f.map.markers.at(-1);
  f.view.destroy();
  assert.equal(marker.removed, true);
  assert.equal(f.map.destroyed, true);
  assert.equal(f.intervalCalls.size, 0);
  assert.equal(f.windowListeners.get('boat-view-change').size, 0);
});

test('fleet map retains an accurate empty state and assigns stable colors to device IDs', () => {
  const f = fleetFixture('fleet'), now = f.now();
  f.view.update(state([]));
  assert.match(f.nodes.fleetMapStatus.textContent, /暂无已接入无人船/);
  assert.equal(f.map.markers.length, 0);
  assert.equal(f.map.ready, true, 'the basemap remains available with no vessel positions');
  const first = f.view.constructor.deviceColor('boat-01');
  assert.equal(f.view.constructor.deviceColor('boat-01'), first);
  assert.notEqual(f.view.constructor.deviceColor('boat-02'), first);
  f.view.update(state([device('boat-01', now)], { authenticated: false }));
  assert.match(f.nodes.fleetMapStatus.textContent, /登录后查看/);
  assert.equal(f.map.markers.length, 0);
  f.view.destroy();
});

test('fullscreen targets the map panel, resizes the map, updates its label, and restores layout on exit', async () => {
  const f = fleetFixture('fleet'), frame = f.nodes['fleet-map-panel'];
  f.nodes.fleetMap.style.height = '420px';
  f.nodes.fleetMap.style.minHeight = '280px';
  const before = f.map.invalidateCalls;
  await f.view.toggleFullscreen();
  await Promise.resolve();
  assert.equal(f.document.fullscreenElement, frame);
  assert.equal(frame.classList.contains('is-fullscreen'), true);
  assert.equal(f.nodes.fleetMap.style.height, 'min(88vh, 960px)');
  assert.equal(f.nodes.fleetMap.style.minHeight, '320px');
  assert.equal(f.nodes.fleetMapFullscreen.attributes['aria-label'], '退出地图全屏');
  assert.ok(f.map.invalidateCalls > before, 'the map resizes after entering fullscreen');

  await f.view.toggleFullscreen();
  await Promise.resolve();
  assert.equal(f.document.fullscreenElement, null);
  assert.equal(frame.classList.contains('is-fullscreen'), false);
  assert.equal(f.nodes.fleetMap.style.height, '420px');
  assert.equal(f.nodes.fleetMap.style.minHeight, '280px');
  assert.equal(f.nodes.fleetMapFullscreen.attributes['aria-label'], '进入地图全屏');
  f.view.destroy();
});
