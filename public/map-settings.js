/* 平台地图凭据仅提交到服务器；不写浏览器存储，也不进入设备参数通信。 */
(function (scope) {
  'use strict';

  const REQUEST_TIMEOUT_MS = 10000;
  const KEY_PATTERN = /^[a-f\d]{32}$/i;

  function validateMapCredentials(key, securityJsCode) {
    key = String(key || '').trim();
    securityJsCode = String(securityJsCode || '').trim();
    if (!key && !securityJsCode) return { key, securityJsCode };
    if (!key || !securityJsCode) throw Error('Key 与安全密钥必须一起填写；停用高德时请将两项一起清空。');
    if (!KEY_PATTERN.test(key) || !KEY_PATTERN.test(securityJsCode)) {
      throw Error('Key 和安全密钥都应为 32 位十六进制字符，请核对高德控制台中的 Web端（JS API）凭据。');
    }
    return { key, securityJsCode };
  }

  function validateTiandituKey(value) {
    const key = String(value || '').trim();
    if (key && !KEY_PATTERN.test(key)) throw Error('天地图浏览器端 Key 应为 32 位十六进制字符；不使用天地图时可留空。');
    return key;
  }

  function cancelled() { return Object.assign(Error('地图设置请求已取消'), { cancelled: true }); }

  class BoatMapSettingsPanel {
    constructor(options = {}) {
      this.document = options.document || scope.document;
      this.auth = options.auth || scope.BoatAuth;
      this.fetch = options.fetch || scope.fetch.bind(scope);
      this.setTimer = options.setTimeout || scope.setTimeout.bind(scope);
      this.clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
      this.reload = options.reload || (() => scope.location.reload());
      this.AbortController = options.AbortController || scope.AbortController;
      this.nodes = Object.fromEntries(['mapSettings', 'mapSettingsAccess', 'mapSettingsForm', 'amapKey',
        'amapSecurityCode', 'tiandituKey', 'mapSettingsSource', 'mapSettingsRead', 'mapSettingsSave', 'mapSettingsReload',
        'mapSettingsStatus', 'mapSettingsRefreshNote'].map(id => [id, this.document.getElementById(id)]));
      this.busy = false;
      this.loaded = false;
      this.dirty = false;
      this.needsRefresh = false;
      this.operation = 0;
      this.denied = false;
      this.destroyed = false;
      this.identity = this._identity();
      this._authChange = () => this._accountChanged();
      this.auth?.addEventListener('change', this._authChange);
      this._input = () => {
        this.dirty = true;
        this._notice(this.needsRefresh ? '有未保存的修改；刷新只会应用服务器已经保存的配置。' : '配置尚未保存。高德两项可一起清空，天地图 Key 可独立清空；ArcGIS 无需填写 Key。');
      };
      this.nodes.amapKey.addEventListener('input', this._input);
      this.nodes.amapSecurityCode.addEventListener('input', this._input);
      this.nodes.tiandituKey.addEventListener('input', this._input);
      this.nodes.mapSettingsForm.addEventListener('submit', event => { event.preventDefault(); this.save(); });
      this.nodes.mapSettingsRead.addEventListener('click', () => this.read());
      this.nodes.mapSettingsReload.addEventListener('click', () => {
        if (this.needsRefresh && this._canManage() && !this.busy) this.reload();
      });
      this._renderAccess();
    }

    _identity() {
      const auth = this.auth;
      return JSON.stringify([auth?.generation, auth?.ready, auth?.enabled, auth?.user?.username, auth?.user?.role]);
    }

    _canManage() {
      return !this.destroyed && !this.denied && this.auth?.ready === true &&
        this.auth.enabled === true && this.auth.user?.role === 'admin';
    }

    _accountChanged() {
      const identity = this._identity();
      if (this.identity !== identity) {
        this.identity = identity;
        this.denied = false;
        this._clear();
      } else if (!this._canManage()) this._clear();
      this._renderAccess();
      // 设置窗口已打开时登录管理员，可立即读取；普通账户状态轮询不会覆盖输入。
      if (this._canManage() && this.document.getElementById('platformSettingsDialog')?.open && !this.loaded && !this.busy) this.open();
    }

    _clear() {
      ++this.operation;
      this._cancel?.();
      this.busy = false;
      this.loaded = false;
      this.dirty = false;
      this.needsRefresh = false;
      this.nodes.amapKey.value = '';
      this.nodes.amapSecurityCode.value = '';
      this.nodes.tiandituKey.value = '';
      this.nodes.mapSettingsSource.textContent = '尚未读取';
      this._notice('尚未读取平台地图配置。');
    }

    _notice(message, tone = 'neutral') {
      this.nodes.mapSettingsStatus.textContent = message;
      this.nodes.mapSettingsStatus.dataset.tone = tone;
    }

    _renderAccess() {
      const admin = this._canManage(), legacy = this.auth?.ready === true && this.auth.enabled === false;
      const n = this.nodes;
      n.mapSettings.hidden = !admin && !legacy && !this.denied;
      n.mapSettingsForm.hidden = !admin;
      n.mapSettingsAccess.hidden = admin;
      n.mapSettingsAccess.textContent = legacy
        ? '当前未启用平台账户，网页中不能保存地图配置。服务器环境变量配置仍然可用；启用平台账户并以管理员登录后，可在这里管理。'
        : this.denied ? '服务器未授权此管理员操作，请重新登录后再试。已清除本页中的地图凭据。' : '平台地图设置仅供已登录的管理员使用。';
      for (const input of [n.amapKey, n.amapSecurityCode, n.tiandituKey]) input.disabled = !admin || this.busy;
      n.mapSettingsRead.disabled = !admin || this.busy;
      n.mapSettingsSave.disabled = !admin || this.busy || !this.loaded;
      n.mapSettingsSave.textContent = this.busy ? '正在处理…' : '保存地图配置';
      n.mapSettingsReload.hidden = !admin || !this.needsRefresh;
      n.mapSettingsReload.disabled = this.busy;
      n.mapSettingsRefreshNote.hidden = !admin || !this.needsRefresh;
      n.mapSettingsForm.setAttribute('aria-busy', String(this.busy));
    }

    open() {
      this._renderAccess();
      if (!this._canManage() || this.loaded || this.dirty || this.busy) return Promise.resolve(false);
      return this.read();
    }

    read() { return this._run('GET'); }

    close() {
      const needsRefresh=this.needsRefresh;
      this._clear();this.needsRefresh=needsRefresh;this._renderAccess();
    }

    save() {
      if (!this._canManage() || this.busy || !this.loaded) return Promise.resolve(false);
      let credentials;
      try { credentials = { ...validateMapCredentials(this.nodes.amapKey.value, this.nodes.amapSecurityCode.value),
        tiandituKey: validateTiandituKey(this.nodes.tiandituKey.value) }; }
      catch (error) { this._notice(error.message, 'error'); return Promise.resolve(false); }
      return this._run('PUT', credentials);
    }

    _current(operation, generation) {
      return operation === this.operation && generation === this.auth?.generation && this._canManage();
    }

    _request(method, body, operation, generation) {
      return new Promise((resolve, reject) => {
        const controller = this.AbortController ? new this.AbortController() : null;
        let settled = false;
        const finish = (error, data) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          if (this._cancel === cancel) this._cancel = null;
          if (error) reject(error); else resolve(data);
        };
        const cancel = () => { finish(cancelled()); controller?.abort(); };
        const timer = this.setTimer(() => {
          finish(Object.assign(Error('地图设置请求超时，结果尚未确认；请重新读取配置后再操作。'), { timeout: true }));
          controller?.abort();
        }, REQUEST_TIMEOUT_MS);
        this._cancel = cancel;
        Promise.resolve().then(async () => {
          // legacy 的 verifyManage 允许设备调参，因此这里还需严格的平台管理员检查。
          await this.auth.verifyManage();
          if (settled || !this._current(operation, generation)) throw cancelled();
          const response = await this.fetch('/api/map/settings', {
            method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}), ...(controller ? { signal: controller.signal } : {})
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(Error(String(data.error || '地图设置请求失败（HTTP ' + response.status + '）').slice(0, 300)), { status: response.status });
          return data;
        }).then(data => finish(null, data), error => finish(error));
      });
    }

    _applyData(data) {
      const sources = { saved: '服务器保存的配置', environment: '服务器环境变量', none: '尚未配置' };
      if (!data || typeof data.configured !== 'boolean' || !Object.hasOwn(sources, data.source) ||
          typeof data.key !== 'string' || typeof data.securityJsCode !== 'string' ||
          (data.key && !KEY_PATTERN.test(data.key)) || (data.securityJsCode && !KEY_PATTERN.test(data.securityJsCode))) {
        throw Error('地图设置响应格式错误，请重新读取。');
      }
      if (data.configured && (!data.key || !data.securityJsCode)) throw Error('服务器返回的地图配置不完整，请重新读取。');
      const tiandituKey = data.tianditu?.key ?? '';
      if (typeof tiandituKey !== 'string' || (tiandituKey && !KEY_PATTERN.test(tiandituKey)) ||
          (data.tianditu?.configured === true && !tiandituKey)) throw Error('服务器返回的天地图配置不完整，请重新读取。');
      this.nodes.amapKey.value = data.key;
      this.nodes.amapSecurityCode.value = data.securityJsCode;
      this.nodes.tiandituKey.value = tiandituKey;
      this.nodes.mapSettingsSource.textContent = sources[data.source] + (data.configured ? ' · 高德已配置' : ' · 平面图使用 OSM') +
        (tiandituKey ? ' · 天地图已配置' : ' · 天地图未配置') + ' · ArcGIS 可用';
      this.loaded = true;
      this.dirty = false;
    }

    async _run(method, credentials) {
      if (!this._canManage() || this.busy) return false;
      const operation = ++this.operation, generation = this.auth.generation;
      this.busy = true;
      this._notice(method === 'GET' ? '正在读取服务器地图配置…' : '正在保存服务器地图配置…');
      this._renderAccess();
      try {
        const data = await this._request(method, credentials, operation, generation);
        if (!this._current(operation, generation)) return false;
        this._applyData(data);
        if (method === 'PUT') {
          this.needsRefresh = true;
          this._notice((data.configured ? '地图配置已保存。' : '已停用高德，平面图使用 OpenStreetMap。') +
            '点击“刷新页面应用”加载新配置；地图内可切换平面 / 卫星以及影像来源。', 'success');
        } else this._notice('已读取地图配置。高德与天地图可分别配置；ArcGIS 卫星图无需 Key。修改后保存，再刷新页面应用。');
        return true;
      } catch (error) {
        if (error.cancelled || operation !== this.operation || this.destroyed) return false;
        if (error.status === 401 || error.status === 403) {
          this._clear();
          if (error.status === 401) this.auth.expire?.();
          else {
            this.denied = true;
            Promise.resolve(this.auth.initialize?.()).catch(() => {});
          }
        }
        this._notice(error.message || '暂时无法连接地图设置服务，请稍后重试。', 'error');
        return false;
      } finally {
        if (operation === this.operation) this.busy = false;
        this._renderAccess();
      }
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this._clear();
      this.auth?.removeEventListener('change', this._authChange);
      this.nodes.amapKey.removeEventListener('input', this._input);
      this.nodes.amapSecurityCode.removeEventListener('input', this._input);
      this.nodes.tiandituKey.removeEventListener('input', this._input);
      this._renderAccess();
    }
  }

  scope.BoatMapSettingsPanel = BoatMapSettingsPanel;
  if (typeof module === 'object' && module.exports) module.exports = { BoatMapSettingsPanel, validateMapCredentials, validateTiandituKey };
})(typeof window === 'object' ? window : globalThis);
