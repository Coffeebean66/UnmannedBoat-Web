'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { BoatDriverDataAlerts, LABELS, missingData } = require('../public/driver-data-alerts');
const healthy = () => ({ dataHealth: Object.fromEntries(Object.keys(LABELS).map(key => [key, true])) });
function fixture() {
  const panel = { hidden: true }, text = { textContent: '' }, document = new EventTarget(), host = new EventTarget();
  let now = 0, next = 0, visible = true, admin = true; const timers = new Map(), rumbles = [];
  Object.assign(host, { setTimeout(fn, duration) { timers.set(++next, { at: now + duration, fn }); return next; }, clearTimeout(id) { timers.delete(id); } });
  Object.assign(document, { hidden: false, getElementById: id => id === 'driverDataAlerts' ? panel : text });
  const driver = { document, context: { deviceId: 'boat-01', connected: true, authenticated: true }, visible: () => visible, admin: () => admin,
    nodes: { driverMode: { value: '0' } }, gamepad: { haptics: { notifyDataLoss: at => rumbles.push(at) } } };
  const alerts = new BoatDriverDataAlerts({ driver, host });
  return { alerts, driver, document, host, panel, text, rumbles, timers, set visible(value) { visible = value; }, set admin(value) { admin = value; },
    update(value = healthy(), at = now) { now = at; alerts.update(value, at); }, advance(at) { now = at; for (const [key, timer] of [...timers]) if (timer.at <= at) { timers.delete(key); timer.fn(); } }, close: () => alerts.destroy() };
}
test('缺失项根据独立有效位收集，未知未上报字段不等同于故障', () => {
  assert.deepEqual(missingData({}), []); assert.deepEqual(missingData({ dataHealth: { rtkSpeed: false, imuEuler: false, motor1: true } }), ['rtkSpeed', 'imuEuler']);
});
test('初次收帧宽限后合并显示，准确持续2s；重复的缺失不续期、不反复震动', () => {
  const f = fixture(), value = healthy(); value.dataHealth.motor1 = value.dataHealth.rtkSpeed = false;
  f.update(value, 0); f.update(value, 499); assert.equal(f.panel.hidden, true);
  f.update(value, 500); assert.equal(f.panel.hidden, false); assert.match(f.text.textContent, /左电机反馈、RTK速度/); assert.match(f.text.textContent, /PWM开环仍可操控/); assert.deepEqual(f.rumbles, [500]);
  for (let at = 600; at <= 2400; at += 100) f.update(value, at);
  f.advance(2499); assert.equal(f.panel.hidden, false); f.advance(2500); assert.equal(f.panel.hidden, true);
  f.update(value, 2600); assert.equal(f.panel.hidden, true); assert.equal(f.rumbles.length, 1); f.close(); assert.equal(f.timers.size, 0);
});
test('新增缺失项重新提示，恢复后再次缺失可重触发；闭环提示不声称可继续闭环', () => {
  const f = fixture(), value = healthy(); f.update(value, 0); f.update(value, 500);
  value.dataHealth.imuEuler = false; f.update(value, 600); assert.equal(f.rumbles.length, 1);
  value.dataHealth.motor2 = false; f.update(value, 800); assert.match(f.text.textContent, /右电机反馈/); assert.equal(f.rumbles.length, 2);
  f.update(healthy(), 900); f.driver.nodes.driverMode.value = '1'; f.update(value, 1000);
  assert.match(f.text.textContent, /闭环仍需有效反馈/); assert.equal(f.rumbles.length, 3); f.close();
});
test('通信中断另行提醒且不改变驾驶状态；切船、离页、隐藏和访客清理弹窗与基准', () => {
  const f = fixture(), bad = healthy(); bad.dataHealth.imuGyro = false;
  f.update(bad, 0); f.update(bad, 500); f.driver.context.connected = false; f.update(bad, 600);
  assert.match(f.text.textContent, /船端通信.*已请求停船/); assert.equal(f.rumbles.length, 2);
  f.update(bad, 700); assert.equal(f.rumbles.length, 2);
  f.driver.context.deviceId = 'boat-02'; f.update(bad, 800); assert.equal(f.panel.hidden, true);
  f.driver.context.connected = true; f.update(bad, 900); f.update(bad, 1400); assert.equal(f.rumbles.length, 3);
  f.visible = false; f.update(bad, 1500); assert.equal(f.panel.hidden, true); assert.equal(f.timers.size, 0);
  f.visible = true; f.admin = false; f.update(bad, 1600); assert.equal(f.panel.hidden, true);
  f.admin = true; f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange')); assert.equal(f.panel.hidden, true); f.close();
});
