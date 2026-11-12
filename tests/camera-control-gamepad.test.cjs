/* 真实云台前端的手柄租约、换向和迟到响应检查；不访问生产摄像头。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { webcrypto } = require('node:crypto');
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function fixture() {
  class Node extends EventTarget {
    constructor() { super(); this.dataset = {}; this.value = ''; this.muted = true; }
    before() {} after() {} setAttribute() {}
    querySelectorAll() { return buttons; }
  }
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const buttons = ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright', 'zoomin', 'zoomout'].map(command => Object.assign(new Node(), { dataset: { cameraCommand: command } }));
  const document = Object.assign(new EventTarget(), { getElementById: node, createComment: () => new Node() });
  const auth = Object.assign(new EventTarget(), { ready: true, enabled: true, user: { username: 'driver', role: 'driver' } });
  const window = Object.assign(new EventTarget(), { document, BoatAuth: auth, navigator: {} });
  const calls = [], timers = new Map(); let timerId = 0;
  const h = { node, auth, window, calls, fail: false, pauseStop: null };
  const fetcher = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body, keepalive: options.keepalive });
    if (body?.command === 'stop' && h.pauseStop) await h.pauseStop;
    return { ok: !h.fail, status: h.fail ? 409 : 200, async json() { return h.fail ? { error: '摄像头忙' } : body ? { stopped: body.command === 'stop' } : { enabled: true, revision: 1 }; } };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/camera-control.js'), 'utf8'), { window, crypto: webcrypto, AbortController,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  const camera = h.camera = new window.BoatCameraControl({ document, auth, fetcher });
  camera.deviceId = 'boat-01'; camera.authenticated = true; camera.visible = true; camera.config = { enabled: true, revision: 1 };
  node('cameraPtzSpeed').value = '137';
  h.renew = async () => { const timer = [...timers].find(([, value]) => value.delay === 350); assert.ok(timer, '续租计时器存在'); timers.delete(timer[0]); timer[1].fn(); await settle(); };
  h.commands = () => calls.filter(call => call.body).map(call => call.body.command);
  h.close = async () => { camera.destroy(); await settle(); };
  return h;
}

test('收起面板可用手柄控制八方向；长按复用350ms租约，松键发送停止', async () => {
  const h = fixture(), c = h.camera;
  assert.equal(c.opened, false); c.setGamepadDirection(0, 0);
  for (const [x, y, command] of [[0, -1, 'up'], [0, 1, 'down'], [-1, 0, 'left'], [1, 0, 'right'], [-1, -1, 'upleft'], [1, -1, 'upright'], [-1, 1, 'downleft'], [1, 1, 'downright']]) {
    c.setGamepadDirection(x, y); await settle(); const start = h.calls.at(-1);
    assert.equal(start.body.command, command); assert.equal(start.body.speed, 137);
    const count = h.calls.length; for (let i = 0; i < 10; i++) c.setGamepadDirection(x, y);
    assert.equal(h.calls.length, count, '采样不逐帧发送HTTP'); await h.renew();
    assert.equal(h.calls.at(-1).body.leaseId, start.body.leaseId); assert.equal(h.calls.at(-1).body.sequence, 2);
    c.setGamepadDirection(0, 0); await settle(); assert.equal(h.calls.at(-1).body.command, 'stop');
    assert.equal(h.calls.at(-1).keepalive, true); assert.equal(h.calls.at(-1).body.sequence, 3); assert.equal(c.ptz, null);
  }
  await h.close();
});

test('RT放大与A+RT缩小共用变焦续租，变焦优先于方向且松开停止', async () => {
  const h = fixture(), c = h.camera; c.setGamepadDirection(0, 0);
  c.setGamepadDirection(1, -1, 1); await settle(); assert.equal(h.commands().at(-1), 'zoomin');
  const lease = c.ptz.leaseId; await h.renew(); assert.equal(c.ptz.leaseId, lease); assert.equal(h.calls.at(-1).body.zoomSpeed, 4);
  c.setGamepadDirection(1, -1, -1); await c.pendingStop; await settle(); assert.deepEqual(h.commands().slice(-2), ['stop', 'zoomout']);
  c.setGamepadDirection(0, 0, 0); await c.pendingStop; await settle(); assert.equal(c.ptz, null); assert.equal(h.commands().at(-1), 'stop');
  c.setGamepadDirection(0, 0, 1); await settle(); c.resetGamepadPtz(); await c.pendingStop;
  const count = h.calls.length; c.setGamepadDirection(0, 0, 1); await settle(); assert.equal(h.calls.length, count, '切换目标后不恢复按住的RT');
  c.setGamepadDirection(0, 0, 0); c.setGamepadDirection(0, 0, -1); await settle(); assert.equal(h.commands().at(-1), 'zoomout'); await h.close();
});

test('换向先等旧租约停止，等待中松键取消迟到的移动', async () => {
  const h = fixture(), c = h.camera; c.setGamepadDirection(0, 0); c.setGamepadDirection(-1, 0); await settle();
  let release; h.pauseStop = new Promise(resolve => { release = resolve; });
  c.setGamepadDirection(1, 0); await settle(); assert.deepEqual(h.commands(), ['left', 'stop']);
  c.setGamepadDirection(0, 0); await settle(); release(); await settle();
  assert.deepEqual(h.commands(), ['left', 'stop', 'stop']); assert.equal(c.ptz, null, '取消后不发送迟到的right');
  h.pauseStop = null; c.setGamepadDirection(1, 0); await settle(); assert.equal(h.commands().at(-1), 'right'); await h.close();
});

test('快速连续换向的停止按序发送，最终方向等全部旧租约释放', async () => {
  const h = fixture(), c = h.camera; c.setGamepadDirection(0, 0); c.setGamepadDirection(-1, 0); await settle();
  let release; h.pauseStop = new Promise(resolve => { release = resolve; });
  c.setGamepadDirection(0, -1); c.setGamepadDirection(1, -1); c.setGamepadDirection(1, 0); await settle();
  assert.deepEqual(h.commands(), ['left', 'stop']); release(); await c.pendingStop; await settle();
  assert.deepEqual(h.commands(), ['left', 'stop', 'stop', 'stop', 'right']); await h.close();
});

test('换船、来源版本变化及失焦停止后，长按不会自动接管新摄像头', async () => {
  for (const change of ['boat', 'revision', 'blur', 'hidden', 'stop']) {
    const h = fixture(), c = h.camera; c.setGamepadDirection(0, 0); c.setGamepadDirection(1, 0); await settle();
    if (change === 'boat') c.update({ deviceId: 'boat-02', authenticated: true });
    if (change === 'revision') { c.config.revision = 0; await c.load(); }
    if (change === 'blur') h.window.dispatchEvent(new Event('blur'));
    if (change === 'hidden') { c.setVisible(false); c.setVisible(true); }
    if (change === 'stop') h.node('cameraPtzStop').dispatchEvent(new Event('click'));
    await settle(); const moves = h.commands().filter(command => command !== 'stop').length;
    c.setGamepadDirection(1, 0); c.setGamepadDirection(0, -1); await settle();
    assert.equal(h.commands().filter(command => command !== 'stop').length, moves, change);
    c.setGamepadDirection(0, 0); c.setGamepadDirection(0, -1); await settle(); assert.equal(h.commands().at(-1), 'up', change);
    if (change === 'boat') assert.match(h.calls.at(-1).url, /\/boat-02\/ptz$/);
    await h.close();
  }
});

test('无权限、未绑定、未登录、隐藏及非法方向不发送移动；失败不逐帧重试', async () => {
  for (const change of ['guest', 'unbound', 'unauthenticated', 'invisible', 'invalid']) {
    const h = fixture(), c = h.camera; c.setGamepadDirection(0, 0);
    if (change === 'guest') h.auth.user.role = 'guest';
    if (change === 'unbound') c.config.enabled = false;
    if (change === 'unauthenticated') c.authenticated = false;
    if (change === 'invisible') c.visible = false;
    c.setGamepadDirection(change === 'invalid' ? NaN : 1, 0); await settle(); assert.deepEqual(h.commands(), [], change); await h.close();
  }
  const h = fixture(), c = h.camera; c.setGamepadDirection(0, 0); h.fail = true; c.setGamepadDirection(1, 0); await settle();
  const count = h.calls.length; for (let i = 0; i < 20; i++) c.setGamepadDirection(1, 0); await settle();
  assert.equal(h.calls.length, count); h.fail = false; c.setGamepadDirection(0, 0); c.setGamepadDirection(1, 0); await settle(); assert.equal(h.commands().at(-1), 'right'); await h.close();
});

test('手柄闲置不停止鼠标云台，鼠标接手后长按的手柄不抢回控制', async () => {
  const h = fixture(), c = h.camera; c.opened = true; c.setGamepadDirection(0, 0); c.setGamepadDirection(1, 0); await settle();
  await c.startPtz('left', c.buttons.find(button => button.dataset.cameraCommand === 'left')); await settle();
  assert.equal(c.ptz.source, 'panel'); c.setGamepadDirection(1, 0); c.setGamepadDirection(0, 0); await settle();
  assert.equal(c.ptz.command, 'left'); assert.equal(c.ptz.source, 'panel'); await h.close();
});
