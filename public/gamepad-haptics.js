/* 震动异步且有界，不等待设备反馈，也不改变驾驶指令与接管状态。 */
(function(scope) {
  'use strict';
  const schema = typeof module === 'object' && module.exports ? require('./utils/gamepadHaptics') : scope.BoatModules.gamepadHaptics;
  const ENDPOINT = '/api/gamepad-haptics';
  class BoatGamepadHaptics {
    constructor({ driver, gamepad, document = driver.document, host = scope, auth = driver.auth, fetch = driver.fetch } = {}) {
      Object.assign(this, { driver, gamepad, document, host, auth, fetch });
      this.nodes = Object.fromEntries(['gamepadHapticsSettings', 'gamepadHapticsForm', 'gamepadHapticsEnabled', 'gamepadHapticsThreshold', 'gamepadHapticsRead', 'gamepadHapticsSave', 'gamepadHapticsStatus', 'driverGamepadHapticsStatus', 'driverGamepadHapticsTest'].map(id => [id, document.getElementById(id)]));
      this.events = new schema.HapticEvents(); this.state = null; this.loaded = false; this.dirty = false; this.busy = false; this.destroyed = false;
      this.handlers = []; this.generation = 0; this.effectGeneration = 0; this.message = ''; this.hardwareError = ''; this.contextKey = ''; this.lastEffectAt = -Infinity;
      this.listen(this.nodes.gamepadHapticsForm, 'submit', event => { event.preventDefault(); this.save(); });
      for (const node of [this.nodes.gamepadHapticsEnabled, this.nodes.gamepadHapticsThreshold]) this.listen(node, 'input', () => { this.dirty = true; this.message = '修改尚未保存。'; this.render(); });
      this.listen(this.nodes.gamepadHapticsRead, 'click', () => { this.dirty = false; this.refresh(); });
      this.listen(this.nodes.driverGamepadHapticsTest, 'click', () => this.test());
      this.identity = this.accountIdentity();
      this.listen(auth, 'change', () => {
        const identity = this.accountIdentity();
        if (identity !== this.identity) {
          this.identity = identity; this.cancelRequest(); this.state = null; this.loaded = false; this.dirty = false; this.message = ''; this.stop();
          if (this.canRead()) this.refresh();
        }
        this.render();
      });
      this.listen(document, 'visibilitychange', () => { if (document.hidden) { this.cancelRequest(); this.stop(); } else if (this.canRead()) this.refresh(); });
      this.listen(host, 'blur', () => this.stop());
      this.listen(host, 'boat-view-change', () => { this.stop(); if (this.driver.visible() && this.canRead()) this.refresh(); });
      this.render(); if (this.canRead()) this.refresh();
    }
    listen(node, event, handler) { if (node?.addEventListener) { node.addEventListener(event, handler); this.handlers.push([node, event, handler]); } }
    accountIdentity() { return JSON.stringify([this.auth?.generation, this.auth?.ready, this.auth?.enabled, this.auth?.user?.username, this.auth?.user?.role]); }
    canRead() { return !this.destroyed && this.auth?.enabled === true && this.auth.ready === true && ['admin', 'driver'].includes(this.auth.user?.role); }
    admin() { return this.canRead() && this.auth.user.role === 'admin'; }
    open() { if (this.admin()) { this.dirty = false; this.refresh(); } }
    cancelRequest() { ++this.generation; this.request?.abort(); this.request = null; this.busy = false; this.host.clearTimeout(this.poll); }
    async refresh(method = 'GET', body) {
      if (!this.canRead() || this.busy || (method !== 'GET' && !this.admin())) return false;
      const generation = ++this.generation, identity = this.identity, controller = new AbortController();
      const current = () => !this.destroyed && generation === this.generation && identity === this.accountIdentity();
      this.request = controller; this.busy = true; this.host.clearTimeout(this.poll); this.render();
      const timer = this.host.setTimeout(() => controller.abort(), 10000);
      try {
        if (method !== 'GET') await this.auth.verifyPlatformManage?.();
        if (!current()) return false;
        const response = await this.fetch(ENDPOINT, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const value = await response.json();
        if (!response.ok) throw Object.assign(Error(value.error || '震动配置读取失败'), { status: response.status });
        const settings = schema.normalizeSettings(value);
        if (!settings || !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('服务器返回了无效震动配置');
        if (!current()) return false;
        const changed = !this.state || settings.enabled !== this.state.enabled || settings.attitudeThresholdDegrees !== this.state.attitudeThresholdDegrees;
        this.state = { ...settings, revision: value.revision, error: value.error || null }; this.loaded = true;
        if (changed || this.state.error) this.stop();
        if (method !== 'GET') this.dirty = false;
        if (!this.dirty) {
          this.nodes.gamepadHapticsEnabled.checked = settings.enabled;
          this.nodes.gamepadHapticsThreshold.value = String(settings.attitudeThresholdDegrees); this.draftRevision = value.revision;
        }
        this.message = value.error || (this.dirty ? '有未保存的修改；若其他管理员已更新，请重新读取。' : method === 'GET' ? '配置已读取，保存在服务器并对所有驾驶员生效。' : '震动配置已保存，其他驾驶界面通常10秒内同步。');
        return true;
      } catch (error) {
        if (current()) { this.message = error.status === 404 ? '服务器尚未支持震动设置，请更新服务端。' : error.name === 'AbortError' ? '震动设置请求超时，请重新读取确认。' : error.message; if (error.status === 401) this.auth.expire?.(); }
        return false;
      } finally {
        this.host.clearTimeout(timer);
        if (current()) { this.request = null; this.busy = false; this.render(); if (this.canRead() && !this.document.hidden) this.poll = this.host.setTimeout(() => this.refresh(), 10000); }
      }
    }
    save() {
      if (!this.admin() || !this.loaded || this.busy) return Promise.resolve(false);
      const settings = schema.normalizeSettings({ enabled: this.nodes.gamepadHapticsEnabled.checked, attitudeThresholdDegrees: Number(this.nodes.gamepadHapticsThreshold.value) });
      if (!settings) { this.message = '姿态阈值须为1—90°整数。'; this.render(); return Promise.resolve(false); }
      return this.refresh('PUT', { revision: this.draftRevision, ...settings });
    }
    actuator() {
      const device = this.gamepad.devices.find(item => item.value?.key === this.gamepad.selectedKey)?.pad;
      const rumble = device?.vibrationActuator;
      if (rumble && typeof rumble.playEffect === 'function' && (!rumble.effects || Array.from(rumble.effects).includes('dual-rumble'))) return { device: rumble, kind: 'dual-rumble' };
      const pulse = Array.from(device?.hapticActuators || []).find(item => typeof item?.pulse === 'function');
      return pulse ? { device: pulse, kind: 'pulse' } : null;
    }
    available() {
      const d = this.driver;
      return this.canRead() && this.loaded && this.state?.enabled && !this.state.error && d.visible() && !this.document.hidden && this.document.hasFocus?.() !== false &&
        d.context.authenticated && !!this.gamepad.sample;
    }
    eligible() {
      const d = this.driver;
      return this.available() && d.context.connected && this.gamepad.enabled() &&
        !d.layout?.editing && !d.editing(this.document.activeElement) && !this.document.querySelector('dialog[open]');
    }
    tick() {
      const key = JSON.stringify([this.driver.context.deviceId, this.gamepad.source, this.gamepad.selectedKey]);
      if (key !== this.contextKey) { this.hardwareError = ''; this.lastEffectAt = -Infinity; this.stop(); this.contextKey = key; }
      if (!this.available()) this.stop();
      else if (!this.eligible()) { this.events.reset(); if (this.currentEvent !== 'data-loss') this.stopEffect(); }
      this.render();
    }
    updateTelemetry(value, now) {
      this.tick(); if (!this.eligible()) return;
      const event = this.events.update(value, now, this.state.attitudeThresholdDegrees);
      if (event) this.play(event, now);
    }
    notifyDataLoss(now) {
      if (this.destroyed) return false;
      this.gamepad.scan();
      return this.available() ? this.play('data-loss', now) : false;
    }
    play(event, now = this.host.performance.now()) {
      if (this.destroyed || !this.loaded || !this.state?.enabled || this.state.error || (event !== 'data-loss' && now - this.lastEffectAt < 400)) return false;
      const actuator = this.actuator(); if (!actuator) { this.render(); return false; }
      this.lastEffectAt = now; this.stopEffect(); const generation = this.effectGeneration;
      const duration = event === 'data-loss' ? 350 : event === 'attitude' ? 300 : 160;
      const strongMagnitude = event === 'data-loss' ? .85 : event === 'attitude' ? .8 : .35, weakMagnitude = event === 'data-loss' ? .85 : event === 'attitude' ? .55 : .5;
      this.currentActuator = actuator.device; this.currentEvent = event;
      try {
        const result = actuator.kind === 'dual-rumble' ? actuator.device.playEffect('dual-rumble', { startDelay: 0, duration, strongMagnitude, weakMagnitude }) : actuator.device.pulse(Math.max(strongMagnitude, weakMagnitude), duration);
        Promise.resolve(result).then(result => {
          if (generation !== this.effectGeneration || this.destroyed) return;
          this.hardwareError = result === false || result === 'preempted' ? '震动未完成，请点击测试并检查手柄 / 浏览器支持。' : ''; this.render();
        }, () => { if (generation === this.effectGeneration && !this.destroyed) { this.hardwareError = '浏览器未允许震动，请点击测试或检查手柄连接。'; this.render(); } });
        return true;
      } catch (_) { this.hardwareError = '此手柄或浏览器暂时无法震动。'; this.render(); return false; }
    }
    test() {
      if (!this.canRead() || this.driver.active || this.driver.pending || this.document.hidden || !this.driver.visible() || !this.gamepad.enabled()) return false;
      this.gamepad.scan(); return this.play('motor');
    }
    stopEffect() {
      ++this.effectGeneration; const actuator = this.currentActuator; this.currentActuator = null; this.currentEvent = '';
      if (actuator) try { Promise.resolve(typeof actuator.reset === 'function' ? actuator.reset() : actuator.pulse?.(0, 1)).catch(() => {}); } catch (_) {}
    }
    stop() { this.events.reset(); this.stopEffect(); }
    render() {
      const n = this.nodes, admin = this.admin(), allowed = this.canRead();
      n.gamepadHapticsSettings.hidden = !admin;
      for (const node of [n.gamepadHapticsEnabled, n.gamepadHapticsThreshold]) node.disabled = !admin || !this.loaded || this.busy;
      n.gamepadHapticsRead.disabled = !admin || this.busy; n.gamepadHapticsSave.disabled = !admin || !this.loaded || this.busy;
      const message = this.message || '正在读取平台震动配置。'; if (n.gamepadHapticsStatus.textContent !== message) n.gamepadHapticsStatus.textContent = message;
      const status = !allowed ? '请以管理员或驾驶员登录。' : !this.loaded ? '震动配置尚未读取。' : this.state.error ? this.state.error : !this.state.enabled ? '管理员已关闭手柄震动。' :
        !this.gamepad.sample ? '选择并连接手柄后显示震动支持状态。' : !this.actuator() ? '此手柄 / 浏览器未提供震动接口，驾驶功能仍可使用。' : this.hardwareError || '震动已开启 · 姿态变化阈值 ' + this.state.attitudeThresholdDegrees + '° / 0.5秒';
      if (n.driverGamepadHapticsStatus.textContent !== status) n.driverGamepadHapticsStatus.textContent = status;
      n.driverGamepadHapticsTest.disabled = !allowed || !this.loaded || !this.state?.enabled || !!this.state?.error || !this.gamepad.enabled() || !this.actuator() || this.driver.active || this.driver.pending;
    }
    destroy() { this.destroyed = true; this.cancelRequest(); this.stop(); for (const [node, event, handler] of this.handlers) node.removeEventListener(event, handler); this.handlers = []; }
  }
  scope.BoatGamepadHaptics = BoatGamepadHaptics;
  if (typeof module === 'object' && module.exports) module.exports = { BoatGamepadHaptics };
})(typeof window === 'object' ? window : globalThis);
