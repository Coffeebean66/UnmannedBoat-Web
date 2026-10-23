const test = require('node:test');
const assert = require('node:assert/strict');
const { BoatMapSettingsPanel, validateMapCredentials } = require('../public/map-settings');

const key = 'a'.repeat(32), code = 'b'.repeat(32);
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const settings = (source = 'environment') => ({ configured: true, source, key, securityJsCode: code });

function setup({ role = 'admin', enabled = true, ready = true } = {}) {
  const nodes = new Map(), calls = [], timers = new Map();
  let sequence = 0, reloaded = 0, next;
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map();
    const value = { id, value: '', hidden: false, disabled: false, dataset: {}, attributes: {}, textContent: '', open: false,
      setAttribute(name, val) { this.attributes[name] = val; },
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
      emit(name) { return listeners.get(name)?.({ preventDefault() {}, target: this }); } };
    nodes.set(id, value);
    return value;
  }
  class Auth extends EventTarget {
    constructor() {
      super(); this.ready = ready; this.enabled = enabled; this.generation = 1;
      this.user = role ? { username: role + '-test', role } : null;
      this.verifications = 0; this.initializations = 0;
    }
    async verifyManage() { this.verifications++; if (this.verify) await this.verify(); }
    initialize() { this.initializations++; return Promise.resolve(); }
    expire() { this.change({ role: null }); }
    change(values) {
      if ('enabled' in values) this.enabled = values.enabled;
      if ('ready' in values) this.ready = values.ready;
      if ('role' in values) this.user = values.role ? { username: values.username || values.role + '-test', role: values.role } : null;
      this.generation++;
      this.dispatchEvent(new Event('change'));
    }
    notify() { this.dispatchEvent(new Event('change')); }
  }
  const auth = new Auth();
  const panel = new BoatMapSettingsPanel({
    document: { getElementById: node }, auth, AbortController,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (next) return next(url, options);
      if (options.method === 'GET') return response(200, settings());
      const data = JSON.parse(options.body);
      return response(200, { ...data, configured: !!data.key, source: 'saved' });
    },
    setTimeout(fn, duration) { const id = ++sequence; timers.set(id, { fn, duration }); return id; },
    clearTimeout(id) { timers.delete(id); },
    reload() { reloaded++; }
  });
  return { panel, auth, node, calls, timers,
    next(fn) { next = fn; },
    edit(nextKey, nextCode) {
      node('amapKey').value = nextKey;
      node('amapSecurityCode').value = nextCode;
      node('amapKey').emit('input');
    },
    timeout() {
      const [id, timer] = [...timers][0] || [];
      assert.ok(timer, 'request has a timeout');
      timers.delete(id); timer.fn();
    },
    get reloaded() { return reloaded; }
  };
}

