/* 统一账号只保留服务器确认的用户名/角色，密码和会话凭证均不写浏览器存储。 */
(() => {
  'use strict';
  class BoatAccountAuth extends EventTarget {
    constructor(options = {}) {
      super(); this.fetch = options.fetch || window.fetch.bind(window);
      this.enabled = null; this.ready = false; this.user = null; this.busy = false;
      this.generation = 0; this.message = '正在检查账户配置…'; this.pending = null; this.operation = 0;
    }
    get canMonitor() { return this.ready && (this.enabled === false || !!this.user); }
    get canManage() { return this.ready && (this.enabled === false || this.user?.role === 'admin'); }
    state() { return { enabled: this.enabled, ready: this.ready, user: this.user, busy: this.busy,
      canMonitor: this.canMonitor, canManage: this.canManage, generation: this.generation, message: this.message }; }
    notify() { this.dispatchEvent(new CustomEvent('change', { detail: this.state() })); }
    apply(enabled, user) {
      const next = user && typeof user.username === 'string' && ['admin', 'guest'].includes(user.role)
        ? { username: user.username, role: user.role } : null;
      const old = JSON.stringify([this.enabled, this.user]);
      this.enabled = enabled; this.ready = true; this.user = enabled ? next : null;
      if (old !== JSON.stringify([this.enabled, this.user])) this.generation++;
      this.notify();
    }
    async api(path, options = {}) {
      const response = await this.fetch('/api/auth/' + path, { credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(Error(data.error || '账户请求失败（' + response.status + '）'), { status: response.status });
      return data;
    }
    initialize() {
      if (this.pending) return this.pending;
      const operation = this.operation;
      this.pending = (async () => {
        try {
          const config = await this.api('config');
          if (operation !== this.operation) return;
          if (typeof config.enabled !== 'boolean') throw Error('账户配置响应无效，请重试');
          this.message = config.enabled ? '请登录后使用监测平台' : '';
          this.apply(config.enabled, config.user);
        } catch (error) {
          if (operation !== this.operation) return;
          this.enabled = true; this.ready = false; this.user = null; this.generation++;
          this.message = '无法检查账户配置，请重试连接'; this.notify();
        } finally { this.pending = null; }
      })();
      return this.pending;
    }
    whenReady() { return this.pending || (this.ready ? Promise.resolve() : this.initialize()); }
    async login(username, password) {
      if (this.busy) return;
      const operation = ++this.operation;
      this.busy = true; this.message = '正在登录…'; this.notify();
      try {
        // 切换身份之前立即撤销本地权限，迟到的管理员请求不能恢复表单状态。
        if (this.user) { this.apply(true, null); await this.api('session', { method: 'DELETE' }); }
        const result = await this.api('login', { method: 'POST', body: JSON.stringify({ username, password }) });
        if (operation !== this.operation) return;
        if (!result.user || !['admin', 'guest'].includes(result.user.role)) throw Error('账户响应无效，请重新登录');
        this.message = '登录成功'; this.apply(true, result.user);
      } catch (error) { this.message = error.message; this.apply(true, null); throw error; }
      finally { this.busy = false; this.notify(); }
    }
    async logout() {
      if (this.busy) return;
      ++this.operation;
      this.busy = true; this.message = '已退出账户，请重新登录'; this.apply(true, null);
      try { await this.api('session', { method: 'DELETE' }); }
      catch (error) { this.message = '本地权限已清除；退出请求未完成，请重试。'; throw error; }
      finally { this.busy = false; this.notify(); }
    }
    expire() {
      if (this.enabled !== true) return;
      ++this.operation;
      this.message = '账户会话已过期，请重新登录'; this.apply(true, null);
    }
    assertMonitor() { if (!this.canMonitor) throw Error('请先登录监测平台'); }
    assertManage() { if (!this.canManage) throw Error(this.user ? '访客账户仅可监测，设备调参和平台更新需要管理员权限' : '请先使用管理员账户登录'); }
    async verifyManage() {
      this.assertManage();
      if (this.enabled === false) return;
      const generation = this.generation;
      await this.initialize(); this.assertManage();
      if (generation !== this.generation) throw Error('账户身份已变化，请重新操作');
    }
  }
  window.BoatAccountAuth = BoatAccountAuth;
  if (typeof document === 'undefined' || !document.getElementById('accountLoginDialog')) return;
  const $ = id => document.getElementById(id), dialog = $('accountLoginDialog');
  const auth = window.BoatAuth = new BoatAccountAuth();
  function openLogin() {
    $('accountPassword').value = ''; $('accountLoginError').textContent = '';
    if (!dialog.open) dialog.showModal();
    document.documentElement.classList.add('account-modal-open');
    $('accountUsername').focus();
  }
  auth.openLogin = openLogin;
  let firstPrompt = false;
  auth.addEventListener('change', ({ detail: state }) => {
    const accountMode = state.enabled !== false;
    document.documentElement.dataset.accountState = !state.ready ? 'pending' : state.enabled === false ? 'legacy' : state.user?.role || 'anonymous';
    $('accountControls').hidden = !accountMode;
    $('accountLoginOpen').hidden = !!state.user;
    $('accountLogout').hidden = !state.user;
    $('accountName').hidden = !state.user;
    $('accountName').textContent = state.user ? state.user.username + ' · ' + (state.user.role === 'admin' ? '管理员' : '访客') : '';
    $('accountLoginSubmit').disabled = state.busy;
    $('accountUsername').disabled = state.busy; $('accountPassword').disabled = state.busy;
    $('accountLogout').disabled = state.busy;
    $('accountNotice').hidden = !accountMode || (state.ready && !!state.user);
    $('accountNoticeText').textContent = state.message;
    $('accountRetry').hidden = state.ready;
    for (const id of ['settingsToggle', 'sidebarSettings', 'settingsEntry', 'platformSettingsToggle', 'sidebarPlatformSettings', 'updateToggle']) if ($(id)) $(id).hidden = !state.canManage;
    document.querySelector('.settings-callout').hidden = !state.canManage;
    if (!state.canManage) {
      $('settingsDialog').close(); $('platformSettingsDialog')?.close(); $('updateDialog').close();
    }
    if (state.user) dialog.close();
    if (state.ready && state.enabled && !state.user && !firstPrompt) { firstPrompt = true; openLogin(); }
  });
  $('accountLoginOpen').onclick = openLogin;
  $('accountNoticeLogin').onclick = openLogin;
  $('accountLoginClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { $('accountPassword').value = ''; document.documentElement.classList.toggle('account-modal-open', dialog.open); });
  $('accountLoginForm').onsubmit = async event => {
    event.preventDefault(); const username = $('accountUsername').value.trim(), password = $('accountPassword').value;
    $('accountPassword').value = ''; $('accountLoginError').textContent = '';
    try { await auth.login(username, password); } catch (error) { $('accountLoginError').textContent = error.message; }
  };
  $('accountLogout').onclick = () => auth.logout().catch(error => { $('accountNoticeText').textContent = error.message; });
  $('accountRetry').onclick = () => auth.initialize();
  auth.initialize();
  const timer = setInterval(() => { if (auth.enabled !== false && !document.hidden && !auth.busy) auth.initialize(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && auth.enabled !== false && !auth.busy) auth.initialize(); });
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
