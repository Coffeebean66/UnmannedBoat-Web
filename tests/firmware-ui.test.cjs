'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/firmware-panel.js'), 'utf8');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture({ enabled = true, supported = true, ready = true, online = true, role = 'admin' } = {}) {
  class Element extends EventTarget {
    constructor() { super(); this.dataset = {}; this.textContent = ''; this._value = ''; this.files = []; this.open = false; }
    set value(value) { this._value = value; if (value === '') this.files = []; }
    get value() { return this._value; }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; this.dispatchEvent(new Event('close')); } }
  }
  class Auth extends EventTarget {
    constructor() { super(); this.ready = true; this.enabled = true; this.generation = 1; this.user = { username: role, role }; }
    verifyManage() { this.dispatchEvent(new Event('change')); if (this.user?.role !== 'admin') throw Error('需要管理员'); }
    guest() { this.generation++; this.user = { username: 'guest', role: 'guest' }; this.dispatchEvent(new Event('change')); }
  }
  const nodes = {}, document = { getElementById(id) { return nodes[id] ||= new Element(); } }, calls = [], confirms = [], timers = new Map();
  let timerId = 0, handler = null;
  const config = { enabled, reason: enabled ? '' : '服务器未配置OTA密钥', maxSize: 655360, chunkSize: 256 };
  const snapshots = new Map();
  for (const id of ['boat-01', 'boat-02']) snapshots.set(id, { deviceId: id, supported, online, capability: supported ? { ready, state: 'idle' } : null, job: null });
  const auth = new Auth(), window = { document, BoatAuth: auth, AbortController,
    confirm: text => { confirms.push(text); return true; },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (handler) { const value = await handler(url, options); if (value) return value; }
      const value = url.endsWith('/config') ? config : snapshots.get(url.match(/boats\/([^/]+)/)?.[1]);
      return { ok: true, status: 200, json: async () => value };
    } };
  vm.runInNewContext(source, { window });
  const panel = new window.BoatFirmwarePanel();
  const select = (name = 'boat-ota.bin', size = 1024) => { nodes.firmwareFile.files = [{ name, size }]; nodes.firmwareFile.dispatchEvent(new Event('change')); };
  return { panel, nodes, auth, calls, timers, confirms, config, snapshots, select, set handler(value) { handler = value; } };
}
function job(id, state, extra = {}) { return { id: 'test', deviceId: id, name: 'boat-ota.bin', size: 1024, sha256: 'a'.repeat(64), state, receivedBytes: 512, progress: 50, error: null, cancelable: ['queued', 'transferring'].includes(state), ...extra }; }

test('管理员按船上传二进制，只在设备就绪且文件有效时允许升级', async () => {
  const f = fixture(); await f.panel.open('boat-02');
  assert.equal(f.nodes.firmwareDevice.textContent, 'boat-02'); assert.equal(f.nodes.firmwareStart.disabled, true);
  f.select('old.hex'); assert.equal(f.nodes.firmwareStart.disabled, true);
  f.select('small.bin', 200); assert.equal(f.nodes.firmwareStart.disabled, true);
  f.select('too-large.bin', 655361); assert.equal(f.nodes.firmwareStart.disabled, true);
  f.select('船固件.bin'); assert.equal(f.nodes.firmwareStart.disabled, false);
  f.handler = async (url, options) => {
    if (options.method === 'POST') return { ok: true, status: 202, json: async () => ({ ...f.snapshots.get('boat-02'), job: job('boat-02', 'queued') }) };
  };
  assert.equal(await f.panel.start(), true);
  const upload = f.calls.find(call => call.method === 'POST');
  assert.equal(upload.url, '/api/firmware/boats/boat-02'); assert.equal(upload.headers['Content-Type'], 'application/octet-stream');
  assert.equal(decodeURIComponent(upload.headers['X-Firmware-Name']), '船固件.bin'); assert.equal(upload.body.name, '船固件.bin');
  assert.match(f.confirms[0], /boat-02/); assert.equal(f.nodes.firmwareStart.disabled, true); assert.equal(f.nodes.firmwareCancel.hidden, false);
  assert.equal([...f.timers.values()].some(timer => timer.ms === 1000), true); f.panel.destroy(); assert.equal(f.timers.size, 0);
});

