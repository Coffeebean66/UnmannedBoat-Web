/* 更新界面状态机测试：不连接生产 GitHub、不执行部署或重启。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/update-panel.js'), 'utf8');
const OLD = '1'.repeat(40), NEXT = '2'.repeat(40), KEY = 'boat_web_update_ticket_v1';

function setup(options = {}) {
  let time = 1000000, sequence = 0, authorized = false, enabled = true, statusErrors = [];
  let current = { version: '1.4.0', commit: OLD, instanceId: 'old-instance' }, job = null, startHook;
  const storage = options.storage || new Map(), timers = new Map(), calls = [], changes = [];
  const store = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const fetch = async (url, request) => {
    calls.push({ url, ...request });
    const route = url.split('/').pop();
    if (route === 'config') return response(200, { enabled, requiresLogin: true, apiVersion: 1 });
    if (route === 'login') {
      authorized = JSON.parse(request.body).password === 'independent-admin-test';
      return response(authorized ? 200 : 401, { error: '更新管理密码错误' });
    }
    if (route === 'session') { authorized = false; return response(200, { ok: true }); }
    if (route === 'status' && statusErrors.length) {
      const code = statusErrors.shift();
      if (code === 0) throw Error('network');
      return response(code, { error: '暂时不可用' });
    }
    const ticket = request.headers['X-Boat-Update-Ticket'];
    if (!authorized && !(route === 'status' && ticket === 'read-only-task-ticket')) return response(401, { error: '需要更新管理员登录' });
    if (route === 'status') return response(200, { current, repository: { url: 'https://github.com/Coffeebean66/UnmannedBoat-Web', branch: 'main' }, job });
    if (route === 'check') return response(200, { latestCommit: NEXT, available: current.commit !== NEXT });
    if (route === 'start') {
      if (startHook) await startHook();
      job = { id: 'test-job', status: 'queued', phase: 'queued', expectedCommit: NEXT, message: '等待后台更新' };
      return response(202, { job, ticket: 'read-only-task-ticket' });
    }
    throw Error('Unexpected request: ' + url);
  };
  const context = { window: {}, setTimeout, clearTimeout, Date };
  vm.runInNewContext(source, context);
  const controller = new context.window.BoatUpdateController({ fetch, storage: store, now: () => time,
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), onChange: state => changes.push({ ...state }) });
  return { controller, calls, changes, storage, timers,
    advance: ms => { time += ms; }, setEnabled: value => { enabled = value; },
    setAuthorized: value => { authorized = value; },
    status: (status, commit = OLD, extra = {}) => { current = { ...current, commit }; job = { id: 'test-job', expectedCommit: NEXT, targetCommit: NEXT, status, phase: status, ...extra }; },
    failStatus: codes => { statusErrors = [...codes]; }, startHook: fn => { startHook = fn; },
    tick: async () => { const entry = [...timers.entries()].find(([, timer]) => timer.delay <= 2500); if (entry) { timers.delete(entry[0]); await entry[1].fn(); await new Promise(resolve => setImmediate(resolve)); } },
    login: async () => { await controller.open(); await controller.login('independent-admin-test'); } };
}

test('未启用时明确提示一次安装，重新检测可以恢复，不伪造更新成功', async () => {
  const h = setup(); h.setEnabled(false); await h.controller.open();
  assert.equal(h.controller.state.enabled, false); assert.match(h.controller.state.notice, /安装|启用/);
  await h.controller.start(); assert.equal(h.calls.length, 1);
  h.setEnabled(true); await h.controller.check();
  assert.equal(h.controller.state.enabled, true); assert.equal(h.controller.state.authenticated, false);
});

test('服务器无更新 API 时说明需要安装，不把 HTML 404 当配置成功', async () => {
  const h = setup(); h.controller.fetch = async () => ({ ok: false, status: 404, json: async () => { throw Error('HTML'); } });
  await h.controller.open(); assert.equal(h.controller.state.enabled, false); assert.match(h.controller.state.notice, /尚未安装/);
});

test('更新管理员登录独立，错误密码不被保存、不请求云端接口', async () => {
  const h = setup(); await h.controller.open(); await h.controller.login('cloud-viewer-password');
  assert.equal(h.controller.state.authenticated, false); assert.match(h.controller.state.notice, /密码错误/);
  assert.equal(h.storage.size, 0); assert.ok(h.calls.every(call => call.url.startsWith('/api/update/')));
});

test('登录自动检查 main，新提交检查必须 POST JSON 空对象', async () => {
  const h = setup(); await h.login();
  assert.equal(h.controller.state.authenticated, true); assert.equal(h.controller.state.available, true);
  assert.equal(h.controller.state.current.commit, OLD); assert.equal(h.controller.state.latestCommit, NEXT);
  const call = h.calls.find(call => call.url.endsWith('/check'));
  assert.equal(call.method, 'POST'); assert.equal(call.body, '{}');
  assert.equal(h.storage.size, 0); assert.ok(!JSON.stringify(h.controller.state).includes('independent-admin-test'));
});

test('并发点击仅创建一个精确候选提交任务，运行中不能再次检查或启动', async () => {
  const h = setup(); await h.login(); let finish;
  h.startHook(() => new Promise(resolve => { finish = resolve; }));
  const first = h.controller.start(); await h.controller.start(); finish(); await first;
  assert.equal(h.calls.filter(call => call.url.endsWith('/start')).length, 1);
  const call = h.calls.find(call => call.url.endsWith('/start'));
  assert.deepEqual(JSON.parse(call.body), { expectedCommit: NEXT });
  assert.equal(h.controller.state.waiting, true);
  const count = h.calls.length; await h.controller.start(); await h.controller.check(); assert.equal(h.calls.length, count);
  const record = JSON.parse(h.storage.get(KEY));
  assert.equal(record.ticket, 'read-only-task-ticket'); assert.ok(!JSON.stringify(record).includes('independent-admin-test'));
});

test('502/503/临时404与重启网络错误保留票据并自动重连', async () => {
  const h = setup(); await h.login(); await h.controller.start(); h.setAuthorized(false);
  h.failStatus([502, 503, 404, 0]);
  for (let i = 0; i < 4; i++) { await h.controller.poll(); assert.ok(h.controller.pending); assert.match(h.controller.state.notice, /重启|重连/); }
  const reads = h.calls.filter(call => call.url.endsWith('/status')).slice(-4);
  assert.ok(reads.every(call => call.headers['X-Boat-Update-Ticket'] === 'read-only-task-ticket'));
});

test('worker报告成功但旧实例仍在服务时不显示成功；提交一致才完成并清票据', async () => {
  const h = setup(); await h.login(); await h.controller.start();
  h.status('succeeded'); await h.controller.poll();
  assert.equal(h.controller.state.completed, false); assert.ok(h.controller.pending); assert.equal(h.controller.state.needsRefresh, false);
  h.status('succeeded', NEXT); await h.controller.poll();
  assert.equal(h.controller.state.completed, true); assert.equal(h.controller.state.needsRefresh, true);
  assert.equal(h.controller.pending, null); assert.equal(h.storage.has(KEY), false); assert.match(h.controller.state.notice, /更新成功/);
});

test('仅当前提交一致、worker仍在running时不显示更新完成', async () => {
  const h = setup(); await h.login(); await h.controller.start(); h.status('running', NEXT); await h.controller.poll();
  assert.equal(h.controller.state.completed, false); assert.ok(h.controller.pending);
});

test('任务id或目标提交不匹配不能伪装已完成', async () => {
  const h = setup(); await h.login(); await h.controller.start();
  h.status('succeeded', NEXT, { id: 'other-job' }); await h.controller.poll(); assert.ok(h.controller.pending);
  h.status('succeeded', OLD, { targetCommit: OLD }); await h.controller.poll(); assert.equal(h.controller.state.completed, false);
});

test('回滚或失败显示原因、停止轮询，管理员可重新检查后重试', async () => {
  for (const status of ['failed', 'rolled_back']) {
    const h = setup(); await h.login(); await h.controller.start();
    h.status(status, OLD, { message: '新版本健康检查未通过' }); await h.controller.poll();
    assert.equal(h.controller.pending, null); assert.equal(h.controller.state.completed, false);
    assert.equal(h.controller.state.tone, 'error'); assert.match(h.controller.state.notice, /健康检查/);
    assert.equal(h.storage.has(KEY), false); await h.controller.check(); assert.equal(h.controller.state.available, true);
  }
});

test('10分钟等待超时不取消服务器任务，清票据并提示重新登录避免重复启动', async () => {
  const h = setup(); await h.login(); await h.controller.start(); const count = h.calls.length;
  h.advance(600001); await h.controller.poll();
  assert.equal(h.controller.pending, null); assert.equal(h.controller.state.authenticated, false);
  assert.equal(h.calls.length, count); assert.match(h.controller.state.notice, /不会因此取消/); assert.match(h.controller.state.notice, /勿重复/);
});

test('页面刷新仅恢复任务只读票据，跨重启无需恢复管理员密码', async () => {
  const original = setup(); await original.login(); await original.controller.start();
  const h = setup({ storage: original.storage }); h.status('running');
  assert.ok(h.controller.pending); assert.equal(h.controller.state.authenticated, false);
  await h.controller.open();
  assert.equal(h.controller.state.authenticated, false); assert.ok(h.controller.pending);
  assert.ok(h.calls.some(call => call.headers['X-Boat-Update-Ticket'] === 'read-only-task-ticket'));
  assert.ok(!h.calls.some(call => call.url.endsWith('/login') || call.url.endsWith('/check')));
});

test('过期、无效及不可信的本地票据不恢复', () => {
  for (const record of [{ ticket: 'x' }, { ticket: 'x', id: 'job', expectedCommit: NEXT, deadline: 100, expiresAt: 100 },
    { ticket: 'x', id: 'job', expectedCommit: NEXT, deadline: 100000000, expiresAt: 100000000 }]) {
    const h = setup({ storage: new Map([[KEY, JSON.stringify(record)]]) });
    assert.equal(h.controller.pending, null); assert.equal(h.storage.has(KEY), false);
  }
});

test('浏览器禁止访问sessionStorage时仍可构造管理器', () => {
  const context = { window: { fetch() {} }, Date, setTimeout, clearTimeout };
  Object.defineProperty(context.window, 'sessionStorage', { get() { throw Error('security'); } });
  vm.runInNewContext(source, context); assert.doesNotThrow(() => new context.window.BoatUpdateController());
});

test('票据被服务器拒绝需要重新登录，运行时管理员退出不能中断后台任务', async () => {
  const h = setup(); await h.login(); await h.controller.start();
  const count = h.calls.length; await h.controller.logout(); assert.equal(h.calls.length, count);
  h.failStatus([403]); await h.controller.poll();
  assert.equal(h.controller.pending, null); assert.equal(h.controller.state.authenticated, false); assert.match(h.controller.state.notice, /重新登录/);
});

test('管理员退出只删除独立更新session，不清主题/蓝牙/参数数据', async () => {
  const h = setup(); await h.login(); h.storage.set('boat_web_theme_v1', 'light');
  await h.controller.logout(); assert.equal(h.controller.state.authenticated, false);
  assert.equal(h.storage.get('boat_web_theme_v1'), 'light');
  assert.equal(h.calls.at(-1).url, '/api/update/session'); assert.equal(h.calls.at(-1).method, 'DELETE');
});

test('页面绑定独立入口、非云端密码字段和固定仓库说明', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  for (const id of ['updateToggle', 'updateDialog', 'updateLoginForm', 'updatePassword', 'updateCheck', 'updateStart', 'updateRefresh']) assert.ok(html.includes('id="' + id + '"'));
  assert.match(html, /本地修改须先提交并推送/); assert.match(html, /update-panel\.js/);
  assert.ok(!source.includes('localStorage')); assert.ok(!source.includes('cloudPassword'));
});
