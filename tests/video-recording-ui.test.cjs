'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { BoatVideoRecordingPanel } = require('../public/video-recording');
const BASE = '/api/video/recording', ROOT = '/var/lib/unmanned-boat-video';
const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const config = (extra = {}) => ({ enabled: true, persistent: true, directory: ROOT + '/recordings', allowedRoot: ROOT, segmentSeconds: 60, retentionDays: 7, activeCount: 0, ...extra });
const clip = (boat = 'boat-01', id = 'a'.repeat(64)) => ({ id, start: '2026-10-28T01:02:03Z', duration: 60, playbackUrl: BASE + '/boats/' + boat + '/clips/' + id, downloadUrl: BASE + '/boats/' + boat + '/clips/' + id + '?download=1' });
const snapshot = (boat = 'boat-01', extra = {}) => ({ deviceId: boat, enabled: true, armed: false, receiving: false, recording: false, error: null, segments: [clip(boat)], ...extra });
function setup(role = 'admin') {
  const nodes = new Map(), calls = [], timers = new Map(); let sequence = 0, next;
  class Node {
    constructor() { this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this.children = []; this.attributes = {}; this.listeners = new Map(); this.paused = true; this.loads = 0; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    removeEventListener(name) { this.listeners.delete(name); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return name === 'src' ? this.src : this.attributes[name]; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') delete this.src; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    load() { this.loads++; }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  class Auth extends EventTarget {
    constructor() { super(); this.enabled = true; this.ready = true; this.user = role ? { username: role, role } : null; this.generation = 1; }
    notify() { this.dispatchEvent(new Event('change')); }
    change(role, username = role) { this.generation++; this.user = role ? { username, role } : null; this.notify(); }
    async verifyManage() { if (this.verify) await this.verify(); this.notify(); if (this.user?.role !== 'admin') throw Error('请登录管理员'); }
    expire() { this.change(null); }
    initialize() { return Promise.resolve(); }
  }
  const auth = new Auth();
  const panel = new BoatVideoRecordingPanel({ document: { getElementById: node, createElement: () => new Node() }, auth, AbortController,
    fetcher: async (url, options) => { calls.push({ url, ...options }); if (next) return next(url, options);
      if (url.endsWith('/config')) return reply(200, config(options.method === 'PATCH' ? { directory: JSON.parse(options.body).directory } : {}));
      const boat = url.split('/')[5]; return reply(200, snapshot(boat, url.endsWith('/start') ? { armed: true } : {}));
    },
    setTimeout(fn, duration) { const id = ++sequence; timers.set(id, { fn, duration }); return id; }, clearTimeout(id) { timers.delete(id); }
  });
  return { panel, node, auth, calls, timers, next(fn) { next = fn; },
    async show(boat = 'boat-01') { panel.update({ deviceId: boat, authenticated: true }); panel.setVisible(true); await until(() => !panel.channels.boat.busy); },
    timeout(duration = 20000) { const [id, item] = [...timers].find(([, timer]) => timer.duration === duration) || []; assert.ok(item); timers.delete(id); item.fn(); }
  };
}
async function until(predicate) { for (let i = 0; i < 80; i++) { if (predicate()) return; await Promise.resolve(); } assert.fail('Expected asynchronous phase'); }

test('offline telemetry does not prevent viewing clips or arming server recording', async () => {
  const h = setup(); await h.show(); assert.equal(h.panel.snapshot.segments.length, 1); assert.equal(h.node('recordingStart').disabled, false);
  assert.equal(await h.panel.command('start'), true); assert.equal(h.panel.snapshot.armed, true); assert.match(h.node('recordingStatus').textContent, /等待船端视频/);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1); assert.equal(h.node('recordingStop').disabled, false);
  h.panel.setVisible(false); assert.equal(h.calls.filter(call => call.method === 'POST').length, 1, 'Leaving the page never stops server recording'); h.panel.destroy();
});

test('guests can read, replay and download while all recording and directory writes are blocked', async () => {
  const h = setup('guest'); await h.show(); assert.equal(h.node('recordingStart').hidden, true); assert.equal(h.node('recordingSettings').hidden, true);
  assert.equal(await h.panel.command('start'), false); assert.equal(await h.panel.open(), false); assert.equal(await h.panel.saveSettings(), false);
  assert.equal(h.panel.playClip('a'.repeat(64)), true); assert.match(h.node('recordingPlayer').src, /boat-01\/clips\//);
  assert.equal(h.node('recordingList').children.length, 1); assert.equal(h.calls.length, 1); h.panel.destroy();
});

test('changing boat cancels old requests and unloads playback; late responses cannot cross boat boundaries', async () => {
  const h = setup(); await h.show(); h.panel.playClip('a'.repeat(64)); let release;
  h.next(() => new Promise(resolve => { release = resolve; })); const pending = h.panel.refresh(); await until(() => !!release);
  h.panel.update({ deviceId: 'boat-02', authenticated: true }); assert.equal(h.node('recordingPlayer').src, undefined); assert.equal(h.node('recordingList').children.length, 0);
  assert.equal(h.calls.at(-1).signal.aborted, true); assert.equal(await pending, false);
  h.next(async () => reply(200, snapshot('boat-02'))); h.panel._cancel('boat'); await h.panel.refresh();
  release(reply(200, snapshot('boat-01'))); await Promise.resolve(); await Promise.resolve(); assert.equal(h.panel.snapshot.deviceId, 'boat-02'); h.panel.destroy();
});

test('logout clears clip links, unloads playback and cancels pending requests without stopping server recording', async () => {
  const h = setup(); await h.show(); h.panel.playClip('a'.repeat(64)); let release;
  h.next(() => new Promise(resolve => { release = resolve; })); const pending = h.panel.refresh(); await until(() => !!release);
  h.auth.change(null); assert.equal(await pending, false); assert.equal(h.node('recordingList').children.length, 0);
  assert.equal(h.node('recordingPlayer').src, undefined); assert.equal(h.node('recordingPlayerWrap').hidden, true); assert.equal(h.node('recordingStart').hidden, true);
  release(reply(200, snapshot())); await Promise.resolve(); assert.equal(h.panel.snapshot, null); assert.equal(h.calls.some(call => call.method === 'POST'), false); h.panel.destroy();
});

test('timeouts cover hanging response bodies and allow retry without applying stale data', async () => {
  const h = setup(); await h.show(); let release;
  h.next(async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) }));
  const reading = h.panel.refresh(); await until(() => !!release); h.timeout(); assert.equal(await reading, false);
  assert.equal(h.panel.channels.boat.busy, false); assert.equal(h.node('recordingRefresh').disabled, false); assert.match(h.node('recordingStatus').textContent, /超时/);
  h.next(async () => reply(200, snapshot('boat-01', { segments: [] }))); await h.panel.refresh(); release(snapshot()); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.panel.snapshot.segments.length, 0); h.panel.destroy();
});

