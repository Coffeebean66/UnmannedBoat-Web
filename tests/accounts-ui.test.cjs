const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const protocol = require('../public/utils/uart4Protocol');
const root = path.resolve(__dirname, '..');

function setup() {
  let enabled = true, user = null, unavailable = false, blockConfig, blockParameters;
  const calls = [], streams = [];
  const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url === '/api/auth/config') {
      const snapshot = user;
      if (blockConfig) await blockConfig();
      return unavailable ? response(503, {}) : response(200, { enabled, requiresLogin: enabled, user: snapshot });
    }
    if (url === '/api/auth/login') {
      const credentials = JSON.parse(options.body);
      if (credentials.username === 'operator' && credentials.password === 'admin-test-secret') user = { username: 'operator', role: 'admin' };
      else if (credentials.username === 'observer' && credentials.password === 'guest-test-secret') user = { username: 'observer', role: 'guest' };
      else return response(401, { error: '账户或密码错误' });
      return response(200, { ok: true, user });
    }
    if (url === '/api/auth/session') { user = null; return response(200, { ok: true }); }
    if (url === '/api/cloud/config') return response(200, { enabled: true, requiresLogin: true });
    if (url === '/api/cloud/devices') return user ? response(200, { devices: [{ id: 'boat-1', online: true, parametersReady: true }], brokerConnected: true }) : response(401, { error: '需要登录' });
    if (url === '/api/cloud/parameters') {
      if (blockParameters) await blockParameters();
      const bytes = protocol.encodeParameterReadRequest(1); bytes[3] = 0x90;
      new DataView(bytes.buffer).setUint16(54, protocol.crc16CcittFalse(bytes, 2, 52), true);
      return response(200, { frame: Buffer.from(bytes).toString('base64') });
    }
    if (url.startsWith('/api/cloud/login') || url.startsWith('/api/update/login')) assert.fail('账户模式不能请求旧密码入口');
    if (url === '/api/update/config') return response(200, { enabled: true, requiresLogin: true, apiVersion: 1 });
    if (url === '/api/update/status') return response(200, { current: { version: '1.5.0', commit: '1'.repeat(40) }, job: null });
    if (url === '/api/update/check') return response(200, { latestCommit: '2'.repeat(40), available: true });
    throw Error('Unexpected URL: ' + url);
  };
  class FakeStream extends EventTarget { constructor(url) { super(); this.url = url; streams.push(this); } close() { this.closed = true; } }
  const context = { window: { fetch }, fetch, EventTarget, CustomEvent, Date, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {}, BoatModules: { uart4Protocol: protocol },
    document: { hidden: false }, performance, EventSource: FakeStream, atob, Uint8Array, navigator: {} };
  const load = file => vm.runInNewContext(fs.readFileSync(path.join(root, 'public', file), 'utf8'), context);
  // 类单独导出测试时不建立真实页面。
  delete context.document; load('account-auth.js');
  context.document = { hidden: false, getElementById: () => null }; const auth = context.window.BoatAuth = new context.window.BoatAccountAuth({ fetch });
  load('cloud-transport.js');
  return { context, auth, calls, streams,
    load, enabled: value => { enabled = value; }, unavailable: value => { unavailable = value; },
    revoke: () => { user = null; }, blockConfig: fn => { blockConfig = fn; }, blockParameters: fn => { blockParameters = fn; },
    loginAdmin: async () => { await auth.initialize(); await auth.login('operator', 'admin-test-secret'); },
    loginGuest: async () => { await auth.initialize(); await auth.login('observer', 'guest-test-secret'); } };
}
async function connected(h) {
  const link = new h.context.window.CloudBoatLink(); await link.initialize(); await link.connect('boat-1');
  link.live = true; return link;
}
const parameterCalls = h => h.calls.filter(call => call.url === '/api/cloud/parameters');

test('账户配置未确认和网络故障严格禁用权限，只有明确 enabled:false 才开放 legacy', async () => {
  const h = setup(); assert.equal(h.auth.canManage, false); assert.equal(h.auth.canMonitor, false);
  h.unavailable(true); await h.auth.initialize(); assert.equal(h.auth.ready, false); assert.equal(h.auth.canManage, false);
  h.unavailable(false); h.enabled(false); await h.auth.initialize(); assert.equal(h.auth.canManage, true); assert.equal(h.auth.canMonitor, true);
});

test('账户响应仅接受服务器返回的 admin/guest，密码不进入本地状态', async () => {
  const h = setup(); await h.loginGuest(); assert.equal(h.auth.canMonitor, true); assert.equal(h.auth.canManage, false);
  assert.equal(h.auth.user.username, 'observer'); assert.equal(JSON.stringify(h.auth.state()).includes('guest-test-secret'), false);
  h.auth.apply(true, { username: 'forged', role: 'owner' }); assert.equal(h.auth.canManage, false); assert.equal(h.auth.user, null);
});

