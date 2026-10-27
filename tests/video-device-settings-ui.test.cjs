const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { BoatVideoDeviceSettingsPanel } = require('../public/video-device-settings');
const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64);
const devices = () => [{ deviceId: 'boat-01', username: 'boat-01' }, { deviceId: 'boat-02', username: 'boat-02' }];
const videos = () => [{ deviceId: 'boat-01', username: 'camera-one' }];
const snapshot = () => ({ enabled: true, canManageVideo: true, revision, devices: devices(), videos: videos() });
const response = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

function setup({ role = 'admin', enabled = true, ready = true, auth: providedAuth } = {}) {
  const nodes = new Map(), calls = [], confirmations = [], timers = new Map(); let next, sequence = 0;
  class Node {
    constructor() { this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this.children = []; this.listeners = new Map(); this.attributes = {}; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() { this.focused = true; }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  class Auth extends EventTarget {
    constructor() { super(); this.enabled = enabled; this.ready = ready; this.user = role ? { username: role, role } : null; this.generation = 1; this.expirations = 0; }
    notify() { this.dispatchEvent(new Event('change')); }
    change(role, username = role) { this.generation++; this.user = role ? { username, role } : null; this.notify(); }
    async verifyManage() { if (this.verify) await this.verify(); this.notify(); if (!this.ready || this.user?.role !== 'admin') throw Error('请重新登录管理员账户'); }
    expire() { this.expirations++; this.change(null); }
    initialize() { this.notify(); return Promise.resolve(); }
    openLogin() { this.prompted = true; }
  }
  const auth = providedAuth || new Auth(), h = { confirmResult: true };
  const panel = new BoatVideoDeviceSettingsPanel({ auth, document: { getElementById: node, createElement: () => new Node() }, AbortController,
    fetcher: async (url, options) => {
      calls.push({ url, ...options }); if (next) return next(url, options);
      if (options.method === 'GET') return response(200, snapshot());
      const input = JSON.parse(options.body), deviceId = url.split('/')[4];
      return response(200, { ...snapshot(), ok: true, requiresReconnect: true, revision: nextRevision,
        videos: videos().filter(video => video.deviceId !== deviceId).concat({ deviceId, username: input.username }) });
    },
    confirm(message) { assert.equal(node('videoDevicePassword').value, ''); assert.equal(node('videoDevicePasswordConfirm').value, ''); confirmations.push(message); return h.confirmResult; },
    setTimeout(fn, duration) { const id = ++sequence; timers.set(id, { fn, duration }); return id; }, clearTimeout(id) { timers.delete(id); }
  });
  return Object.assign(h, { panel, node, auth, calls, confirmations, timers, next(fn) { next = fn; },
    fill({ username = 'camera-renamed', password = '123456', confirmation = password } = {}) { node('videoDeviceUsername').value = username; node('videoDevicePassword').value = password; node('videoDevicePasswordConfirm').value = confirmation; },
    timeout() { const [id, timer] = [...timers][0] || []; assert.ok(timer); timers.delete(id); timer.fn(); }
  });
}
async function until(predicate) { for (let i = 0; i < 40; i++) { if (predicate()) return; await Promise.resolve(); } assert.fail('asynchronous phase not reached'); }

test('真实账户身份复核发出同身份change仍可完成读取，轮询不清空视频账号草稿', async () => {
  const context = { window: {}, EventTarget, CustomEvent };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/account-auth.js'), 'utf8'), context);
  let checks = 0;
  const auth = new context.window.BoatAccountAuth({ fetch: async () => { checks++; return response(200, { enabled: true, user: { username: 'operator', role: 'admin' } }); } });
  auth.apply(true, { username: 'operator', role: 'admin' });
  const h = setup({ auth }), generation = auth.generation;
  assert.equal(await h.panel.open(), true); assert.equal(checks, 1); assert.equal(h.calls.length, 1);
  assert.equal(auth.generation, generation); assert.equal(h.panel.loaded, true); assert.equal(h.panel.busy, false);
  assert.equal(h.node('videoDeviceRead').disabled, false); assert.equal(h.timers.size, 0);
  h.panel.edit('boat-01'); h.fill(); await auth.initialize();
  assert.equal(h.panel.editingId, 'boat-01'); assert.equal(h.node('videoDeviceUsername').value, 'camera-renamed');
  assert.equal(h.node('videoDevicePassword').value, '123456'); assert.equal(await h.panel.open(), false);
  assert.equal(h.calls.length, 1); h.panel.destroy();
});

test('访客、未登录、旧登录模式或未确认身份不读取或写入视频账号', async () => {
  for (const options of [{ role: 'guest' }, { role: null }, { enabled: false }, { ready: false }]) {
    const h = setup(options);
    assert.equal(await h.panel.open(), false); assert.equal(await h.panel.read(), false);
    assert.equal(h.panel.edit('boat-01'), false); assert.equal(await h.panel.save(), false);
    assert.equal(h.node('videoDeviceSettings').hidden, true); assert.equal(h.calls.length, 0); h.panel.destroy();
  }
});

test('组件未安装或版本较旧时显示升级指引并恢复读取按钮', async () => {
  for (const data of [{ enabled: false }, { devices: devices(), revision }, { ...snapshot(), canManageVideo: false }]) {
    const h = setup(); h.next(async () => response(200, data));
    assert.equal(await h.panel.open(), true); assert.equal(h.panel.available, false); assert.equal(h.panel.busy, false);
    assert.equal(h.node('videoDeviceRead').disabled, false); assert.equal(h.node('videoDeviceSave').disabled, true);
    assert.match(h.node('videoDeviceStatus').textContent, /install-mqtt-device-admin/); assert.equal(h.panel.edit('boat-01'), false); h.panel.destroy();
  }
});

test('读取失败显示服务器原因并可立即重新读取，不永久停留读取中', async () => {
  const h = setup(); h.next(async () => response(503, { error: '读取 MQTT 设备账号失败，请检查设备管理组件后重试' }));
  assert.equal(await h.panel.open(), false); assert.equal(h.panel.busy, false); assert.equal(h.node('videoDeviceRead').disabled, false);
  assert.match(h.node('videoDeviceStatus').textContent, /设备管理组件/); assert.equal(h.node('videoDeviceStatus').dataset.tone, 'error');
  h.next(async () => response(200, snapshot())); assert.equal(await h.panel.read(), true); assert.equal(h.panel.loaded, true); h.panel.destroy();
});

test('读取和响应体挂起均在35秒结束，忽略超时后的旧响应并允许重试', async () => {
  for (const phase of ['response', 'body']) {
    const h = setup(); let release;
    h.next(() => phase === 'response' ? new Promise(resolve => { release = resolve; })
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) }));
    const reading = h.panel.open(); await until(() => !!release);
    assert.equal(await h.panel.read(), false); assert.equal([...h.timers.values()][0].duration, 35000);
    h.timeout(); assert.equal(await reading, false); assert.equal(h.panel.busy, false); assert.equal(h.calls[0].signal.aborted, true);
    assert.match(h.node('videoDeviceStatus').textContent, /读取超时/); assert.equal(h.node('videoDeviceRead').disabled, false);
    h.next(async () => response(200, { ...snapshot(), revision: nextRevision })); assert.equal(await h.panel.read(), true);
    release(phase === 'response' ? response(200, snapshot()) : snapshot()); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.panel.revision, nextRevision); assert.equal(h.panel.busy, false); h.panel.destroy();
  }
});

