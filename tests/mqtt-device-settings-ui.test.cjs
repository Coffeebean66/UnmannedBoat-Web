const test = require('node:test'), assert = require('node:assert/strict');
const { BoatMqttDeviceSettingsPanel, validateMqttDeviceForm } = require('../public/mqtt-device-settings');
const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64);
const devices = () => [{ deviceId: 'boat-01', username: 'boat-01' }, { deviceId: 'boat-02', username: 'vessel-two' }];
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function setup({ role = 'admin', enabled = true, ready = true } = {}) {
  const nodes = new Map(), calls = [], confirmations = [], timers = new Map(); let next, sequence = 0;
  class Node {
    constructor() { this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this.children = []; this.listeners = new Map(); this.attributes = {}; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    querySelectorAll(tag) { return this.children.flatMap(child => (child.tagName === tag ? [child] : []).concat(child.querySelectorAll(tag))); }
    focus() { this.focused = true; }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  class Auth extends EventTarget {
    constructor() { super(); this.enabled = enabled; this.ready = ready; this.generation = 1; this.user = role ? { username: role, role } : null; this.verifications = 0; this.expirations = 0; }
    async verifyManage() { this.verifications++; if (this.verify) await this.verify(); }
    notify() { this.dispatchEvent(new Event('change')); }
    change(role, username = role) { this.user = role ? { role, username } : null; this.generation++; this.notify(); }
    expire() { this.expirations++; this.change(null); }
    initialize() { return Promise.resolve(); }
    openLogin() { this.prompted = true; }
  }
  const auth = new Auth();
  const h = { confirmResult: true };
  const panel = new BoatMqttDeviceSettingsPanel({ document: { getElementById: node, createElement(tag) { const n = new Node(); n.tagName = tag; return n; } }, auth,
    AbortController, confirm(message) { confirmations.push(message); assert.equal(node('mqttDevicePassword').value, ''); return h.confirmResult; },
    fetch: async (url, options) => {
      calls.push({ url, ...options }); if (next) return next(url, options);
      if (options.method === 'GET') return response(200, { enabled: true, devices: devices(), revision });
      const input = JSON.parse(options.body);
      return response(200, { ok: true, requiresReconnect: true, devices: devices().map(d => d.deviceId === 'boat-01' ? { ...d, username: input.username } : d), revision: nextRevision });
    },
    setTimeout(fn, duration) { const id = ++sequence; timers.set(id, { fn, duration }); return id; }, clearTimeout(id) { timers.delete(id); }
  });
  return Object.assign(h, { panel, auth, calls, confirmations, timers, node, next(fn) { next = fn; },
    fill({ username = 'vessel-one', password = 'secret_123', confirmation = password } = {}) { node('mqttDeviceUsername').value = username; node('mqttDevicePassword').value = password; node('mqttDevicePasswordConfirm').value = confirmation; },
    timeout() { const [id, timer] = [...timers][0] || []; assert.ok(timer); timers.delete(id); timer.fn(); }
  });
}
async function until(predicate) { for (let i = 0; i < 40; i++) { if (predicate()) return; await Promise.resolve(); } assert.fail('asynchronous phase not reached'); }

test('设备表单允许独立改名和保留密码，限制合法用户名及ASCII密码并验证确认', () => {
  assert.deepEqual(validateMqttDeviceForm({ username: ' vessel-one ', password: '', confirmation: '' }), { username: 'vessel-one' });
  assert.deepEqual(validateMqttDeviceForm({ username: 'vessel_1', password: 'aB9!#%[]', confirmation: 'aB9!#%[]' }), { username: 'vessel_1', password: 'aB9!#%[]' });
  for (const username of ['', '<script>', 'with.dot', 'boat/+']) assert.throws(() => validateMqttDeviceForm({ username, password: '', confirmation: '' }));
  for (const password of ['short', 'a'.repeat(65), 'space 123', 'colon:123', '密码abc123', 'line\n1234']) assert.throws(() => validateMqttDeviceForm({ username: 'boat-01', password, confirmation: password }));
  assert.throws(() => validateMqttDeviceForm({ username: 'boat-01', password: 'abcdefgh', confirmation: 'abcdefgi' }), /不一致/);
});

test('入口严格仅平台管理员可用，游客、未登录、legacy和未知配置不发请求', async () => {
  for (const options of [{ role: 'guest' }, { role: null }, { role: 'admin', enabled: false }, { ready: false }]) {
    const h = setup(options); assert.equal(await h.panel.open(), false); assert.equal(await h.panel.read(), false);
    assert.equal(h.panel.edit('boat-01'), false); h.fill(); assert.equal(await h.panel.save(), false);
    assert.equal(h.calls.length, 0); assert.equal(h.node('mqttDeviceSettings').hidden, true); h.panel.destroy();
  }
});

test('管理员读取所有已配置设备，只保存公开字段，设备ID只读且轮询不覆盖草稿', async () => {
  const h = setup(); h.next(async () => response(200, { enabled: true, revision, devices: devices().map(d => ({ ...d, password: 'must-not-store' })) }));
  assert.equal(await h.panel.open(), true); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/api/mqtt/devices');
  assert.equal(h.calls[0].credentials, 'same-origin'); assert.equal(h.calls[0].cache, 'no-store'); assert.equal(h.calls[0].redirect, 'error');
  assert.deepEqual(h.panel.devices, devices()); assert.equal(h.node('mqttDeviceList').children.length, 2); assert.equal(h.node('mqttDeviceId').readOnly, true);
  h.panel.edit('boat-01'); h.fill({ username: 'draft', password: '' }); h.auth.notify(); assert.equal(await h.panel.open(), false);
  assert.equal(h.node('mqttDeviceUsername').value, 'draft'); assert.equal(h.calls.length, 1); h.panel.destroy();
});

test('未安装组件明确提示一次启用，不能编辑或保存且可重新读取', async () => {
  const h = setup(); h.next(async () => response(200, { enabled: false, reason: 'helper missing' }));
  assert.equal(await h.panel.open(), true); assert.equal(h.panel.available, false); assert.equal(h.panel.edit('boat-01'), false);
  assert.equal(h.node('mqttDeviceSave').disabled, true); assert.match(h.node('mqttDeviceStatus').textContent, /README.*启用一次/);
  assert.equal(h.node('mqttDeviceRead').disabled, false); h.panel.destroy();
});

test('修改需明确确认设备和重连影响，提交单次并立即清空密码、更新版本', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill();
  const saving = h.panel.save(); assert.equal(h.node('mqttDevicePassword').value, ''); assert.equal(h.node('mqttDevicePasswordConfirm').value, '');
  assert.equal(await h.panel.save(), false); assert.equal(await saving, true);
  assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0], /boat-01.*vessel-one|boat-01[\s\S]*vessel-one/);
  assert.match(h.confirmations[0], /所有设备.*短暂重连/); assert.match(h.confirmations[0], /STM32/); assert.equal(h.confirmations[0].includes('secret_123'), false);
  assert.deepEqual(h.calls.map(c => c.method), ['GET', 'PATCH']); assert.equal(h.calls[1].url, '/api/mqtt/devices/boat-01');
  assert.deepEqual(JSON.parse(h.calls[1].body), { username: 'vessel-one', password: 'secret_123', revision });
  assert.equal(h.panel.revision, nextRevision); assert.equal(h.panel.devices[0].username, 'vessel-one'); assert.equal(h.node('mqttDeviceForm').hidden, true);
  assert.equal(h.node('mqttDeviceStatus').dataset.tone, 'success'); assert.match(h.node('mqttDeviceStatus').textContent, /STM32.*重新烧录/); h.panel.destroy();
});

