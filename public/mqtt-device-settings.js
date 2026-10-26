/* MQTT 设备只读取账号，不回读密码；管理入口与平台登录账户相互独立。 */
(function (scope) {
  'use strict';
  const NAME = /^[A-Za-z0-9_-]{1,64}$/;
  const REVISION = /^[a-f0-9]{64}$/;
  const PASSWORD = /^[\x21-\x39\x3b-\x7e]{8,64}$/;
  const REQUEST_TIMEOUT_MS = 35000;
  const cancelled = () => Object.assign(Error('设备账号请求已取消'), { cancelled: true });

  function validateMqttDeviceForm({ username, password, confirmation }) {
    username = String(username || '').trim();
    if (!NAME.test(username)) throw Error('MQTT 用户名应为 1–64 位英文字母、数字、下划线或短横线。');
    if (typeof password !== 'string' || typeof confirmation !== 'string') throw Error('密码输入无效，请重新填写。');
    if (password && !PASSWORD.test(password)) throw Error('新密码应为 8–64 位可打印 ASCII 字符，不能包含空格、冒号或中文。');
    if (password !== confirmation) throw Error('两次输入的密码不一致，请重新确认。');
    return { username, ...(password ? { password } : {}) };
  }

  class BoatMqttDeviceSettingsPanel {
    constructor(options = {}) {
      this.document = options.document || scope.document;
      this.auth = options.auth || scope.BoatAuth;
      this.fetch = options.fetch || scope.fetch.bind(scope);
      this.confirm = options.confirm || (message => scope.confirm(message));
      this.setTimer = options.setTimeout || scope.setTimeout.bind(scope);
      this.clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
      this.AbortController = options.AbortController || scope.AbortController;
      this.nodes = Object.fromEntries(['mqttDeviceSettings', 'mqttDeviceAccess', 'mqttDeviceContent',
        'mqttDeviceList', 'mqttDeviceCount', 'mqttDeviceRead', 'mqttDeviceForm', 'mqttDeviceId',
        'mqttDeviceUsername', 'mqttDevicePassword', 'mqttDevicePasswordConfirm', 'mqttDeviceSave',
        'mqttDeviceCancel', 'mqttDeviceStatus', 'mqttDevicePasswordHint'].map(id => [id, this.document.getElementById(id)]));
      this.devices = []; this.revision = ''; this.editingId = null; this.creating = false; this.canCreate = false;
      this.busy = false; this.loaded = false; this.isOpen = false; this.available = null;
      this.denied = false; this.destroyed = false; this.operation = 0;
      this.identity = this._identity(); this._listeners = [];
      const add = this.document.createElement('button'); add.type = 'button'; add.id = 'mqttDeviceAdd'; add.className = 'subtle mqtt-device-add'; add.textContent = '新增无人船';
      (this.nodes.mqttDeviceRead.parentElement || this.nodes.mqttDeviceContent).append(add); this.nodes.mqttDeviceAdd = add;
      this._listen(add, 'click', () => this.beginCreate());
      this._listen(this.nodes.mqttDeviceRead, 'click', () => this.read());
      this._listen(this.nodes.mqttDeviceCancel, 'click', () => this.cancelEdit());
      this._listen(this.nodes.mqttDeviceForm, 'submit', event => { event.preventDefault(); this.save(); });
      this._accountChanged = () => {
        const identity = this._identity();
        if (identity !== this.identity) { this.identity = identity; this.denied = false; this._reset(); }
        this._renderAccess();
      };
      this.auth?.addEventListener('change', this._accountChanged);
      this._clearEditor(); this._renderList(); this._renderAccess();
    }

    _listen(node, event, callback) { node.addEventListener(event, callback); this._listeners.push([node, event, callback]); }
    _identity() { return JSON.stringify([this.auth?.generation, this.auth?.ready, this.auth?.enabled, this.auth?.user?.username, this.auth?.user?.role]); }
    _isAdmin() { return !this.destroyed && this.auth?.ready === true && this.auth.enabled === true && this.auth.user?.role === 'admin'; }
    _canManage() { return this._isAdmin() && !this.denied; }
    _notice(message, tone = 'neutral') { this.nodes.mqttDeviceStatus.textContent = message; this.nodes.mqttDeviceStatus.dataset.tone = tone; }
    _clearPasswords() { this.nodes.mqttDevicePassword.value = ''; this.nodes.mqttDevicePasswordConfirm.value = ''; }
    _clearEditor() {
      this.editingId = null; this.creating = false; this._clearPasswords();
      this.nodes.mqttDeviceId.value = ''; this.nodes.mqttDeviceUsername.value = ''; this.nodes.mqttDeviceForm.hidden = true;
      this.nodes.mqttDeviceId.readOnly = true;
      this.nodes.mqttDevicePassword.required = false; this.nodes.mqttDevicePasswordConfirm.required = false;
    }
    _reset() {
      ++this.operation; this._cancel?.(); this.busy = false;
      this.loaded = false; this.available = null; this.canCreate = false; this.devices = []; this.revision = ''; this._clearEditor(); this._renderList();
      this._notice('读取服务器上的 MQTT 设备账号；密码不会返回到网页。');
    }
    _renderAccess() {
      const admin = this._canManage(), n = this.nodes;
      // 未启用统一登录、游客和未登录身份均不能看到设备账号管理入口。
      n.mqttDeviceSettings.hidden = !this._isAdmin();
      n.mqttDeviceContent.hidden = !admin;
      n.mqttDeviceAccess.hidden = !this.denied;
      n.mqttDeviceAccess.textContent = this.denied ? '服务器未授权此账户管理 MQTT 设备，请重新登录后再试。' : '';
      n.mqttDeviceRead.disabled = !admin || this.busy;
      n.mqttDeviceId.readOnly = !this.creating;
      n.mqttDeviceId.required = this.creating;
      n.mqttDeviceId.maxLength = 64;
      n.mqttDeviceId.pattern = '[A-Za-z0-9_\\-]{1,64}';
      for (const input of [n.mqttDeviceId, n.mqttDeviceUsername, n.mqttDevicePassword, n.mqttDevicePasswordConfirm]) input.disabled = !admin || this.busy;
      n.mqttDeviceSave.disabled = !admin || this.busy || !this.loaded || this.available !== true;
      n.mqttDeviceCancel.disabled = this.busy;
      n.mqttDeviceSave.textContent = this.busy ? '正在处理…' : this.creating ? '添加无人船' : '保存设备账号';
      n.mqttDeviceAdd.disabled = !admin || this.busy || !this.loaded || this.available !== true || !this.canCreate || this.devices.length >= 64;
      n.mqttDeviceAdd.title = this.canCreate ? '为新船创建独立 ID、MQTT 账号与自身主题权限，最多 64 艘' : '请先读取设备；旧版管理组件需按 README 重新安装以支持新增无人船';
      n.mqttDevicePassword.required = this.creating; n.mqttDevicePasswordConfirm.required = this.creating;
      n.mqttDevicePassword.placeholder = this.creating ? '新增设备必须设置密码' : '留空可保留原密码';
      n.mqttDevicePasswordHint.textContent = this.creating ? '新增船必须设置接入密码并再次确认。密码为 8–64 位可打印 ASCII 字符，不能包含空格、冒号或中文；不会保存到浏览器或显示原文。' : '旧密码不会回显。新密码为 8–64 位可打印 ASCII 字符，不能包含空格、冒号或中文；不改密码时两项均留空。';
      n.mqttDeviceForm.querySelector?.('h4')?.replaceChildren(this.creating ? '新增无人船接入账号' : '修改设备接入凭据');
      const reconnectNote = n.mqttDeviceForm.querySelector?.('.mqtt-device-reconnect-notice');
      if (reconnectNote) reconnectNote.textContent = this.creating ? '添加会重启 MQTT 服务，所有设备和网页云端通道会短暂重连。请将新船的独立设备 ID、MQTT 用户名和密码填入 STM32 的本地网络配置并重新烧录。' : '保存会重启 MQTT 服务，所有设备和网页云端通道会短暂重连。请同步更新该船 STM32 的 MQTT 用户名/密码并重新烧录，确保设备能用新凭据连接。';
      const idHint = n.mqttDeviceId.parentElement?.querySelector('small');
      if (idHint) idHint.textContent = this.creating ? '新船使用独立 ID，对应 boats/设备ID/…；每艘船必须不同。' : '对应 boats/设备ID/… 主题，保持不变。';
      n.mqttDeviceContent.setAttribute('aria-busy', String(this.busy));
      for (const button of n.mqttDeviceList.querySelectorAll('button')) button.disabled = !admin || this.busy;
    }
    _renderList() {
      const n = this.nodes, rows = [];
      n.mqttDeviceCount.textContent = this.available === false ? '管理组件未启用' : this.loaded ? this.devices.length + ' 个已配置设备' : '尚未读取';
      for (const device of this.devices) {
        const row = this.document.createElement('li'); row.className = 'mqtt-device-row';
        const detail = this.document.createElement('div'); detail.className = 'mqtt-device-identity';
        const name = this.document.createElement('strong'); name.textContent = device.deviceId;
        const account = this.document.createElement('span'); account.textContent = 'MQTT 账号 · ' + device.username;
        detail.append(name, account);
        const edit = this.document.createElement('button'); edit.type = 'button'; edit.className = 'small-button';
        edit.textContent = '修改账号'; edit.setAttribute('aria-label', '修改设备 ' + device.deviceId + ' 的 MQTT 账号');
        edit.addEventListener('click', () => this.edit(device.deviceId)); row.append(detail, edit); rows.push(row);
      }
      n.mqttDeviceList.replaceChildren(...rows); n.mqttDeviceList.hidden = !this.loaded || this.available !== true;
    }
    open() {
      this.isOpen = true; this._renderAccess();
      if (!this._canManage() || this.busy || this.loaded) return Promise.resolve(false);
      return this.read();
    }
    close() { this.isOpen = false; this._reset(); this._renderAccess(); }
    read() {
      if (!this.isOpen || !this._canManage() || this.busy) return Promise.resolve(false);
      this._clearEditor(); return this._run('GET', '/api/mqtt/devices');
    }
    edit(id) {
      if (!this.isOpen || !this._canManage() || this.busy || !this.loaded || this.available !== true) return false;
      const device = this.devices.find(item => item.deviceId === id); if (!device) return false;
      this._clearEditor(); this.editingId = id; this.nodes.mqttDeviceId.value = id; this.nodes.mqttDeviceUsername.value = device.username;
      this.nodes.mqttDeviceForm.hidden = false; this._renderAccess(); this.nodes.mqttDeviceUsername.focus();
      this._notice('设备 ID 保持不变。可以修改 MQTT 账号或重设密码；两项密码留空可保留原密码。'); return true;
    }
    beginCreate() {
      if (!this.isOpen || !this._canManage() || this.busy || !this.loaded || this.available !== true) return false;
      if (!this.canCreate) { this._notice('管理组件版本较旧，请按 README 重新运行 maintenance/install-mqtt-device-admin.sh 后添加无人船。', 'error'); return false; }
      if (this.devices.length >= 64) { this._notice('平台最多支持 64 艘无人船。', 'error'); return false; }
      this._clearEditor(); this.creating = true;
      this.nodes.mqttDeviceForm.hidden = false; this._renderAccess(); this.nodes.mqttDeviceId.focus();
      this._notice('为新船设置独立设备 ID、MQTT 账号和密码。保存后将这三项填入该船 STM32 的本地网络配置，重新编译烧录。'); return true;
    }
    cancelEdit() { if (this.busy) return false; this._clearEditor(); this._notice('已取消编辑。'); return true; }
    save() {
      if (!this.isOpen || !this._canManage() || this.busy || !this.loaded || this.available !== true || this.nodes.mqttDeviceForm.hidden) return Promise.resolve(false);
      let input;
      try { input = validateMqttDeviceForm({ username: this.nodes.mqttDeviceUsername.value,
        password: this.nodes.mqttDevicePassword.value, confirmation: this.nodes.mqttDevicePasswordConfirm.value }); }
      catch (error) { this._clearPasswords(); this._notice(error.message, 'error'); return Promise.resolve(false); }
      this._clearPasswords();
      if (this.creating) {
        const deviceId = this.nodes.mqttDeviceId.value.trim();
        if (!NAME.test(deviceId) || !input.password || !this.canCreate || this.devices.length >= 64) { delete input.password; this._notice('请填写独立的 1–64 位设备 ID 和必填密码；最多支持 64 艘无人船。', 'error'); return Promise.resolve(false); }
        if (this.devices.some(device => device.deviceId === deviceId || device.username === input.username)) { delete input.password; this._notice('设备 ID 或 MQTT 账号已存在，请使用每艘船独立的 ID 和账号。', 'error'); return Promise.resolve(false); }
        if (!this.confirm('确认新增无人船“' + deviceId + '”？\n\nMQTT 账号：' + input.username + '\n设备仅有自身主题权限，不改变已有船的账号。\n\n服务器将重启 MQTT 服务，所有设备和网页云端通道会短暂重连。请将设备 ID、用户名和所设置密码填入新船 STM32 的 boat_network_local.h 并重新编译烧录。')) { delete input.password; this._notice('已取消添加，服务器配置未更改。'); return Promise.resolve(false); }
        input.deviceId = deviceId; input.revision = this.revision;
        return this._run('POST', '/api/mqtt/devices', input);
      }
      const device = this.devices.find(item => item.deviceId === this.editingId);
      if (!device || input.username === device.username && !input.password) { delete input.password; this._notice('没有需要保存的修改。'); return Promise.resolve(false); }
      const message = '确认修改设备“' + device.deviceId + '”的 MQTT 接入账号？\n\n' +
        '账号：' + device.username + ' → ' + input.username + '\n密码：' + (input.password ? '设置新密码' : '保留原密码') +
        '\n\n服务器将重启 MQTT 服务，所有设备和网页云端通道会短暂重连。请同步修改该船 STM32 的 MQTT 用户名/密码并重新烧录，设备才能使用新凭据连接。设备 ID 和主题不变。';
      if (!this.confirm(message)) { delete input.password; this._notice('已取消保存，服务器配置未更改。'); return Promise.resolve(false); }
      input.revision = this.revision;
      return this._run('PATCH', '/api/mqtt/devices/' + encodeURIComponent(device.deviceId), input);
    }
    _current(operation, generation) { return operation === this.operation && generation === this.auth?.generation && this.isOpen && this._canManage(); }
    _request(method, path, input, operation, generation) {
      return new Promise((resolve, reject) => {
        const controller = this.AbortController ? new this.AbortController() : null;
        let settled = false;
        const finish = (error, data) => {
          if (settled) return; settled = true; this.clearTimer(timer); if (input) delete input.password;
          if (this._cancel === cancel) this._cancel = null;
          if (error) reject(error); else resolve(data);
        };
        const cancel = () => { finish(cancelled()); controller?.abort(); };
        const timer = this.setTimer(() => {
          finish(Object.assign(Error(method === 'GET' ? '设备账号读取超时，请重新读取。' : '保存响应超时，结果尚未确认；请重新读取设备账号确认后再操作。'), { timeout: true })); controller?.abort();
        }, REQUEST_TIMEOUT_MS);
        this._cancel = cancel;
        Promise.resolve().then(async () => {
          await this.auth.verifyManage();
          if (settled || !this._current(operation, generation)) throw cancelled();
          let body = input ? JSON.stringify(input) : undefined;
          if (input) delete input.password;
          const request = this.fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body } : {}), ...(controller ? { signal: controller.signal } : {}) });
          body = undefined;
          const response = await request, data = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(Error(String(data.error || '设备账号请求失败（HTTP ' + response.status + '）').slice(0, 300)), { status: response.status });
          return data;
        }).then(data => finish(null, data), error => finish(error));
      });
    }
    _applyList(data) {
      if (!data || !Array.isArray(data.devices) || data.devices.length > 64 || typeof data.revision !== 'string' || !REVISION.test(data.revision)) throw Error('设备账号响应无效，请重新读取。');
      const ids = new Set(), names = new Set();
      const devices = data.devices.map(device => {
        if (!device || typeof device.deviceId !== 'string' || typeof device.username !== 'string' || !NAME.test(device.deviceId) || !NAME.test(device.username) || ids.has(device.deviceId) || names.has(device.username)) throw Error('设备账号响应无效，请重新读取。');
        ids.add(device.deviceId); names.add(device.username); return { deviceId: device.deviceId, username: device.username };
      });
      this.devices = devices; this.revision = data.revision; this.canCreate = data.canCreate === true; this.loaded = true; this.available = true; this._renderList();
    }
    async _run(method, path, input) {
      if (!this.isOpen || !this._canManage() || this.busy) { if (input) delete input.password; return false; }
      const operation = ++this.operation, generation = this.auth.generation;
      this.busy = true; this._notice(method === 'GET' ? '正在读取 MQTT 设备账号…' : '正在保存设备账号并重启 MQTT 服务，请稍候…'); this._renderAccess();
      try {
        const data = await this._request(method, path, input, operation, generation);
        if (!this._current(operation, generation)) return false;
        if (method === 'GET' && data?.enabled === false) {
          this.available = false; this.loaded = false; this.devices = []; this.revision = ''; this._renderList();
          this._notice('服务器尚未启用 MQTT 设备账号管理组件。请按 README 的“MQTT 设备账号管理”步骤由服务器管理员启用一次，再重新读取。'); return true;
        }
        if (method !== 'GET' && (data?.ok !== true || data.requiresReconnect !== true)) throw Error('保存响应无效，结果尚未确认；请重新读取设备账号。');
        this._applyList(data); this._clearEditor();
        this._notice(method === 'GET' ? (this.devices.length ? '已读取已配置设备。密码不会回显；设备离线也可修改账号。' : '服务器没有可管理的设备账号。') + (this.canCreate ? ' 可新增无人船，每艘船须使用独立设备 ID。' : ' 新增船需要更新管理组件：按 README 重新运行 maintenance/install-mqtt-device-admin.sh。') : method === 'POST' ? '无人船接入账号已添加，MQTT 服务已重启。请设置新船 STM32 的 BOAT_MQTT_DEVICE_ID、BOAT_MQTT_USERNAME 和所设置密码，重新编译烧录；收到遥测后会自动出现在船队总览中。' : '设备账号已保存，MQTT 服务已重启。请将该船 STM32 的 MQTT 用户名/密码改为新值并重新烧录，等待设备重新连接。', method === 'GET' ? 'neutral' : 'success');
        return true;
      } catch (error) {
        if (error.cancelled || operation !== this.operation || this.destroyed) return false;
        this.loaded = false; this.devices = []; this.revision = ''; this._clearEditor(); this._renderList();
        if (error.status === 401) { this.auth.expire?.(); this.auth.openLogin?.(); }
        if (error.status === 403) { this.denied = true; Promise.resolve(this.auth.initialize?.()).catch(() => {}); }
        this._notice(error.message || '设备账号请求失败，请重新读取后再试。', 'error'); return false;
      } finally { if (input) delete input.password; if (operation === this.operation) this.busy = false; this._renderAccess(); }
    }
    destroy() {
      if (this.destroyed) return; this.destroyed = true; this.close(); this.auth?.removeEventListener('change', this._accountChanged);
      for (const [node, event, callback] of this._listeners) node.removeEventListener(event, callback); this._listeners = [];
    }
  }
  scope.BoatMqttDeviceSettingsPanel = BoatMqttDeviceSettingsPanel;
  if (typeof module === 'object' && module.exports) module.exports = { BoatMqttDeviceSettingsPanel, validateMqttDeviceForm };
})(typeof window === 'object' ? window : globalThis);