test('身份复核自身超时后不再发请求，复核恢复也不能发送旧读取', async () => {
  const h = setup(); let release;
  h.auth.verify = () => new Promise(resolve => { release = resolve; });
  const reading = h.panel.open(); await until(() => !!release); h.timeout(); assert.equal(await reading, false);
  assert.equal(h.panel.busy, false); assert.equal(h.calls.length, 0); release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.calls.length, 0); h.panel.destroy();
});

test('保存前立即清除密码，六位密码按固定设备路由单次发送且同身份通知不取消', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-02'); h.fill({ username: 'camera-two' });
  const saving = h.panel.save(); assert.equal(h.node('videoDevicePassword').value, ''); assert.equal(h.node('videoDevicePasswordConfirm').value, '');
  assert.equal(await h.panel.save(), false); assert.equal(await saving, true);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].url, '/api/mqtt/devices/boat-02/video'); assert.equal(h.calls[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(h.calls[1].body), { username: 'camera-two', password: '123456', revision });
  assert.equal(h.confirmations[0].includes('123456'), false); assert.match(h.confirmations[0], /boat-02[\s\S]*短暂重连/);
  assert.equal(h.panel.revision, nextRevision); assert.equal(h.panel.busy, false); assert.equal(h.node('videoDeviceForm').hidden, true); h.panel.destroy();
});

test('已有账号改名留空密码不发送空密码，同配置无重启的成功响应被准确显示', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill({ password: '' });
  assert.equal(await h.panel.save(), true); assert.deepEqual(JSON.parse(h.calls[1].body), { username: 'camera-renamed', revision });
  h.panel.edit('boat-01'); h.fill({ username: 'camera-renamed' });
  h.next(async () => response(200, { ...snapshot(), ok: true, requiresReconnect: false, revision: nextRevision }));
  assert.equal(await h.panel.save(), true); assert.match(h.node('videoDeviceStatus').textContent, /无需重启/); h.panel.destroy();
});

test('首次配置需密码、格式校验、取消编辑和取消确认均不遗留密码或发送写请求', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-02'); h.fill({ password: '' });
  assert.equal(await h.panel.save(), false); assert.match(h.node('videoDeviceStatus').textContent, /首次配置/);
  for (const password of ['short', 'a'.repeat(65), 'abc 123', 'abc:123', '密码123456', 'abc\n123']) {
    h.fill({ password }); assert.equal(await h.panel.save(), false); assert.equal(h.node('videoDevicePassword').value, '');
  }
  h.fill({ confirmation: '654321' }); assert.equal(await h.panel.save(), false); assert.match(h.node('videoDeviceStatus').textContent, /不一致/);
  h.fill(); h.confirmResult = false; assert.equal(await h.panel.save(), false); assert.equal(h.node('videoDevicePassword').value, '');
  h.fill(); h.panel.cancel(); assert.equal(h.node('videoDeviceForm').hidden, true); assert.equal(h.node('videoDevicePassword').value, '');
  assert.equal(h.calls.length, 1); h.panel.destroy();
});