test('访客可连接MQTT监测，直接请求 read/write/flash 均拒绝且不发送设备请求', async () => {
  const h = setup(); await h.loginGuest(); const link = await connected(h);
  assert.equal(link.connected, true); assert.equal(link.readOnly, true);
  for (const command of ['read', 'write', 'flash']) await assert.rejects(link.request(command, {}), /访客/);
  assert.equal(parameterCalls(h).length, 0);
});

test('每次设备参数请求前核对服务器会话；已过期管理员不能利用残留页面发送', async () => {
  const h = setup(); await h.loginAdmin(); const link = await connected(h);
  await link.request('read'); assert.equal(parameterCalls(h).length, 1);
  h.revoke(); await assert.rejects(link.request('write', {}), /账户|身份|连接/); assert.equal(parameterCalls(h).length, 1);
  assert.equal(h.auth.user, null); assert.equal(link.connected, false);
});

test('云端参数等待途中降权立即取消，迟到设备响应不能恢复管理员结果', async () => {
  const h = setup(); await h.loginAdmin(); const link = await connected(h); let release;
  h.blockParameters(() => new Promise(resolve => { release = resolve; }));
  const request = link.request('write', {}), rejection = assert.rejects(request, /账户|身份|连接/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(parameterCalls(h).length, 1);
  h.auth.apply(true, { username: 'observer', role: 'guest' }); await rejection;
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(link.pending, null); assert.equal(link.connected, false); assert.equal(link.readOnly, true);
  assert.equal(parameterCalls(h).length, 1);
});

test('统一退出先撤销本地权限并停止云端流，保留本地偏好不会保留管理员权限', async () => {
  const h = setup(); await h.loginAdmin(); const cloud = new h.context.window.CloudBoatLink();
  await cloud.initialize(); await cloud.connect('boat-1'); const stream = h.streams.at(-1);
  assert.ok(stream); await h.auth.logout();
  assert.equal(stream.closed, true); assert.equal(cloud.wanted, false); assert.equal(cloud.devices.length, 0);
  assert.equal(h.auth.canManage, false); assert.equal(h.auth.canMonitor, false);
});

test('统一 guest 会话可加载云端设备，旧 cloud.login 不会发送旧密码接口', async () => {
  const h = setup(); await h.loginGuest(); const cloud = new h.context.window.CloudBoatLink(); await cloud.initialize();
  assert.equal(cloud.authenticated, true); assert.equal(cloud.devices[0].id, 'boat-1');
  await assert.rejects(cloud.login('unused'), /统一账户/);
  assert.ok(!h.calls.some(call => call.url === '/api/cloud/login'));
});

test('切换管理员到访客会增加连接 generation、关闭旧流并保留访客监测能力', async () => {
  const h = setup(); await h.loginAdmin(); const link = await connected(h), stream = h.streams.at(-1);
  const before = link.generation; await h.auth.login('observer', 'guest-test-secret');
  assert.ok(link.generation > before); assert.equal(stream.closed, true); assert.equal(link.wanted, false);
  assert.equal(h.auth.canManage, false); assert.equal(h.auth.canMonitor, true);
  await link.initialize(); await link.connect('boat-1'); assert.equal(link.wanted, true); assert.equal(link.readOnly, true);
});

test('旧配置查询在管理员登录后迟到，不覆盖新的身份', async () => {
  const h = setup(); let release;
  h.blockConfig(() => new Promise(resolve => { release = resolve; }));
  const oldConfig = h.auth.initialize(); await h.auth.login('operator', 'admin-test-secret');
  release(); await oldConfig; assert.equal(h.auth.user.role, 'admin');
});

test('账户模式更新复用共享管理员session，访客不能查询或启动，旧update.login不发出', async () => {
  const h = setup(); await h.loginAdmin(); h.load('update-panel.js');
  const update = new h.context.window.BoatUpdateController({ fetch: h.context.fetch, storage: { getItem: () => null, removeItem() {}, setItem() {} } });
  await update.open(); assert.equal(update.state.authenticated, true); assert.equal(update.state.available, true);
  assert.ok(!h.calls.some(call => call.url === '/api/update/login'));
  await h.auth.login('observer', 'guest-test-secret'); const count = h.calls.length;
  assert.equal(update.state.available, false); assert.equal(update.state.authenticated, false);
  await update.open(); await update.start(); assert.equal(h.calls.length, count);
});

test('页面包括统一账户与角色说明，不将角色从URL或本地storage恢复', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'public/account-auth.js'), 'utf8');
  for (const id of ['accountControls', 'accountName', 'accountLoginDialog', 'accountUsername', 'accountPassword', 'accountLogout']) assert.ok(html.includes('id="' + id + '"'));
  assert.match(html, /data-account-state="pending"/);
  assert.ok(html.includes('v' + require('../package.json').version), '页面显示当前网页包版本');
  assert.ok(!source.includes('localStorage')); assert.ok(!source.includes('sessionStorage')); assert.ok(!source.includes('location.search'));
});
