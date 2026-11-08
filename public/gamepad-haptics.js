/* 震动异步且有界，不等待设备反馈，也不改变驾驶指令与接管状态。 */
(function(scope) {
  'use strict';
  const schema = typeof module === 'object' && module.exports ? require('./utils/gamepadHaptics') : scope.BoatModules.gamepadHaptics;
  const ENDPOINT = '/api/gamepad-haptics';
  class BoatGamepadHaptics {
    constructor({ driver, gamepad, document = driver.document, host = scope, auth = driver.auth, fetch = driver.fetch } = {}) {
      Object.assign(this, { driver, gamepad, document, host, auth, fetch });
      this.nodes = Object.fromEntries(['gamepadHapticsSettings', 'gamepadHapticsForm', 'gamepadHapticsEnabled', 'gamepadHapticsThreshold', 'gamepadHapticsIntensity', 'gamepadHapticsRead', 'gamepadHapticsSave', 'gamepadHapticsStatus', 'gamepadHapticsAlert', 'gamepadHapticsAlertStatus', 'driverGamepadHapticsStatus', 'driverGamepadHapticsTest'].map(id => [id, document.getElementById(id)]));
      this.events = new schema.HapticEvents(); this.state = null; this.loaded = false; this.dirty = false; this.busy = false; this.destroyed = false;
      this.handlers = []; this.generation = 0; this.effectGeneration = 0; this.message = ''; this.hardwareError = ''; this.contextKey = ''; this.lastEffectAt = -Infinity;
      this.alertActuators = new Set(); this.alertIds = new Set(); this.alertServerOffset = null; this.broadcastBusy = false; this.alertMessage = '';
      this.listen(this.nodes.gamepadHapticsForm, 'submit', event => { event.preventDefault(); this.save(); });
      for (const node of [this.nodes.gamepadHapticsEnabled, this.nodes.gamepadHapticsThreshold, this.nodes.gamepadHapticsIntensity]) this.listen(node, 'input', () => { this.dirty = true; this.message = '修改尚未保存。'; this.render(); });
      this.listen(this.nodes.gamepadHapticsRead, 'click', () => { this.dirty = false; this.refresh(); });
      this.listen(this.nodes.driverGamepadHapticsTest, 'click', () => this.test());
      this.listen(this.nodes.gamepadHapticsAlert, 'click', () => this.broadcast());
      this.identity = this.accountIdentity();
      this.listen(auth, 'change', () => {
        const identity = this.accountIdentity();
        if (identity !== this.identity) {
          this.identity = identity; this.cancelRequest(); this.state = null; this.loaded = false; this.dirty = false; this.message = ''; this.stop();
          this.closeAlerts(); this.stopAlert(); this.broadcastController?.abort(); this.broadcastBusy = false; this.alertMessage = '';
          if (this.canRead()) this.refresh();
        }
        this.openAlerts();
        this.render();
      });
      this.listen(document, 'visibilitychange', () => { if (document.hidden) { this.cancelRequest(); this.stop(); } else if (this.canRead()) this.refresh(); });
      this.listen(host, 'blur', () => this.stop());
      this.listen(host, 'boat-view-change', () => { this.stop(); if (this.driver.visible() && this.canRead()) this.refresh(); });
      this.render(); this.openAlerts(); if (this.canRead()) this.refresh();
    }
    listen(node, event, handler) { if (node?.addEventListener) { node.addEventListener(event, handler); this.handlers.push([node, event, handler]); } }
    accountIdentity() { return JSON.stringify([this.auth?.generation, this.auth?.ready, this.auth?.enabled, this.auth?.user?.username, this.auth?.user?.role]); }
    canRead() { return !this.destroyed && this.auth?.enabled === true && this.auth.ready === true && ['admin', 'driver'].includes(this.auth.user?.role); }
    admin() { return this.canRead() && this.auth.user.role === 'admin'; }
    canReceive() { return !this.destroyed && this.auth?.enabled === true && this.auth.ready === true && ['admin', 'driver', 'guest'].includes(this.auth.user?.role); }
    openAlerts() {
      if (!this.canReceive() || this.alertStream || typeof this.host.EventSource !== 'function') return;
      const identity = this.accountIdentity(); let stream;
      try { stream = this.alertStream = new this.host.EventSource(ENDPOINT + '/events', { withCredentials: true }); } catch (_) { return; }
      const current = () => this.alertStream === stream && this.canReceive() && identity === this.accountIdentity();
      stream.addEventListener('ready', event => {
        if (!current()) return;
        try { const value = JSON.parse(event.data); if (Number.isFinite(value.serverTime)) this.alertServerOffset = value.serverTime - Date.now(); } catch (_) {}
      });
      stream.addEventListener('safety-alert', event => { if (current()) try { this.receiveAlert(JSON.parse(event.data)); } catch (_) {} });
      stream.addEventListener('error', () => {
        if (!current()) return;
        this.alertServerOffset = null;
        if (!this.auth.busy) Promise.resolve(this.auth.initialize?.()).catch(() => {});
      });
    }
    closeAlerts() { this.alertStream?.close(); this.alertStream = null; this.alertServerOffset = null; this.alertIds.clear(); }
    async broadcast() {
      if (!this.admin() || this.broadcastBusy) return false;
      const identity = this.accountIdentity(), controller = new AbortController(); this.broadcastController = controller; this.broadcastBusy = true; this.alertMessage = '正在发送安全驾驶提醒…'; this.render();
      const current = () => !this.destroyed && this.broadcastController === controller && identity === this.accountIdentity();
      const timer = this.host.setTimeout(() => controller.abort(), 10000);
      try {
        await this.auth.verifyPlatformManage?.(); if (!current() || !this.admin()) return false;
        const response = await this.fetch(ENDPOINT + '/alert', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' });
        const value = await response.json();
        if (!response.ok) throw Object.assign(Error(value.error || '安全提醒发送失败'), { status: response.status });
        if (!Number.isInteger(value.pages) || value.pages < 0 || !Number.isInteger(value.intensityPercent) || value.intensityPercent < 1 || value.intensityPercent > 100 || value.durationMs !== 1000) throw Error('安全提醒响应无效，请勿重复发送');
        if (!current()) return false;
        this.alertMessage = value.pages ? '已向 ' + value.pages + ' 个在线页面发送 1 秒提醒，强度 ' + value.intensityPercent + '%。' : '当前没有在线提醒页面。';
        return true;
      } catch (error) {
        if (current()) { this.alertMessage = error.name === 'AbortError' ? '发送超时，提醒可能已发出；请先确认再重试。' : error.message; if (error.status === 401) this.auth.expire?.(); }
        return false;
      } finally { this.host.clearTimeout(timer); if (current()) { this.broadcastController = null; this.broadcastBusy = false; this.render(); } }
    }
    receiveAlert(value) {
      const now = Date.now() + (this.alertServerOffset ?? 0);
      if (!this.canReceive() || this.alertServerOffset === null || !value || !/^[a-f0-9]{32}$/.test(value.id || '') || this.alertIds.has(value.id) ||
          !Number.isFinite(value.createdAt) || value.expiresAt !== value.createdAt + 5000 || now < value.createdAt - 1000 || now >= value.expiresAt || value.durationMs !== 1000 ||
          !Number.isInteger(value.intensityPercent) || value.intensityPercent < 1 || value.intensityPercent > 100) return false;
      this.alertIds.add(value.id); if (this.alertIds.size > 64) this.alertIds.delete(this.alertIds.values().next().value);
      let pads;
      try { pads = Array.from((this.gamepad.navigator || this.host.navigator)?.getGamepads?.() || []).slice(0, 16); } catch (_) { return false; }
      this.stopEffect(); this.stopAlert();
      // 手动安全提醒独立于驾驶、选中设备和自动开关；遍历所有已连接设备。
      for (const pad of pads) {
        if (pad?.connected !== true) continue;
        const actuator = this.padActuator(pad); if (!actuator || this.alertActuators.has(actuator.device)) continue;
        const strength = value.intensityPercent / 100;
        try {
          const result = actuator.kind === 'dual-rumble' ? actuator.device.playEffect('dual-rumble', { startDelay: 0, duration: value.durationMs, strongMagnitude: strength, weakMagnitude: strength }) : actuator.device.pulse(strength, value.durationMs);
          this.alertActuators.add(actuator.device); Promise.resolve(result).catch(() => {});
        } catch (_) { /* 一只手柄不支持不能阻止提醒其他手柄。 */ }
      }
      if (!this.alertActuators.size) return false;
      this.driver.toast?.('管理员提醒：请注意安全驾驶。');
      this.alertTimer = this.host.setTimeout(() => this.stopAlert(), value.durationMs); return true;
    }
    stopAlert() {
      this.host.clearTimeout(this.alertTimer); this.alertTimer = null;
      for (const actuator of this.alertActuators) try { Promise.resolve(typeof actuator.reset === 'function' ? actuator.reset() : actuator.pulse?.(0, 1)).catch(() => {}); } catch (_) {}
      this.alertActuators.clear();
    }
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
        const changed = !this.state || settings.enabled !== this.state.enabled || settings.attitudeThresholdDegrees !== this.state.attitudeThresholdDegrees || settings.intensityPercent !== this.state.intensityPercent;
        this.state = { ...settings, revision: value.revision, error: value.error || null }; this.loaded = true;
        if (changed || this.state.error) this.stop();
        if (method !== 'GET') this.dirty = false;
        if (!this.dirty) {
          this.nodes.gamepadHapticsEnabled.checked = settings.enabled;
          this.nodes.gamepadHapticsIntensity.value = String(settings.intensityPercent);
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
      const settings = schema.normalizeSettings({ enabled: this.nodes.gamepadHapticsEnabled.checked, attitudeThresholdDegrees: Number(this.nodes.gamepadHapticsThreshold.value), intensityPercent: Number(this.nodes.gamepadHapticsIntensity.value) });
      if (!settings) { this.message = '姿态阈值须为1—90°整数，震动强度须为1—100%整数。'; this.render(); return Promise.resolve(false); }
      return this.refresh('PUT', { revision: this.draftRevision, ...settings });
    }
    actuator() {
      const device = this.gamepad.devices.find(item => item.value?.key === this.gamepad.selectedKey)?.pad;
      return this.padActuator(device);
    }
    padActuator(device) {
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
      if (this.destroyed || this.alertActuators.size || !this.loaded || !this.state?.enabled || this.state.error || (event !== 'data-loss' && now - this.lastEffectAt < 400)) return false;
      const actuator = this.actuator(); if (!actuator) { this.render(); return false; }
      this.lastEffectAt = now; this.stopEffect(); const generation = this.effectGeneration;
      const duration = event === 'data-loss' ? 350 : event === 'attitude' ? 300 : 160;
      const scale = this.state.intensityPercent / 100;
      const strongMagnitude = (event === 'data-loss' ? .85 : event === 'attitude' ? .8 : .35) * scale, weakMagnitude = (event === 'data-loss' ? .85 : event === 'attitude' ? .55 : .5) * scale;
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
      for (const node of [n.gamepadHapticsEnabled, n.gamepadHapticsThreshold, n.gamepadHapticsIntensity]) node.disabled = !admin || !this.loaded || this.busy;
      n.gamepadHapticsRead.disabled = !admin || this.busy; n.gamepadHapticsSave.disabled = !admin || !this.loaded || this.busy;
      n.gamepadHapticsAlert.disabled = !admin || this.broadcastBusy;
      n.gamepadHapticsAlertStatus.textContent = this.alertMessage || '按已保存的强度提醒全部在线页面的所有手柄，每次 1 秒。';
      const message = this.message || '正在读取平台震动配置。'; if (n.gamepadHapticsStatus.textContent !== message) n.gamepadHapticsStatus.textContent = message;
      const status = !allowed ? '请以管理员或驾驶员登录。' : !this.loaded ? '震动配置尚未读取。' : this.state.error ? this.state.error : !this.state.enabled ? '管理员已关闭自动震动提醒。' :
        !this.gamepad.sample ? '选择并连接手柄后显示震动支持状态。' : !this.actuator() ? '此手柄 / 浏览器未提供震动接口，驾驶功能仍可使用。' : this.hardwareError || '震动已开启 · 强度 ' + this.state.intensityPercent + '% · 姿态变化阈值 ' + this.state.attitudeThresholdDegrees + '° / 0.5秒';
      if (n.driverGamepadHapticsStatus.textContent !== status) n.driverGamepadHapticsStatus.textContent = status;
      n.driverGamepadHapticsTest.disabled = !allowed || !this.loaded || !this.state?.enabled || !!this.state?.error || !this.gamepad.enabled() || !this.actuator() || this.driver.active || this.driver.pending;
    }
    destroy() { this.destroyed = true; this.closeAlerts(); this.stopAlert(); this.broadcastController?.abort(); this.cancelRequest(); this.stop(); for (const [node, event, handler] of this.handlers) node.removeEventListener(event, handler); this.handlers = []; }
  }
  scope.BoatGamepadHaptics = BoatGamepadHaptics;
  if (typeof module === 'object' && module.exports) module.exports = { BoatGamepadHaptics };
})(typeof window === 'object' ? window : globalThis);
