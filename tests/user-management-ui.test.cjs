const test = require('node:test'), assert = require('node:assert/strict');
const { BoatUserManagementPanel, validateUserForm } = require('../public/user-management');
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const initialUsers = () => [{ id: 'u-admin', username: 'captain', role: 'admin' }, { id: 'u-guest', username: 'observer', role: 'guest' }];

function setup({ role = 'admin', enabled = true, ready = true } = {}) {
  const nodes = new Map(), calls = [], timers = new Map(), toasts = [];
  let next, sequence = 0, users = initialUsers();
  class Node {
    constructor(id = '') { this.id = id; this.value = ''; this.hidden = false; this.disabled = false; this.required = false; this.textContent = ''; this.dataset = {}; this.attributes = {}; this.children = []; this.listeners = new Map(); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    emit(name) { return this.listeners.get(name)?.({ preventDefault() {} }); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll(tag) { return this.children.flatMap(child => (child.tagName === tag ? [child] : []).concat(child.querySelectorAll(tag))); }
    focus() { this.focused = true; }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id); };
  class Auth extends EventTarget {
    constructor() { super(); this.ready = ready; this.enabled = enabled; this.generation = 1; this.user = role ? { username: role === 'admin' ? 'captain' : 'observer', role } : null; this.verifications = 0; this.expirations = 0; this.loginPrompts = 0; }
    async verifyManage() { this.verifications++; if (this.verify) await this.verify(); }
    initialize() { return Promise.resolve(); }
    notify() { this.dispatchEvent(new Event('change')); }
    change(nextRole, username) { this.user = nextRole ? { username: username || (nextRole === 'admin' ? 'captain' : 'observer'), role: nextRole } : null; ++this.generation; this.notify(); }
    expire() { this.expirations++; this.change(null); }
    openLogin() { this.loginPrompts++; }
  }
  const auth = new Auth();
  const panel = new BoatUserManagementPanel({ document: { getElementById: node, createElement(tag) { const value = new Node(); value.tagName = tag; return value; } }, auth, AbortController,
    toast: message => toasts.push(message),
    fetch: async (url, options) => {
      calls.push({ url, ...options }); if (next) return next(url, options);
      if (options.method === 'GET') return response(200, { users, currentUserId: 'u-admin' });
      const body = JSON.parse(options.body);
      if (options.method === 'POST') users = [...users, { id: 'u-new', username: body.username, role: body.role }];
      else users = users.map(user => user.id === url.split('/').at(-1) ? { id: user.id, username: body.username, role: body.role } : user);
      return response(200, { ok: true, reauthenticate: url.endsWith('/u-admin') });
    },
    setTimeout(fn, duration) { const id = ++sequence; timers.set(id, { fn, duration }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { panel, node, auth, calls, timers, toasts,
    next(fn) { next = fn; },
    edit({ username = 'crew-01', role = 'guest', password = 'new password', confirmation = password } = {}) {
      node('userUsername').value = username; node('userRole').value = role; node('userPassword').value = password; node('userPasswordConfirm').value = confirmation;
    },
    timeout() { const [id, timer] = [...timers][0] || []; assert.ok(timer); timers.delete(id); timer.fn(); }
  };
}
async function until(predicate) { for (let i = 0; i < 40; i++) { if (predicate()) return; await Promise.resolve(); } assert.fail('expected asynchronous request phase'); }

test('用户表单校验用户名、角色、确认密码，编辑留空不发送密码且保留密码原始空格', () => {
  assert.deepEqual(validateUserForm({ username: ' crew.01 ', role: 'guest', password: ' 654321 ', confirmation: ' 654321 ' }, true), { username: 'crew.01', role: 'guest', password: ' 654321 ' });
  assert.deepEqual(validateUserForm({ username: 'captain', role: 'admin', password: '', confirmation: '' }, false), { username: 'captain', role: 'admin' });
  for (const input of [{ username: '<img>', role: 'admin', password: '123456', confirmation: '123456' }, { username: 'crew', role: 'root', password: '123456', confirmation: '123456' }, { username: 'crew', role: 'guest', password: 'short', confirmation: 'short' }, { username: 'crew', role: 'guest', password: '123456', confirmation: '654321' }]) assert.throws(() => validateUserForm(input, true));
  assert.throws(() => validateUserForm({ username: 'crew', role: 'guest', password: '', confirmation: '' }, true), /设置密码/);
});

test('访客、未登录、legacy及配置未知不能调用用户管理接口', async () => {
  for (const options of [{ role: 'guest' }, { role: null }, { enabled: false, role: null }, { ready: false }]) {
    const h = setup(options); assert.equal(await h.panel.open(), false); assert.equal(await h.panel.read(), false);
    assert.equal(h.panel.create(), false); h.edit(); assert.equal(await h.panel.save(), false); assert.equal(h.calls.length, 0); assert.equal(h.auth.verifications, 0);
    assert.equal(h.node('userManagementContent').hidden, true);
    if (options.enabled === false) { assert.equal(h.node('userManagement').hidden, false); assert.match(h.node('userManagementAccess').textContent, /未启用统一账户/); }
    else assert.equal(h.node('userManagement').hidden, true);
    h.panel.destroy();
  }
});

test('管理员读取列表仅保存公开字段，显示当前用户和角色，轮询不覆盖编辑草稿', async () => {
  const h = setup(); assert.equal(await h.panel.open(), true); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/auth/users'); assert.equal(h.calls[0].credentials, 'same-origin'); assert.equal(h.calls[0].cache, 'no-store'); assert.equal(h.calls[0].redirect, 'error');
  assert.equal(h.panel.users.length, 2); assert.equal(h.node('userManagementList').children.length, 2); assert.match(h.node('userManagementCount').textContent, /2 \/ 64/);
  h.panel.edit('u-guest'); h.edit({ username: 'draft-name', password: '' }); h.auth.notify(); assert.equal(await h.panel.open(), false);
  assert.equal(h.node('userUsername').value, 'draft-name'); assert.equal(h.calls.length, 1); h.panel.destroy();
});

test('新建用户单次提交且立即清空密码，成功重读列表而不改变当前身份或连接', async () => {
  const h = setup(); await h.panel.open(); assert.equal(h.panel.create(), true); h.edit();
  const saving = h.panel.save(); assert.equal(h.node('userPassword').value, ''); assert.equal(h.node('userPasswordConfirm').value, '');
  assert.equal(await h.panel.save(), false); assert.equal(await saving, true);
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'GET']); assert.deepEqual(JSON.parse(h.calls[1].body), { username: 'crew-01', role: 'guest', password: 'new password' });
  assert.equal(h.panel.users.length, 3); assert.equal(h.auth.generation, 1); assert.equal(h.auth.expirations, 0); assert.equal(h.node('userManagementForm').hidden, true);
  assert.equal(h.node('userManagementStatus').dataset.tone, 'success'); h.panel.destroy();
});

test('编辑其他用户可仅改名和角色，空密码不进入PATCH且原管理员仍登录', async () => {
  const h = setup(); await h.panel.open(); assert.equal(h.panel.edit('u-guest'), true); assert.equal(h.node('userSelfNotice').hidden, true);
  h.edit({ username: 'navigator', role: 'admin', password: '' }); assert.equal(await h.panel.save(), true);
  assert.equal(h.calls[1].method, 'PATCH'); assert.equal(h.calls[1].url, '/api/auth/users/u-guest'); assert.deepEqual(JSON.parse(h.calls[1].body), { username: 'navigator', role: 'admin' });
  assert.equal(h.auth.expirations, 0); assert.equal(h.panel.users[1].role, 'admin'); h.panel.destroy();
});

test('自身修改明确提示退出，成功后清除密码和列表并打开重新登录', async () => {
  const h = setup(); await h.panel.open(); h.panel.edit('u-admin'); assert.equal(h.node('userSelfNotice').hidden, false); h.edit({ username: 'captain-new', role: 'admin' });
  assert.equal(await h.panel.save(), true); assert.equal(h.auth.expirations, 1); assert.equal(h.auth.loginPrompts, 1); assert.match(h.toasts[0], /重新登录/);
  assert.equal(h.node('userPassword').value, ''); assert.equal(h.panel.users.length, 0); assert.equal(h.node('userManagement').hidden, true); assert.deepEqual(h.calls.map(call => call.method), ['GET', 'PATCH']); h.panel.destroy();
});

test('表单验证失败、取消或关闭均清空密码；关闭后不发管理请求', async () => {
  const h = setup(); await h.panel.open(); h.panel.create(); h.edit({ password: '123456', confirmation: '654321' }); assert.equal(await h.panel.save(), false); assert.equal(h.calls.length, 1); assert.equal(h.node('userPassword').value, '');
  h.edit(); h.panel.cancelEdit(); assert.equal(h.node('userPassword').value, ''); assert.equal(h.node('userManagementForm').hidden, true);
  h.panel.create(); h.edit(); h.panel.close(); assert.equal(h.node('userPassword').value, ''); assert.equal(h.panel.loaded, false); assert.equal(await h.panel.read(), false);
  assert.equal(await h.panel.open(), true); assert.equal(h.calls.length, 2); h.panel.destroy();
});

test('身份切换会取消请求并清空列表，迟到管理员响应不能恢复用户管理', async () => {
  const h = setup(); let resolve; h.next(() => new Promise(done => { resolve = done; }));
  const opening = h.panel.open(); await until(() => !!resolve); h.auth.change('guest'); assert.equal(await opening, false);
  resolve(response(200, { users: initialUsers(), currentUserId: 'u-admin' })); await Promise.resolve();
  assert.equal(h.panel.loaded, false); assert.equal(h.panel.users.length, 0); assert.equal(h.node('userManagement').hidden, true); assert.equal(h.timers.size, 0); h.panel.destroy();
});

test('提交前重新验证管理员，验证途中降权时不发送保存请求', async () => {
  const h = setup(); await h.panel.open(); h.panel.create(); h.edit(); let release;
  h.auth.verify = () => new Promise(resolve => { release = resolve; }); const saving = h.panel.save(); await until(() => !!release);
  h.auth.change('guest'); release(); assert.equal(await saving, false); assert.equal(h.calls.length, 1); assert.equal(h.node('userPassword').value, ''); h.panel.destroy();
});

test('读取失败不会显示旧列表，保存超时结果未知且不自动重复创建', async () => {
  const h = setup(); await h.panel.open(); h.panel.create(); h.edit(); h.next(() => new Promise(() => {}));
  const saving = h.panel.save(); await until(() => h.calls.length === 2); h.timeout(); assert.equal(await saving, false);
  assert.equal(h.calls.length, 2); assert.equal(h.panel.loaded, false); assert.equal(h.node('userManagementForm').hidden, true); assert.equal(h.node('userPassword').value, ''); assert.match(h.node('userManagementStatus').textContent, /结果尚未确认/);
  h.next(async () => response(503, { error: '暂时不可用' })); assert.equal(await h.panel.read(), false); assert.match(h.node('userManagementStatus').textContent, /暂时不可用/); assert.equal(h.panel.users.length, 0); h.panel.destroy();
});

test('已保存但重读失败提示真实结果，不再次发送mutation；非法列表不进入DOM', async () => {
  const h = setup(); await h.panel.open(); h.panel.create(); h.edit(); h.next(async (url, options) => options.method === 'POST' ? response(200, { ok: true, reauthenticate: false }) : response(503, {}));
  assert.equal(await h.panel.save(), false); assert.match(h.node('userManagementStatus').textContent, /用户已保存.*列表刷新失败/); assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'GET']);
  h.next(async () => response(200, { users: [{ id: 'x', username: '<script>', role: 'admin' }], currentUserId: 'x' })); assert.equal(await h.panel.read(), false); assert.equal(h.node('userManagementList').children.length, 0); assert.match(h.node('userManagementStatus').textContent, /响应无效/); h.panel.destroy();
});

test('401清除当前身份并提示登录，403禁止继续操作用户接口', async () => {
  for (const status of [401, 403]) {
    const h = setup(); h.next(async () => response(status, { error: '没有权限' })); assert.equal(await h.panel.open(), false);
    assert.equal(h.panel.loaded, false); assert.equal(h.node('userManagementContent').hidden, true);
    assert.equal(await h.panel.read(), false); assert.equal(h.calls.length, 1);
    if (status === 401) { assert.equal(h.auth.expirations, 1); assert.equal(h.auth.loginPrompts, 1); }
    h.panel.destroy();
  }
});
