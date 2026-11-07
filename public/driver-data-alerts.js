/* 缺失数据采用边沿提醒：同一缺失不重复刷新弹窗，也不改变驾驶租约。 */
(function(scope) {
  'use strict';
  const LABELS = Object.freeze({ motor1: '左电机反馈', motor2: '右电机反馈', rtkSpeed: 'RTK速度', rtkFix: 'RTK定位', rtkHeading: 'RTK航向', imuEuler: 'IMU姿态', imuGyro: 'IMU角速度' });
  const missingData = value => Object.keys(LABELS).filter(key => value?.dataHealth?.[key] === false);
  class BoatDriverDataAlerts {
    constructor({ driver, document = driver.document, host = scope } = {}) {
      Object.assign(this, { driver, document, host });
      this.panel = document.getElementById('driverDataAlerts'); this.text = document.getElementById('driverDataAlertsText');
      this.handlers = []; this.destroyed = false; this.reset();
      this.listen(host, 'boat-view-change', () => this.reset());
      this.listen(document, 'visibilitychange', () => { if (document.hidden) this.reset(); });
    }
    listen(node, event, handler) { node.addEventListener(event, handler); this.handlers.push([node, event, handler]); }
    reset() {
      this.host.clearTimeout(this.timer); this.timer = null; this.panel.hidden = true;
      this.device = ''; this.wasConnected = false; this.readyAt = null; this.missing = new Set();
    }
    update(value, now) {
      if (this.destroyed) return;
      const d = this.driver;
      if (!d.visible() || !d.admin() || !d.context.authenticated || !d.context.deviceId) { this.reset(); return; }
      if (this.device !== d.context.deviceId) { this.reset(); this.device = d.context.deviceId; }
      if (!d.context.connected) {
        if (this.wasConnected) { this.wasConnected = false; this.readyAt = null; this.missing.clear(); this.show(['船端通信'], now, true); }
        return;
      }
      if (!this.wasConnected) { this.wasConnected = true; this.readyAt = now + 500; this.missing.clear(); }
      // 给初次连接500ms收齐各类帧，不把刚入页的暂时占位误报为数据丢失。
      if (now < this.readyAt || !value?.dataHealth) return;
      const missing = new Set(missingData(value)), added = [...missing].filter(key => !this.missing.has(key));
      this.missing = missing;
      if (added.length) this.show(added.map(key => LABELS[key]), now);
    }
    show(names, now, network = false) {
      this.host.clearTimeout(this.timer);
      const pwm = Number(this.driver.nodes.driverMode.value) === 0;
      this.text.textContent = names.join('、') + '缺失或已过期。' + (network ? '操控连接已中断，已请求停船。' : pwm ? 'PWM开环仍可操控。' : '闭环仍需有效反馈，可选择PWM开环操控。');
      this.panel.hidden = false;
      this.timer = this.host.setTimeout(() => { this.panel.hidden = true; this.timer = null; }, 2000);
      this.driver.gamepad?.haptics?.notifyDataLoss(now);
    }
    destroy() { this.destroyed = true; this.reset(); for (const [node, event, handler] of this.handlers) node.removeEventListener(event, handler); this.handlers = []; }
  }
  scope.BoatDriverDataAlerts = BoatDriverDataAlerts;
  if (typeof module === 'object' && module.exports) module.exports = { BoatDriverDataAlerts, missingData, LABELS };
})(typeof window === 'object' ? window : globalThis);