test('只改账号不发送空密码，未修改或取消确认不触发保存', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill({ username: 'boat-01', password: '' });
  assert.equal(await h.panel.save(), false); assert.equal(h.confirmations.length, 0);
  h.fill(); h.confirmResult = false; assert.equal(await h.panel.save(), false); assert.equal(h.calls.length, 1); assert.equal(h.node('mqttDevicePassword').value, '');
  h.confirmResult = true; h.fill({ password: '' }); assert.equal(await h.panel.save(), true);
  assert.deepEqual(JSON.parse(h.calls[1].body), { username: 'vessel-one', revision }); h.panel.destroy();
});

test('密码校验失败、取消编辑、关闭窗口均清空密码，关闭后不能读取', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill({ confirmation: 'mismatch' });
  assert.equal(await h.panel.save(), false); assert.equal(h.calls.length, 1); assert.equal(h.node('mqttDevicePassword').value, '');
  h.fill(); h.panel.cancelEdit(); assert.equal(h.node('mqttDevicePassword').value, '');
  h.panel.edit('boat-01'); h.fill(); h.panel.close(); assert.equal(h.panel.devices.length, 0); assert.equal(h.panel.revision, '');
  assert.equal(h.node('mqttDevicePassword').value, ''); assert.equal(await h.panel.read(), false); h.panel.destroy();
});

