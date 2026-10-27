/* 管理员配置每艘船的视频 MQTT 发布账号；密码只单向提交，永不回读。 */
(function (scope) {
  'use strict';
  const NAME = /^[A-Za-z0-9_-]{1,64}$/, PASSWORD = /^[\x21-\x39\x3b-\x7e]{6,64}$/, REVISION = /^[a-f0-9]{64}$/;
  const REQUEST_TIMEOUT_MS = 35000;
  const cancelled = () => Object.assign(Error('视频账号请求已取消'), { cancelled: true });

  class BoatVideoDeviceSettingsPanel {
    constructor(options = {}) {
      this.document = options.document || scope.document;
      this.auth = options.auth || scope.BoatAuth;
      this.fetch = options.fetcher || options.fetch || scope.fetch.bind(scope);
      this.confirm = options.confirm || (message => scope.confirm(message));
      this.setTimer = options.setTimeout || scope.setTimeout.bind(scope);
      this.clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
      this.AbortController = options.AbortController || scope.AbortController;
      this.nodes = Object.fromEntries([
        'videoDeviceSettings', 'videoDeviceAccess', 'videoDeviceRead', 'videoDeviceContent', 'videoDeviceCount', 'videoDeviceList',
        'videoDeviceForm', 'videoDeviceId', 'videoDeviceUsername', 'videoDevicePassword', 'videoDevicePasswordConfirm',
        'videoDeviceSave', 'videoDeviceCancel', 'videoDeviceStatus', 'videoDevicePasswordHint'
      ].map(id => [id, this.document.getElementById(id)]));
      this.opened = false; this.busy = false; this.loaded = false; this.available = null;
      this.devices = []; this.videos = []; this.revision = ''; this.editingId = '';
      this.generation = 0; this.destroyed = false; this.denied = false; this.listeners = [];
      this.identity = this._identity();
      this.onChange = () => {
        const identity = this._identity();
        // 身份复核和轮询也会通知 change；只有真正切换身份才取消当前请求。
        if (identity !== this.identity) { this.identity = identity; this.denied = false; this.reset(); }
        this.render();
      };
      this.auth?.addEventListener('change', this.onChange);
      this._listen(this.nodes.videoDeviceRead, 'click', () => this.read());
      this._listen(this.nodes.videoDeviceCancel, 'click', () => this.cancel());
      this._listen(this.nodes.videoDeviceForm, 'submit', event => { event.preventDefault(); this.save(); });
      this.clearForm(); this.render();
    }
    _listen(node, event, listener) { node.addEventListener(event, listener); this.listeners.push([node, event, listener]); }
    _identity() { return JSON.stringify([this.auth?.generation, this.auth?.ready, this.auth?.enabled, this.auth?.user?.username, this.auth?.user?.role]); }
    _isAdmin() { return !this.destroyed && this.auth?.ready === true && this.auth.enabled === true && this.auth.user?.role === 'admin'; }
    admin() { return this._isAdmin() && !this.denied; }
    _clearSnapshot() { this.loaded = false; this.available = null; this.devices = []; this.videos = []; this.revision = ''; this.clearForm(); }
    reset() {
      ++this.generation; this._cancel?.(); this.busy = false; this._clearSnapshot();
      this.notice('读取服务器上的视频 MQTT 账号；密码不会返回到网页。');
    }
    _clearPasswords() { this.nodes.videoDevicePassword.value = ''; this.nodes.videoDevicePasswordConfirm.value = ''; }
    clearForm() {
      const n = this.nodes; this.editingId = ''; this._clearPasswords();
      n.videoDeviceForm.hidden = true; n.videoDeviceId.value = ''; n.videoDeviceUsername.value = '';
    }
    notice(message, tone = 'neutral') { this.nodes.videoDeviceStatus.textContent = message; this.nodes.videoDeviceStatus.dataset.tone = tone; }
    render() {
      const n = this.nodes, admin = this.admin();
      n.videoDeviceSettings.hidden = !this._isAdmin();
      n.videoDeviceContent.hidden = !admin || !this.loaded;
      n.videoDeviceAccess.hidden = !this._isAdmin() || !this.denied && this.available !== false;
      n.videoDeviceAccess.textContent = this.denied ? '服务器未授权此账户管理视频 MQTT 账号，请重新登录后再试。'
        : this.available === false ? '服务器管理组件未启用视频账号管理，请按 README 重新运行 maintenance/install-mqtt-device-admin.sh 后再试。' : '';
      n.videoDeviceRead.disabled = !admin || this.busy;
      n.videoDeviceSave.disabled = !admin || this.busy || !this.loaded || this.available !== true;
      n.videoDeviceCancel.disabled = this.busy;
      n.videoDeviceContent.setAttribute('aria-busy', String(this.busy));
      for (const input of [n.videoDeviceId, n.videoDeviceUsername, n.videoDevicePassword, n.videoDevicePasswordConfirm]) input.disabled = !admin || this.busy;
      n.videoDeviceId.readOnly = true;
      n.videoDevicePassword.minLength = 6; n.videoDevicePassword.maxLength = 64;
      n.videoDevicePasswordConfirm.minLength = 6; n.videoDevicePasswordConfirm.maxLength = 64;
      n.videoDevicePasswordHint.textContent = '视频密码为 6–64 位可打印 ASCII 字符，不能包含空格、冒号或中文；密码不会回显。留空表示保留原密码。';
      n.videoDeviceCount.textContent = this.loaded ? this.devices.length + ' 艘设备 · ' + this.videos.length + ' 个视频账号' : '尚未读取';
      n.videoDeviceList.replaceChildren(...this.devices.map(device => {
        const row = this.document.createElement('li'); row.className = 'mqtt-device-row';
        const detail = this.document.createElement('div'); detail.className = 'mqtt-device-identity';
        const name = this.document.createElement('strong'); name.textContent = device.deviceId;
        const video = this.videos.find(item => item.deviceId === device.deviceId);
        const account = this.document.createElement('span'); account.textContent = video ? '视频账号 · ' + video.username : '视频账号 · 未配置';
        detail.append(name, account);
        const button = this.document.createElement('button'); button.type = 'button'; button.className = 'small-button';
        button.textContent = video ? '修改视频账号' : '配置视频账号'; button.disabled = !admin || this.busy;
        button.addEventListener('click', () => this.edit(device.deviceId)); row.append(detail, button); return row;
      }));
      n.videoDeviceList.hidden = !this.loaded || this.available !== true;
    }
    open() {
      this.opened = true; this.render();
      if (this.admin() && !this.busy && !this.loaded) return this.read();
      return Promise.resolve(false);
    }
    close() { this.opened = false; this.reset(); this.render(); }
    read() {
      if (!this.opened || !this.admin() || this.busy) return Promise.resolve(false);
      this.clearForm(); return this._run('GET', '/api/mqtt/devices');
    }
    edit(deviceId) {
      if (!this.opened || !this.loaded || !this.available || !this.admin() || this.busy) return false;
      if (!this.devices.some(item => item.deviceId === deviceId)) return false;
      const video = this.videos.find(item => item.deviceId === deviceId);
      this.clearForm(); this.editingId = deviceId;
      this.nodes.videoDeviceId.value = deviceId; this.nodes.videoDeviceUsername.value = video?.username || '';
      this.nodes.videoDeviceForm.hidden = false; this.render(); this.nodes.videoDeviceUsername.focus();
      this.notice(video ? '可修改视频用户名；密码留空保留原密码。' : '首次配置必须填写视频用户名和密码。'); return true;
    }
    cancel() {
      if (this.busy) return false;
      this.clearForm(); this.notice('已取消视频账号编辑。'); this.render(); return true;
    }
    save() {
      if (!this.opened || !this.editingId || !this.admin() || this.busy || !this.loaded || !this.available) return Promise.resolve(false);
      const n = this.nodes, deviceId = this.editingId, username = n.videoDeviceUsername.value.trim();
      const input = { username, revision: this.revision }, password = n.videoDevicePassword.value, confirmation = n.videoDevicePasswordConfirm.value;
      this._clearPasswords();
      const existing = this.videos.find(item => item.deviceId === deviceId);
      let error;
      if (!NAME.test(username)) error = '视频用户名格式不正确。';
      else if (!existing && !password) error = '首次配置必须填写视频密码。';
      else if (password && !PASSWORD.test(password)) error = '视频密码需为 6–64 位可打印 ASCII 字符，不能包含空格、冒号或中文。';
      else if (password !== confirmation) error = '两次输入的视频密码不一致。';
      if (error) { this.notice(error, 'error'); return Promise.resolve(false); }
      if (existing && existing.username === username && !password) { this.notice('没有需要保存的修改。'); return Promise.resolve(false); }
      if (!this.confirm('确认保存 ' + deviceId + ' 的视频 MQTT 接入账号？\n\n保存会让 MQTT 服务短暂重连；视频发送端需使用新用户名和密码。')) return Promise.resolve(false);
      if (password) input.password = password;
      return this._run('PATCH', '/api/mqtt/devices/' + encodeURIComponent(deviceId) + '/video', input);
    }
    _current(operation, authGeneration) { return operation === this.generation && authGeneration === this.auth?.generation && this.opened && this.admin(); }
    _request(method, path, input, operation, authGeneration) {
      return new Promise((resolve, reject) => {
        const controller = this.AbortController ? new this.AbortController() : null;
        let settled = false;
        const finish = (error, data) => {
          if (settled) return; settled = true; this.clearTimer(timer); if (input) delete input.password;
          if (this._cancel === cancel) this._cancel = null;
          if (error) reject(error); else resolve(data);
        };
        const cancel = () => { finish(cancelled()); controller?.abort(); };
        // 超时包含身份复核、HTTP 请求和响应体读取；即使 fetch 忽略 abort 也能解除忙态。
        const timer = this.setTimer(() => {
          finish(Object.assign(Error(method === 'GET' ? '视频账号读取超时，请重新读取。' : '保存响应超时，结果尚未确认；请重新读取视频账号确认后再操作。'), { timeout: true }));
          controller?.abort();
        }, REQUEST_TIMEOUT_MS);
        this._cancel = cancel;
        Promise.resolve().then(async () => {
          await this.auth.verifyManage();
          if (settled || !this._current(operation, authGeneration)) throw cancelled();
          let body = input ? JSON.stringify(input) : undefined;
          if (input) delete input.password;
          const pending = this.fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body } : {}), ...(controller ? { signal: controller.signal } : {}) });
          body = undefined;
          const response = await pending, data = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(Error(String(data.error || '视频账号请求失败（HTTP ' + response.status + '）').slice(0, 300)), { status: response.status });
          return data;
        }).then(data => finish(null, data), error => finish(error));
      });
    }
    _applySnapshot(data) {
      if (!data || !Array.isArray(data.devices) || data.devices.length > 64 || typeof data.revision !== 'string' || !REVISION.test(data.revision)
        || Object.hasOwn(data, 'canManageVideo') && typeof data.canManageVideo !== 'boolean') throw Error('视频账号响应格式无效，请重新读取。');
      const ids = new Set(), names = new Set();
      const devices = data.devices.map(device => {
        if (!device || !NAME.test(device.deviceId) || typeof device.deviceId !== 'string' || !NAME.test(device.username) || typeof device.username !== 'string'
          || ids.has(device.deviceId) || names.has(device.username)) throw Error('视频账号设备列表无效，请重新读取。');
        ids.add(device.deviceId); names.add(device.username); return { deviceId: device.deviceId, username: device.username };
      });
      const rawVideos = data.videos === undefined && data.canManageVideo !== true ? [] : data.videos;
      if (!Array.isArray(rawVideos) || rawVideos.length > devices.length) throw Error('视频账号列表无效，请重新读取。');
      const videoIds = new Set(), videoNames = new Set();
      const videos = rawVideos.map(video => {
        if (!video || typeof video.deviceId !== 'string' || typeof video.username !== 'string' || !NAME.test(video.deviceId) || !NAME.test(video.username)
          || !ids.has(video.deviceId) || videoIds.has(video.deviceId) || videoNames.has(video.username) || names.has(video.username)) throw Error('视频账号列表无效，请重新读取。');
        videoIds.add(video.deviceId); videoNames.add(video.username); return { deviceId: video.deviceId, username: video.username };
      });
      this.devices = devices; this.videos = videos; this.revision = data.revision;
      this.loaded = true; this.available = data.canManageVideo === true;
    }
    async _run(method, path, input) {
      if (!this.opened || !this.admin() || this.busy) { if (input) delete input.password; return false; }
      const operation = ++this.generation, authGeneration = this.auth.generation;
      this.busy = true; this.notice(method === 'GET' ? '正在读取视频 MQTT 账号…' : '正在保存视频账号并重启 MQTT 服务…'); this.render();
      try {
        const data = await this._request(method, path, input, operation, authGeneration);
        if (!this._current(operation, authGeneration)) return false;
        if (method === 'GET' && data?.enabled === false) {
          this._clearSnapshot(); this.available = false;
          this.notice('服务器尚未启用视频账号管理组件，请按 README 重新运行 maintenance/install-mqtt-device-admin.sh 后再试。', 'error'); return true;
        }
        if (method !== 'GET' && (data?.ok !== true || typeof data.requiresReconnect !== 'boolean' || data.canManageVideo !== true)) throw Error('保存响应未确认，请重新读取视频账号。');
        this._applySnapshot(data); this.clearForm();
        this.notice(method === 'GET'
          ? this.available ? '已读取视频账号。已有账号可改名，密码留空可保留原密码。' : '服务器管理组件需要更新后才能管理视频账号，请按 README 运行 maintenance/install-mqtt-device-admin.sh。'
          : data.requiresReconnect ? '视频 MQTT 账号已保存，服务已重启。请在发送端同步使用新凭据。' : '视频 MQTT 账号配置未变化，无需重启服务。',
        method === 'GET' ? this.available ? 'neutral' : 'error' : 'success'); return true;
      } catch (error) {
        if (error.cancelled || operation !== this.generation || this.destroyed) return false;
        // 失败或超时不能把旧 revision 当成已确认值，必须重读后才能继续保存。
        this._clearSnapshot();
        if (error.status === 401) { this.auth.expire?.(); this.auth.openLogin?.(); }
        if (error.status === 403) { this.denied = true; Promise.resolve(this.auth.initialize?.()).catch(() => {}); }
        this.notice(error.message || '读取视频账号失败，请重新读取后再试。', 'error'); return false;
      } finally {
        if (input) delete input.password;
        if (operation === this.generation) this.busy = false;
        this.render();
      }
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.close(); this.auth?.removeEventListener('change', this.onChange);
      for (const [node, event, listener] of this.listeners) node.removeEventListener(event, listener);
      this.listeners = [];
    }
  }
  scope.BoatVideoDeviceSettingsPanel = BoatVideoDeviceSettingsPanel;
  if (typeof module === 'object' && module.exports) module.exports = { BoatVideoDeviceSettingsPanel };
})(typeof window === 'object' ? window : globalThis);