test('关闭、退出或切换管理员立即取消挂起请求，旧响应不能恢复数据或忙态', async () => {
  for (const action of ['close', 'logout', 'switch', 'destroy']) {
    const h = setup(); let release; h.next(() => new Promise(resolve => { release = resolve; }));
    const reading = h.panel.open(); await until(() => !!release);
    if (action === 'close') h.panel.close(); else if (action === 'destroy') h.panel.destroy(); else h.auth.change(action === 'logout' ? null : 'admin', 'another-admin');
    assert.equal(await reading, false); assert.equal(h.panel.busy, false); assert.equal(h.timers.size, 0);
    assert.equal(h.calls[0].signal.aborted, true);
    release(response(200, snapshot())); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.panel.loaded, false); assert.equal(h.panel.devices.length, 0); assert.equal(h.panel.revision, ''); h.panel.destroy();
  }
});

test('保存身份复核期间退出或超时，即使复核后来成功也不发送写请求', async () => {
  for (const action of ['logout', 'timeout', 'close']) {
    const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill(); let release;
    h.auth.verify = () => new Promise(resolve => { release = resolve; });
    const saving = h.panel.save(); await until(() => !!release);
    if (action === 'logout') h.auth.change(null); else if (action === 'close') h.panel.close(); else h.timeout();
    assert.equal(await saving, false); release(); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.calls.length, 1); assert.equal(h.node('videoDevicePassword').value, ''); assert.equal(h.panel.busy, false); h.panel.destroy();
  }
});

test('保存超时或版本冲突后必须重新读取，迟到成功不恢复可写状态', async () => {
  for (const status of ['timeout', 409]) {
    const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill(); let release;
    h.next(() => status === 'timeout' ? new Promise(resolve => { release = resolve; }) : response(409, { error: '配置已变化，请重新读取' }));
    const saving = h.panel.save(); await until(() => h.calls.length === 2); if (status === 'timeout') h.timeout();
    assert.equal(await saving, false); assert.equal(h.panel.loaded, false); assert.equal(h.panel.revision, ''); assert.equal(h.panel.busy, false);
    assert.match(h.node('videoDeviceStatus').textContent, /重新读取/); assert.equal(h.node('videoDeviceSave').disabled, true); assert.equal(await h.panel.save(), false);
    if (release) { release(response(200, { ...snapshot(), ok: true, requiresReconnect: true })); await Promise.resolve(); await Promise.resolve(); }
    assert.equal(h.panel.loaded, false); assert.equal(h.calls.length, 2); h.panel.destroy();
  }
});

test('401清除登录、403撤销面板权限，密码与确认快照全部清除且不能重试写入', async () => {
  for (const status of [401, 403]) {
    const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill(); h.next(async () => response(status, { error: '当前账户没有权限' }));
    assert.equal(await h.panel.save(), false); assert.equal(h.panel.busy, false); assert.equal(h.panel.loaded, false);
    assert.equal(h.node('videoDevicePassword').value, ''); assert.equal(h.node('videoDeviceContent').hidden, true);
    assert.equal(await h.panel.read(), false); assert.equal(await h.panel.save(), false); assert.equal(h.calls.length, 2);
    if (status === 401) assert.equal(h.auth.expirations, 1); else assert.equal(h.panel.denied, true); h.panel.destroy();
  }
});

test('公开快照只存设备ID和用户名，拒绝错误设备、重复视频账号和缺失能力列表', async () => {
  const h = setup(); h.next(async () => response(200, { ...snapshot(), devices: devices().map(d => ({ ...d, password: 'do-not-store' })), videos: videos().map(v => ({ ...v, hash: 'do-not-store' })) }));
  assert.equal(await h.panel.open(), true); assert.deepEqual(h.panel.devices, devices()); assert.deepEqual(h.panel.videos, videos());
  for (const data of [
    { ...snapshot(), revision: 'invalid' }, { ...snapshot(), videos: undefined },
    { ...snapshot(), devices: [{ deviceId: '<script>', username: 'boat-01' }] },
    { ...snapshot(), videos: [{ deviceId: 'unknown', username: 'camera-one' }] },
    { ...snapshot(), videos: [{ deviceId: 'boat-01', username: 'boat-01' }] },
    { ...snapshot(), videos: [{ deviceId: 'boat-01', username: 'camera-one' }, { deviceId: 'boat-01', username: 'camera-two' }] }
  ]) {
    h.next(async () => response(200, data)); assert.equal(await h.panel.read(), false);
    assert.equal(h.panel.loaded, false); assert.equal(h.node('videoDeviceList').children.length, 0); assert.equal(h.panel.busy, false);
  }
  h.panel.destroy();
});