async function until(predicate) {
  for (let i = 0; i < 30; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.fail('expected asynchronous request phase');
}

test('地图凭据只接受成对32hex或双空；空格会修剪，错误不含用户凭据', () => {
  assert.deepEqual(validateMapCredentials(' ' + key + ' ', code), { key, securityJsCode: code });
  assert.deepEqual(validateMapCredentials('', '  '), { key: '', securityJsCode: '' });
  assert.throws(() => validateMapCredentials(key, ''), /一起填写/);
  assert.throws(() => validateMapCredentials('', code), /一起填写/);
  for (const invalid of ['x'.repeat(32), 'short', 'a'.repeat(33), '<script>secret']) {
    assert.throws(() => validateMapCredentials(invalid, code), error => /32 位/.test(error.message) && !error.message.includes(invalid));
  }
});

test('只有已启用账户的管理员可读取或保存，legacy说明环境配置仍可用', async () => {
  for (const options of [{ role: 'guest' }, { role: null }, { ready: false }, { enabled: false, role: null }]) {
    const h = setup(options);
    assert.equal(await h.panel.open(), false);
    assert.equal(await h.panel.read(), false);
    h.edit(key, code);
    assert.equal(await h.panel.save(), false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.auth.verifications, 0);
    assert.equal(h.node('amapKey').disabled, true);
    assert.equal(h.node('mapSettingsForm').hidden, true);
    if (options.enabled === false) {
      assert.equal(h.node('mapSettings').hidden, false);
      assert.match(h.node('mapSettingsAccess').textContent, /环境变量配置仍然可用/);
    } else assert.equal(h.node('mapSettings').hidden, true);
    h.panel.destroy();
  }
});

test('管理员无需设备连接读取配置，重复打开及普通账户轮询不覆盖草稿', async () => {
  const h = setup();
  assert.equal(h.node('mapSettings').hidden, false);
  assert.equal(h.node('mapSettingsSave').disabled, true);
  assert.equal(await h.panel.open(), true);
  assert.equal(h.node('amapKey').value, key);
  assert.equal(h.node('amapSecurityCode').value, code);
  assert.match(h.node('mapSettingsSource').textContent, /环境变量/);
  assert.equal(h.node('mapSettingsSave').disabled, false);
  assert.equal(h.auth.verifications, 1);
  assert.equal(h.calls[0].url, '/api/map/settings');
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(h.calls[0].credentials, 'same-origin');
  assert.equal(h.calls[0].cache, 'no-store');
  assert.equal(h.calls[0].redirect, 'error');
  assert.equal(h.calls[0].body, undefined);
  h.edit('c'.repeat(32), 'd'.repeat(32));
  h.auth.notify();
  await h.panel.open();
  assert.equal(h.node('amapKey').value, 'c'.repeat(32));
  assert.equal(h.calls.length, 1);
  await h.panel.read();
  assert.equal(h.node('amapKey').value, key, 'explicit reread replaces the draft');
  assert.equal(h.panel.dirty, false);
  assert.equal(h.timers.size, 0);
  h.panel.destroy();
});

test('保存只调用平台设置接口，成功提供刷新按钮但不会自动刷新', async () => {
  const h = setup();
  await h.panel.open();
  h.edit('c'.repeat(32), 'd'.repeat(32));
  assert.equal(await h.panel.save(), true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].method, 'PUT');
  assert.deepEqual(JSON.parse(h.calls[1].body), { key: 'c'.repeat(32), securityJsCode: 'd'.repeat(32) });
  assert.equal(h.calls[1].headers['Content-Type'], 'application/json');
  assert.equal(h.auth.verifications, 2);
  assert.equal(h.node('mapSettingsStatus').dataset.tone, 'success');
  assert.match(h.node('mapSettingsStatus').textContent, /刷新页面应用/);
  assert.match(h.node('mapSettingsSource').textContent, /服务器保存/);
  assert.equal(h.node('mapSettingsReload').hidden, false);
  assert.equal(h.node('mapSettingsRefreshNote').hidden, false);
  assert.equal(h.reloaded, 0);
  h.edit(key, code);
  assert.match(h.node('mapSettingsStatus').textContent, /未保存/);
  h.node('mapSettingsReload').emit('click');
  assert.equal(h.reloaded, 1);
  assert.equal(h.calls.every(call => call.url === '/api/map/settings'), true, 'no device parameter command is sent');
  h.panel.destroy();
});

test('双空保存停用高德，单空和格式错误不发请求也不丢输入', async () => {
  const h = setup();
  await h.panel.open();
  for (const pair of [[key, ''], ['', code], ['invalid', code]]) {
    h.edit(...pair);
    assert.equal(await h.panel.save(), false);
    assert.equal(h.node('mapSettingsStatus').dataset.tone, 'error');
    assert.equal(h.calls.length, 1);
    assert.equal(h.node('amapKey').value, pair[0]);
  }
  h.edit('', '');
  assert.equal(await h.panel.save(), true);
  assert.deepEqual(JSON.parse(h.calls[1].body), { key: '', securityJsCode: '' });
  assert.match(h.node('mapSettingsStatus').textContent, /停用.*OpenStreetMap/);
  assert.equal(h.node('mapSettingsReload').hidden, false);
  h.panel.destroy();
});

test('读取和写入失败分别展示错误，写入失败保留草稿且不提示成功', async () => {
  const h = setup();
  h.next(async () => response(503, { error: '配置服务暂不可用' }));
  assert.equal(await h.panel.open(), false);
  assert.equal(h.node('mapSettingsStatus').dataset.tone, 'error');
  assert.match(h.node('mapSettingsStatus').textContent, /暂不可用/);
  assert.equal(h.node('mapSettingsSave').disabled, true);
  h.next(null);
  await h.panel.read();
  h.edit('c'.repeat(32), 'd'.repeat(32));
  h.next(async () => response(503, { error: '无法写入服务器配置文件' }));
  assert.equal(await h.panel.save(), false);
  assert.equal(h.node('amapKey').value, 'c'.repeat(32));
  assert.equal(h.node('amapSecurityCode').value, 'd'.repeat(32));
  assert.equal(h.node('mapSettingsStatus').dataset.tone, 'error');
  assert.match(h.node('mapSettingsStatus').textContent, /无法写入/);
  assert.equal(h.node('mapSettingsReload').hidden, true);
  assert.equal(h.reloaded, 0);
  h.panel.destroy();
});

