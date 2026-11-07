'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { HapticEvents, normalizeSettings, angleDelta } = require('../public/utils/gamepadHaptics');
const { BoatGamepadHaptics } = require('../public/gamepad-haptics');
const telemetry = (sequence, rpm = 0, angles = [0, 0, 0]) => ({ motors: [{ Rpm: rpm, Sequence: sequence }, { Rpm: 0, Sequence: sequence }],
  imu: { eulerFresh: true, sequence, rollDegrees: angles[0], pitchDegrees: angles[1], yawDegrees: angles[2] } });
test('震动设置严格校验开关与1—90度整数；跨北角差取最短路径', () => {
  assert.deepEqual(normalizeSettings({ enabled: false, attitudeThresholdDegrees: 90 }), { enabled: false, attitudeThresholdDegrees: 90 });
  for (const value of [null, [], {}, { enabled: 'true', attitudeThresholdDegrees: 10 }, ...[0, 91, 1.5, NaN, '10'].map(attitudeThresholdDegrees => ({ enabled: true, attitudeThresholdDegrees }))]) assert.equal(normalizeSettings(value), null);
  assert.equal(angleDelta(179, -179), 2); assert.equal(angleDelta(-179, 179), 2);
});
test('电机初次在线已运行不误报；确认静止300ms后起动200ms才短震，连续运行不重复', () => {
  const e = new HapticEvents(); let sequence = 0;
  for (let at = 0; at <= 600; at += 100) assert.equal(e.update(telemetry(++sequence, 200), at, 10), null);
  for (let at = 700; at <= 1000; at += 100) assert.equal(e.update(telemetry(++sequence), at, 10), null);
  assert.equal(e.update(telemetry(++sequence, 90), 1100, 10), null);
  assert.equal(e.update(telemetry(++sequence, 150), 1200, 10), null);
  assert.equal(e.update(telemetry(++sequence, 180), 1300, 10), 'motor');
  for (let at = 1400; at <= 2000; at += 100) assert.equal(e.update(telemetry(++sequence, 250), at, 10), null);
});
test('短时零转速、静止噪声、重复序号、无效数据及失联恢复都不制造起动事件', () => {
  const e = new HapticEvents(); let sequence = 0;
  for (let at = 0; at <= 1000; at += 100) assert.equal(e.update(telemetry(++sequence, at % 200 ? 45 : 0), at, 10), null);
  e.reset(); e.update(telemetry(1), 0, 10); e.update(telemetry(1), 400, 10);
  for (let at = 500; at < 1000; at += 100) assert.equal(e.update(telemetry(++sequence, 100), at, 10), null, 'repeated still sample does not arm');
  e.update(telemetry(++sequence), 1000, 10); e.update(telemetry(++sequence), 1100, 10);
  for (let at = 1200; at < 1600; at += 100) assert.equal(e.update(telemetry(++sequence, 100), at, 10), null, 'short zero is ignored');
  e.reset(); for (let at = 0; at <= 300; at += 100) e.update(telemetry(++sequence), at, 10);
  e.update({ motors: [{ Rpm: '--', Sequence: ++sequence }] }, 400, 10);
  assert.equal(e.update(telemetry(++sequence, 200), 500, 10), null);
  assert.equal(e.update(telemetry(++sequence, 200), 1800, 10), null, 'reconnection starts a new baseline');
});
test('两电机分别检测；姿态三轴阈值、500ms窗口、最短角差和1.5s冷却生效', () => {
  for (let axis = 0; axis < 3; axis++) {
    const e = new HapticEvents(), angles = [0, 0, 0]; e.update(telemetry(1), 0, 10); angles[axis] = 10;
    assert.equal(e.update(telemetry(2, 0, angles), 200, 10), 'attitude');
    angles[axis] = -10; assert.equal(e.update(telemetry(3, 0, angles), 300, 10), null);
  }
  const e = new HapticEvents(); e.update(telemetry(1, 0, [0, 0, 179]), 0, 10);
  assert.equal(e.update(telemetry(2, 0, [0, 0, -179]), 100, 10), null);
  assert.equal(e.update(telemetry(3, 0, [0, 0, -150]), 700, 10), null, 'slow change outside the window is ignored');
  e.update({ imu: { eulerFresh: false } }, 800, 10);
  assert.equal(e.update(telemetry(4, 0, [40, 0, 0]), 900, 10), null, 'first valid pose after invalid data only establishes baseline');
  assert.equal(e.update(telemetry(5, 0, [55, 0, 0]), 1000, 10), 'attitude');
  assert.equal(e.update(telemetry(5, 0, [80, 0, 0]), 1100, 10), null, 'duplicate sequence is ignored');
  const m = new HapticEvents(); for (let at = 0; at <= 300; at += 100) m.update(telemetry(at), at, 10);
  const right = sequence => { const v = telemetry(sequence); v.motors[1].Rpm = 150; return v; };
  m.update(right(4), 400, 10); assert.equal(m.update(right(6), 600, 10), 'motor');
});
function fixture() {
  class Node extends EventTarget { constructor() { super(); this.value = ''; this.checked = true; this.disabled = false; this.hidden = false; this.textContent = ''; } }
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const document = new EventTarget(); Object.assign(document, { hidden: false, activeElement: null, hasFocus: () => true, getElementById: node, querySelector: () => null });
  const host = new EventTarget(), timers = new Map(); let time = 0, timer = 0;
  Object.assign(host, { performance: { now: () => time }, setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); } });
  const auth = new EventTarget(); Object.assign(auth, { ready: true, enabled: true, generation: 0, user: { username: 'admin', role: 'admin' } });
  const calls = [], reset = [], actuator = { playEffect(kind, options) { calls.push({ kind, ...options }); return Promise.resolve('complete'); }, reset() { reset.push(true); return Promise.resolve(); } };
  const pad = { vibrationActuator: actuator }, gamepad = { source: 'gamepad', selectedKey: 'pad', sample: {}, enabled() { return this.source === 'gamepad'; }, devices: [{ value: { key: 'pad' }, pad }], scan() {} };
  let visible = true, response = { revision: 0, enabled: true, attitudeThresholdDegrees: 10 }, requests = [];
  const driver = { auth, document, context: { deviceId: 'boat-01', connected: true, authenticated: true }, visible: () => visible, editing: () => false, layout: {}, active: false, pending: false,
    async fetch(url, options) { requests.push({ url, ...options }); return { ok: true, json: async () => response }; } };
  const h = new BoatGamepadHaptics({ driver, gamepad, host });
  return { h, node, driver, gamepad, host, auth, actuator, pad, calls, reset, requests, timers, set time(value) { time = value; }, set visible(value) { visible = value; }, set response(value) { response = value; }, async settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }, destroy: () => h.destroy() };
}
test('真实遥测驱动双马达震动，初始只建基准；禁用、切船、切输入、失焦和离页取消', async () => {
  const f = fixture(); await f.settle();
  for (let at = 0; at <= 300; at += 100) f.h.updateTelemetry(telemetry(at), at);
  f.h.updateTelemetry(telemetry(400, 200), 400); f.h.updateTelemetry(telemetry(600, 200), 600);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].kind, 'dual-rumble'); assert.equal(f.calls[0].duration, 160);
  f.h.updateTelemetry(telemetry(1000, 200, [20, 0, 0]), 1000); assert.equal(f.calls.at(-1).duration, 300);
  f.driver.context.deviceId = 'boat-02'; f.h.tick(); assert.ok(f.reset.length);
  f.gamepad.source = 'keyboard'; f.h.updateTelemetry(telemetry(1100, 0, [40, 0, 0]), 1100); assert.equal(f.calls.length, 2);
  f.gamepad.source = 'gamepad'; f.host.dispatchEvent(new Event('blur')); assert.equal(f.h.currentActuator, null);
  f.visible = false; f.h.updateTelemetry(telemetry(1200, 0, [60, 0, 0]), 1200); assert.equal(f.calls.length, 2);
  f.visible = true; f.response = { revision: 1, enabled: false, attitudeThresholdDegrees: 10 }; await f.h.refresh(); assert.equal(f.h.test(), false); f.destroy(); assert.equal(f.timers.size, 0);
});
test('兼容pulse接口；无震动硬件、抛错和异步拒绝均不会影响驾驶', async () => {
  const f = fixture(); await f.settle(); delete f.pad.vibrationActuator;
  assert.equal(f.h.test(), false); assert.match(f.node('driverGamepadHapticsStatus').textContent, /未提供震动/);
  f.pad.hapticActuators = [{ pulse(strength, duration) { f.calls.push({ strength, duration }); return Promise.resolve(true); } }];
  assert.equal(f.h.test(), true); assert.equal(f.calls[0].duration, 160); await f.settle();
  f.time = 500; f.pad.hapticActuators[0].pulse = () => Promise.reject(Error('not allowed'));
  assert.equal(f.h.test(), true); await f.settle(); assert.match(f.h.hardwareError, /未允许震动/);
  f.time = 1000; f.pad.hapticActuators[0].pulse = () => { throw Error('unsupported'); };
  assert.equal(f.h.test(), false); assert.equal(f.driver.active, false); f.destroy();
});
test('仅管理员编辑，驾驶员使用统一配置；自动同步不会覆盖未保存的草稿，注销清除配置', async () => {
  const f = fixture(); await f.settle(); f.node('gamepadHapticsThreshold').value = '25'; f.node('gamepadHapticsThreshold').dispatchEvent(new Event('input'));
  f.response = { revision: 1, enabled: true, attitudeThresholdDegrees: 20 }; await f.h.refresh();
  assert.equal(f.h.state.attitudeThresholdDegrees, 20); assert.equal(f.node('gamepadHapticsThreshold').value, '25');
  await f.h.save(); const request = f.requests.find(req => req.method === 'PUT'); assert.equal(JSON.parse(request.body).revision, 0, 'stale draft revision is sent for conflict detection');
  f.auth.user = { username: 'crew', role: 'driver' }; f.auth.generation++; f.auth.dispatchEvent(new Event('change')); await f.settle();
  assert.equal(f.node('gamepadHapticsSettings').hidden, true); assert.equal(f.h.loaded, true); assert.equal(await f.h.save(), false);
  f.auth.user = null; f.auth.generation++; f.auth.dispatchEvent(new Event('change')); assert.equal(f.h.loaded, false); assert.equal(f.h.state, null); f.destroy();
});
test('缺失数据优先震动，键盘输入但已连接手柄也可提示；通信失效不截断350ms提醒，总开关仍生效', async () => {
  const f = fixture(); await f.settle();
  f.gamepad.source = 'keyboard'; f.h.tick();
  assert.equal(f.h.notifyDataLoss(100), true); assert.equal(f.calls.at(-1).duration, 350);
  f.h.tick(); assert.equal(f.h.currentEvent, 'data-loss'); assert.equal(f.h.currentActuator, f.actuator);
  f.driver.context.connected = false; f.h.tick(); assert.equal(f.h.currentEvent, 'data-loss');
  assert.equal(f.h.notifyDataLoss(200), true, 'new missing item bypasses ordinary event cooldown');
  f.response = { revision: 1, enabled: false, attitudeThresholdDegrees: 10 }; await f.h.refresh();
  assert.equal(f.h.notifyDataLoss(500), false); assert.equal(f.h.currentActuator, null); f.destroy();
});