test('退出或降权取消请求并丢弃迟到响应，密码不留在DOM', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill(); let resolve;
  h.next(() => new Promise(done => { resolve = done; })); const saving = h.panel.save(); await until(() => !!resolve);
  h.auth.change('guest'); assert.equal(await saving, false);
  resolve(response(200, { ok: true, requiresReconnect: true, devices: devices(), revision: nextRevision })); await Promise.resolve();
  assert.equal(h.panel.loaded, false); assert.equal(h.panel.devices.length, 0); assert.equal(h.node('mqttDeviceSettings').hidden, true);
  assert.equal(h.node('mqttDevicePassword').value, ''); assert.equal(h.timers.size, 0); h.panel.destroy();
});

test('提交前复核身份，复核期间退出不会发送写请求', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill(); let resolve;
  h.auth.verify = () => new Promise(done => { resolve = done; }); const saving = h.panel.save(); await until(() => !!resolve);
  h.auth.change(null); resolve(); assert.equal(await saving, false); assert.equal(h.calls.length, 1); assert.equal(h.node('mqttDevicePassword').value, ''); h.panel.destroy();
});

test('35秒保存超时不重试、忽略迟到成功，重新读取后才能再写', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill(); let resolve;
  h.next(() => new Promise(done => { resolve = done; })); const saving = h.panel.save(); await until(() => !!resolve);
  assert.equal([...h.timers.values()][0].duration, 35000); h.timeout(); assert.equal(await saving, false);
  assert.match(h.node('mqttDeviceStatus').textContent, /结果尚未确认.*重新读取/); assert.equal(h.panel.loaded, false);
  assert.equal(await h.panel.save(), false); assert.equal(h.calls.length, 2);
  resolve(response(200, { ok: true, requiresReconnect: true, devices: devices(), revision: nextRevision })); await Promise.resolve();
  assert.equal(h.panel.loaded, false); assert.equal(h.node('mqttDeviceSave').disabled, true); h.panel.destroy();
});

test('版本冲突或失效配置均要求重新读取，非法设备响应不能进入DOM', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill(); h.next(async () => response(409, { error: '配置已经变化，请重新读取' }));
  assert.equal(await h.panel.save(), false); assert.equal(h.panel.loaded, false); assert.match(h.node('mqttDeviceStatus').textContent, /重新读取/);
  for (const value of [
    { revision, devices: [{ deviceId: '<script>', username: 'boat-01' }] },
    { revision, devices: [{ deviceId: 'boat-01', username: 'boat-01' }, { deviceId: 'boat-01', username: 'duplicate' }] },
    { revision, devices: [{ deviceId: 123, username: 'boat-01' }] },
    { revision: 'invalid', devices: devices() }
  ]) { h.next(async () => response(200, value)); assert.equal(await h.panel.read(), false); assert.equal(h.node('mqttDeviceList').children.length, 0); }
  h.panel.destroy();
});