test('401过期和403降权均清除凭据，禁止继续保存', async () => {
  for (const status of [401, 403]) {
    const h = setup();
    await h.panel.open();
    h.next(async () => response(status, { error: '管理员权限已失效' }));
    assert.equal(await h.panel.save(), false);
    assert.equal(h.node('amapKey').value, '');
    assert.equal(h.node('amapSecurityCode').value, '');
    assert.equal(h.node('mapSettingsSave').disabled, true);
    assert.equal(h.node('mapSettingsReload').hidden, true);
    assert.equal(h.panel.busy, false);
    assert.equal(await h.panel.save(), false);
    if (status === 401) assert.equal(h.auth.user, null);
    else assert.equal(h.auth.initializations, 1);
    h.panel.destroy();
  }
});

test('退出或切换管理员时取消迟到请求，旧响应不能恢复凭据/忙状态', async () => {
  const h = setup();
  let resolveOld;
  h.next(() => new Promise(resolve => { resolveOld = resolve; }));
  const pending = h.panel.open();
  await until(() => !!resolveOld);
  const oldSignal = h.calls[0].signal;
  h.auth.change({ role: null });
  assert.equal(h.node('amapKey').value, '');
  assert.equal(oldSignal.aborted, true);
  assert.equal(await pending, false);
  assert.equal(h.node('mapSettings').hidden, true);
  h.auth.change({ role: 'admin', username: 'second-admin' });
  h.next(async () => response(200, { ...settings('saved'), key: 'c'.repeat(32), securityJsCode: 'd'.repeat(32) }));
  assert.equal(await h.panel.open(), true);
  resolveOld(response(200, settings()));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.node('amapKey').value, 'c'.repeat(32));
  assert.equal(h.node('mapSettingsStatus').dataset.tone, 'neutral');
  assert.equal(h.panel.busy, false);
  assert.equal(h.timers.size, 0);
  h.panel.destroy();
});

test('在权限验证期间退出或超时，不再发出地图设置请求', async () => {
  for (const mode of ['logout', 'timeout']) {
    const h = setup();
    let finishVerify;
    h.auth.verify = () => new Promise(resolve => { finishVerify = resolve; });
    const pending = h.panel.open();
    await until(() => !!finishVerify);
    if (mode === 'logout') h.auth.change({ role: 'guest' });
    else h.timeout();
    assert.equal(await pending, false);
    finishVerify();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.calls.length, 0);
    assert.equal(h.panel.busy, false);
    if (mode === 'timeout') assert.match(h.node('mapSettingsStatus').textContent, /超时/);
    h.panel.destroy();
  }
});

test('超时或pagehide销毁清理请求；忽略fetch abort的迟到返回也不能更新页面', async () => {
  for (const mode of ['timeout', 'destroy']) {
    const h = setup();
    await h.panel.open();
    h.edit('c'.repeat(32), 'd'.repeat(32));
    let respond;
    h.next(() => new Promise(resolve => { respond = resolve; }));
    const pending = h.panel.save();
    await until(() => !!respond);
    if (mode === 'timeout') h.timeout(); else h.panel.destroy();
    assert.equal(await pending, false);
    assert.equal(h.calls.at(-1).signal.aborted, true);
    respond(response(200, { ...settings('saved'), key: 'c'.repeat(32) }));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.node('mapSettingsReload').hidden, true);
    assert.notEqual(h.node('mapSettingsStatus').dataset.tone, 'success');
    assert.equal(h.panel.busy, false);
    assert.equal(h.timers.size, 0);
    if (mode === 'destroy') assert.equal(h.node('amapKey').value, '');
    else assert.equal(h.node('amapKey').value, 'c'.repeat(32), 'an uncertain write retains its unsaved draft');
    h.panel.destroy();
  }
});