test('untrusted media URLs and another boat snapshot are rejected before rendering links', async () => {
  for (const data of [snapshot('boat-02'), snapshot('boat-01', { segments: [{ ...clip(), playbackUrl: 'https://evil.test/video.mp4' }] }), snapshot('boat-01', { segments: [{ ...clip(), downloadUrl: '/private/file' }] })]) {
    const h = setup(); h.next(async () => reply(200, data)); await h.show(); assert.equal(h.panel.snapshot, null); assert.equal(h.node('recordingList').children.length, 0);
    assert.match(h.node('recordingStatus').textContent, /无效/); assert.equal(h.panel.playClip('a'.repeat(64)), false); h.panel.destroy();
  }
});

test('administrator directory changes preserve server scope and show active recording lock', async () => {
  const h = setup(); assert.equal(await h.panel.open(), true); h.node('recordingDirectory').value = ROOT + '/voyage-2026';
  assert.equal(await h.panel.saveSettings(), true); assert.equal(h.panel.config.directory, ROOT + '/voyage-2026'); assert.match(h.node('recordingSettingsStatus').textContent, /旧文件保留原目录/);
  assert.deepEqual(JSON.parse(h.calls.at(-1).body), { directory: ROOT + '/voyage-2026' });
  h.next(async () => reply(200, config({ activeCount: 2 }))); await h.panel.readSettings(); assert.equal(h.node('recordingDirectory').disabled, true);
  assert.equal(h.node('recordingSettingsSave').disabled, true); assert.match(h.node('recordingSettingsRoot').textContent, /2 艘船/); assert.equal(await h.panel.saveSettings(), false); h.panel.destroy();
});

test('same-account verification keeps request alive; settings close and identity changes discard responses', async () => {
  const h = setup(); await h.panel.open(); assert.equal(h.panel.config.enabled, true); h.node('recordingDirectory').value = ROOT + '/draft'; h.auth.notify(); assert.equal(h.node('recordingDirectory').value, ROOT + '/draft');
  let release; h.next(() => new Promise(resolve => { release = resolve; })); const reading = h.panel.readSettings(); await until(() => !!release);
  h.panel.close(); assert.equal(await reading, false); release(reply(200, config())); await Promise.resolve(); assert.equal(h.panel.config, null); h.panel.destroy();
});

test('storage configuration errors block mutations while allowing settings reread', async () => {
  const h = setup(); h.next(async () => reply(200, config({ error: '录像设置损坏，请检查服务器文件' })));
  assert.equal(await h.panel.open(), true); assert.match(h.node('recordingSettingsStatus').textContent, /设置损坏/);
  assert.equal(h.node('recordingSettingsSave').disabled, true); assert.equal(h.node('recordingDirectory').disabled, true); assert.equal(h.node('recordingSettingsRead').disabled, false);
  assert.equal(await h.panel.saveSettings(), false); h.panel.destroy();
});

test('old servers and disabled media explain unavailability and keep retry usable', async () => {
  for (const result of [reply(404, {}), reply(200, { enabled: false, error: '请更新视频组件' })]) {
    const h = setup(); h.next(async () => result); await h.show(); assert.equal(h.node('recordingStart').disabled, true); assert.equal(h.node('recordingRefresh').disabled, false);
    assert.match(h.node('recordingStatus').textContent, /更新|安装/); assert.equal(await h.panel.open(), true); assert.equal(h.node('recordingSettingsSave').disabled, true); h.panel.destroy();
  }
});