test('下载100%保持等待重启；只有服务器确认成功才显示升级完成，未知结果明确提示', async () => {
  const f = fixture(); await f.panel.open('boat-01');
  for (const state of ['transferring', 'verifying', 'installing', 'unknown', 'succeeded']) {
    f.snapshots.get('boat-01').job = job('boat-01', state, { progress: 100, receivedBytes: 1024, cancelable: false });
    await f.panel.refresh();
    assert.equal(f.nodes.firmwareProgress.value, 100);
    assert.equal(f.nodes.firmwarePhase.textContent === '升级完成', state === 'succeeded');
    if (state === 'unknown') assert.match(f.nodes.firmwareStatus.textContent, /不代表安装成功/);
    if (state === 'installing') assert.match(f.nodes.firmwareStatus.textContent, /等待单片机重启/);
  }
  f.panel.destroy();
});

test('关闭窗口不发取消命令，再打开可继续查看后台任务；取消命令固定发送给弹窗目标', async () => {
  const f = fixture(); f.snapshots.get('boat-01').job = job('boat-01', 'transferring');
  await f.panel.open('boat-01'); f.nodes.firmwareDialog.close();
  assert.equal(f.calls.some(call => call.method === 'POST'), false); assert.equal(f.timers.size, 0);
  await f.panel.open('boat-01'); assert.equal(f.nodes.firmwarePhase.textContent, '传输固件');
  f.handler = async (url, options) => {
    if (options.method === 'POST') return { ok: true, json: async () => ({ ...f.snapshots.get('boat-01'), job: job('boat-01', 'cancelled', { cancelable: false }) }) };
  };
  await f.panel.cancel(); assert.equal(f.calls.at(-1).url, '/api/firmware/boats/boat-01/cancel');
  assert.equal(f.nodes.firmwarePhase.textContent, '已取消'); f.panel.destroy();
});

test('旧固件、离线、未停稳、服务未启用和访客均不能上传', async () => {
  for (const options of [{ supported: false }, { online: false }, { ready: false }, { enabled: false }, { role: 'guest' }]) {
    const f = fixture(options); await f.panel.open('boat-01'); f.select();
    assert.equal(f.nodes.firmwareStart.disabled, true); assert.equal(await f.panel.start(), false);
    assert.equal(f.calls.some(call => call.method === 'POST'), false); f.panel.destroy();
  }
});

test('迟到的旧船请求或管理员退出不能恢复表单或更改目标船', async () => {
  const f = fixture(), delayed = defer();
  f.handler = (url) => url.endsWith('/boats/boat-01') ? delayed.promise : null;
  const first = f.panel.open('boat-01');
  await new Promise(resolve => setImmediate(resolve));
  await f.panel.open('boat-02');
  delayed.resolve({ ok: true, json: async () => f.snapshots.get('boat-01') }); await first;
  assert.equal(f.nodes.firmwareDevice.textContent, 'boat-02'); assert.equal(f.panel.snapshot.deviceId, 'boat-02');
  f.nodes.firmwareDialog.dispatchEvent(new Event('close'));
  assert.equal(f.panel.opened, true); assert.equal(f.panel.snapshot.deviceId, 'boat-02');
  f.select(); f.auth.guest(); assert.equal(f.nodes.firmwareDialog.open, false); assert.equal(f.nodes.firmwareStart.disabled, true);
  assert.equal(f.panel.snapshot, null); assert.equal(f.nodes.firmwareFile.files.length, 0); f.panel.destroy();
});

test('上传响应超时或失败不宣称升级成功，重新读取仍可恢复实际任务', async () => {
  const f = fixture(); await f.panel.open('boat-01'); f.select();
  f.handler = async (url, options) => options.method === 'POST' ? { ok: false, status: 409, json: async () => ({ error: '请确认停机条件' }) } : null;
  await f.panel.start(); assert.match(f.nodes.firmwareStatus.textContent, /停机条件/); assert.equal(f.nodes.firmwarePhase.textContent, '尚无升级任务');
  f.snapshots.get('boat-01').job = job('boat-01', 'installing', { progress: 100, cancelable: false });
  await f.panel.refresh(); assert.equal(f.nodes.firmwarePhase.textContent, '等待重启验证'); f.panel.destroy();
});