test('401清除登录，403撤销本页管理权限，均清空账号草稿和密码', async () => {
  for (const status of [401, 403]) {
    const h = setup(); await h.panel.open(); h.panel.edit('boat-01'); h.fill(); h.next(async () => response(status, { error: '当前账户没有权限' }));
    assert.equal(await h.panel.save(), false); assert.equal(h.panel.loaded, false); assert.equal(h.node('mqttDeviceContent').hidden, true);
    assert.equal(h.node('mqttDevicePassword').value, ''); assert.equal(await h.panel.read(), false); assert.equal(h.calls.length, 2);
    if (status === 401) assert.equal(h.auth.expirations, 1); h.panel.destroy();
  }
});

test('新版管理组件允许新增船，旧版明确提示升级并保持原修改账号能力',async()=>{
  const h=setup();await h.panel.open();assert.equal(h.panel.canCreate,false);assert.equal(h.panel.nodes.mqttDeviceAdd.disabled,true);assert.equal(h.panel.beginCreate(),false);assert.match(h.node('mqttDeviceStatus').textContent,/install-mqtt-device-admin/);
  assert.equal(h.panel.edit('boat-01'),true);assert.equal(h.node('mqttDeviceId').readOnly,true);h.panel.destroy();
});

test('新增无人船提交独立ID与必填密码，明确确认重连并在完成后清除输入',async()=>{
  const h=setup();h.next(async(url,options)=>options.method==='GET'?response(200,{enabled:true,devices:devices(),revision,canCreate:true}):response(200,{ok:true,requiresReconnect:true,devices:[...devices(),{deviceId:'boat-03',username:'vessel-three'}],revision:nextRevision,canCreate:true}));
  await h.panel.open();assert.equal(h.panel.nodes.mqttDeviceAdd.disabled,false);assert.equal(h.panel.beginCreate(),true);assert.equal(h.node('mqttDeviceId').readOnly,false);assert.equal(h.node('mqttDevicePassword').required,true);
  h.node('mqttDeviceId').value='boat-03';h.fill({username:'vessel-three'});assert.equal(await h.panel.save(),true);
  assert.deepEqual(JSON.parse(h.calls[1].body),{username:'vessel-three',password:'secret_123',deviceId:'boat-03',revision});assert.equal(h.calls[1].method,'POST');assert.equal(h.calls[1].url,'/api/mqtt/devices');
  assert.match(h.confirmations[0],/boat-03[\s\S]*所有设备[\s\S]*短暂重连/);assert.equal(h.confirmations[0].includes('secret_123'),false);
  assert.equal(h.node('mqttDevicePassword').value,'');assert.equal(h.node('mqttDeviceId').value,'');assert.equal(h.node('mqttDeviceForm').hidden,true);assert.match(h.node('mqttDeviceStatus').textContent,/BOAT_MQTT_DEVICE_ID/);h.panel.destroy();
});

test('新增船拒绝缺密码、重复ID或账号，不发送写请求，退出清理新增草稿',async()=>{
  const h=setup();h.next(async()=>response(200,{enabled:true,devices:devices(),revision,canCreate:true}));await h.panel.open();h.panel.beginCreate();
  h.node('mqttDeviceId').value='boat-03';h.fill({username:'vessel-three',password:''});assert.equal(await h.panel.save(),false);
  h.node('mqttDeviceId').value='boat-01';h.fill({username:'vessel-three'});assert.equal(await h.panel.save(),false);
  h.node('mqttDeviceId').value='boat-03';h.fill({username:'vessel-two'});assert.equal(await h.panel.save(),false);assert.equal(h.calls.length,1);assert.equal(h.confirmations.length,0);
  h.fill();h.auth.change('guest');assert.equal(h.node('mqttDevicePassword').value,'');assert.equal(h.node('mqttDeviceId').value,'');assert.equal(h.panel.creating,false);assert.equal(h.panel.nodes.mqttDeviceAdd.disabled,true);h.panel.destroy();
});
