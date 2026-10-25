/* 平台账户仅在服务器保存；此面板不持久化密码，也不参与无人船参数通信。 */
(function (scope) {
  'use strict';
  const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
  const USER_ID = /^[A-Za-z0-9_-]{1,80}$/;
  const REQUEST_TIMEOUT_MS = 12000;
  const cancelled = () => Object.assign(Error('用户管理请求已取消'), { cancelled: true });

  function validateUserForm({ username, role, password, confirmation }, creating) {
    username = String(username || '').trim();
    if (!USERNAME.test(username)) throw Error('用户名应为 1–64 位英文字母、数字、下划线、点或短横线。');
    if (!['admin', 'guest'].includes(role)) throw Error('请选择管理员或访客角色。');
    if (typeof password !== 'string' || typeof confirmation !== 'string') throw Error('密码输入无效，请重新填写。');
    if (creating && !password) throw Error('请为新用户设置密码。');
    if (password && (password.length < 6 || password.length > 256)) throw Error('密码应为 6–256 个字符，空格会原样保留。');
    if (password !== confirmation) throw Error('两次输入的密码不一致，请重新确认。');
    return { username, role, ...(password ? { password } : {}) };
  }

  class BoatUserManagementPanel {
    constructor(options = {}) {
      this.document = options.document || scope.document;
      this.auth = options.auth || scope.BoatAuth;
      this.fetch = options.fetch || scope.fetch.bind(scope);
      this.toast = options.toast || (() => {});
      this.setTimer = options.setTimeout || scope.setTimeout.bind(scope);
      this.clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
      this.AbortController = options.AbortController || scope.AbortController;
      this.nodes = Object.fromEntries(['userManagement', 'userManagementAccess', 'userManagementContent',
        'userManagementList', 'userManagementCount', 'userManagementRead', 'userManagementCreate',
        'userManagementForm', 'userEditorTitle', 'userUsername', 'userRole', 'userPassword',
        'userPasswordConfirm', 'userPasswordHint', 'userSelfNotice', 'userManagementSave',
        'userManagementCancel', 'userManagementStatus'].map(id => [id, this.document.getElementById(id)]));
      this.users = []; this.currentUserId = ''; this.editingId = null;
      this.busy = false; this.loaded = false; this.isOpen = false;
      this.denied = false; this.destroyed = false; this.operation = 0;
      this.identity = this._identity();
      this._listeners = [];
      this._listen(this.nodes.userManagementRead, 'click', () => this.read());
      this._listen(this.nodes.userManagementCreate, 'click', () => this.create());
      this._listen(this.nodes.userManagementCancel, 'click', () => this.cancelEdit());
      this._listen(this.nodes.userManagementForm, 'submit', event => { event.preventDefault(); this.save(); });
      this._accountChanged = () => {
        const identity = this._identity();
        if (identity !== this.identity) {
          this.identity = identity; this.denied = false; this._reset();
        }
        this._renderAccess();
      };
      this.auth?.addEventListener('change', this._accountChanged);
      this._clearEditor(); this._renderList(); this._renderAccess();
    }

    _listen(node, event, callback) {
      node.addEventListener(event, callback); this._listeners.push([node, event, callback]);
    }
    _identity() { return JSON.stringify([this.auth?.generation, this.auth?.ready, this.auth?.enabled, this.auth?.user?.username, this.auth?.user?.role]); }
    _canManage() { return !this.destroyed && !this.denied && this.auth?.ready === true && this.auth.enabled === true && this.auth.user?.role === 'admin'; }
    _notice(message, tone = 'neutral') {
      this.nodes.userManagementStatus.textContent = message;
      this.nodes.userManagementStatus.dataset.tone = tone;
    }
    _clearPasswords() { this.nodes.userPassword.value = ''; this.nodes.userPasswordConfirm.value = ''; }
    _clearEditor() {
      this.editingId = null; this._clearPasswords();
      this.nodes.userUsername.value = ''; this.nodes.userRole.value = 'guest';
      this.nodes.userManagementForm.hidden = true; this.nodes.userSelfNotice.hidden = true;
    }
    _reset() {
      ++this.operation; this._cancel?.(); this.busy = false;
      this.loaded = false; this.users = []; this.currentUserId = ''; this._clearEditor(); this._renderList();
      this._notice('点击“重新读取”查看服务器用户。');
    }
    _renderAccess() {
      const admin = this._canManage(), n = this.nodes;
      const legacy = this.auth?.ready === true && this.auth.enabled === false;
      n.userManagement.hidden = !admin && !legacy && !this.denied;
      n.userManagementContent.hidden = !admin;
      n.userManagementAccess.hidden = admin;
      n.userManagementAccess.textContent = legacy
        ? '当前未启用统一账户登录。请先在服务器启用管理员/访客账户，再登录管理员管理用户。'
        : this.denied ? '服务器未授权此账户管理用户，请重新登录。' : '用户管理仅供已登录的管理员使用。';
      n.userManagementRead.disabled = !admin || this.busy;
      n.userManagementCreate.disabled = !admin || this.busy || !this.loaded || this.users.length >= 64;
      for (const input of [n.userUsername, n.userRole, n.userPassword, n.userPasswordConfirm]) input.disabled = !admin || this.busy;
      n.userManagementSave.disabled = !admin || this.busy || !this.loaded;
      n.userManagementCancel.disabled = this.busy;
      n.userManagementSave.textContent = this.busy ? '正在处理…' : '保存用户';
      n.userManagementContent.setAttribute('aria-busy', String(this.busy));
      for (const button of n.userManagementList.querySelectorAll('button')) button.disabled = !admin || this.busy;
    }
    _renderList() {
      const n = this.nodes, rows = [];
      n.userManagementCount.textContent = this.loaded ? this.users.length + ' / 64 位用户' : '尚未读取';
      for (const user of this.users) {
        const row = this.document.createElement('li'); row.className = 'user-management-row';
        const detail = this.document.createElement('div'); detail.className = 'user-management-identity';
        const name = this.document.createElement('strong'); name.textContent = user.username;
        const meta = this.document.createElement('div'); meta.className = 'user-management-meta';
        const role = this.document.createElement('span'); role.className = 'user-management-role';
        role.dataset.role = user.role; role.textContent = user.role === 'admin' ? '管理员' : '访客'; meta.append(role);
        if (user.id === this.currentUserId) {
          const current = this.document.createElement('span'); current.className = 'user-management-current'; current.textContent = '当前账户'; meta.append(current);
        }
        detail.append(name, meta);
        const edit = this.document.createElement('button'); edit.type = 'button'; edit.className = 'small-button';
        edit.textContent = '编辑'; edit.setAttribute('aria-label', '编辑用户 ' + user.username);
        edit.addEventListener('click', () => this.edit(user.id)); row.append(detail, edit); rows.push(row);
      }
      n.userManagementList.replaceChildren(...rows);
      n.userManagementList.hidden = !this.loaded;
    }
    open() {
      this.isOpen = true; this._renderAccess();
      if (!this._canManage() || this.busy || this.loaded) return Promise.resolve(false);
      return this.read();
    }
    close() { this.isOpen = false; this._reset(); this._renderAccess(); }
    read() {
      if (!this.isOpen || !this._canManage() || this.busy) return Promise.resolve(false);
      this._clearEditor(); return this._run('GET', '/api/auth/users');
    }
    create() {
      if (!this.isOpen || !this._canManage() || this.busy || !this.loaded || this.users.length >= 64) return false;
      this._clearEditor(); this.nodes.userEditorTitle.textContent = '新建用户';
      this.nodes.userPasswordHint.textContent = '设置 6–256 个字符的密码，空格原样保留。';
      this.nodes.userPassword.required = true; this.nodes.userPasswordConfirm.required = true;
      this.nodes.userManagementForm.hidden = false; this.nodes.userUsername.focus();
      this._notice('填写新用户的登录名、角色与密码后保存。'); return true;
    }
    edit(id) {
      if (!this.isOpen || !this._canManage() || this.busy || !this.loaded) return false;
      const user = this.users.find(item => item.id === id); if (!user) return false;
      this._clearEditor(); this.editingId = id;
      this.nodes.userEditorTitle.textContent = '编辑用户'; this.nodes.userUsername.value = user.username; this.nodes.userRole.value = user.role;
      this.nodes.userPasswordHint.textContent = '不修改密码时两项均留空；新密码为 6–256 个字符。';
      this.nodes.userPassword.required = false; this.nodes.userPasswordConfirm.required = false;
      this.nodes.userSelfNotice.hidden = id !== this.currentUserId;
      this.nodes.userManagementForm.hidden = false; this.nodes.userUsername.focus();
      this._notice('可以修改用户名、角色或重设密码；至少保留一位管理员。'); return true;
    }
    cancelEdit() { if (this.busy) return false; this._clearEditor(); this._notice('已取消编辑。'); return true; }
    save() {
      if (!this.isOpen || !this._canManage() || this.busy || !this.loaded || this.nodes.userManagementForm.hidden) return Promise.resolve(false);
      let input;
      try { input = validateUserForm({ username: this.nodes.userUsername.value, role: this.nodes.userRole.value,
        password: this.nodes.userPassword.value, confirmation: this.nodes.userPasswordConfirm.value }, this.editingId === null); }
      catch (error) { this._clearPasswords(); this._notice(error.message, 'error'); return Promise.resolve(false); }
      const previous = this.users.find(user => user.id === this.editingId);
      if (previous && input.username === previous.username && input.role === previous.role && !input.password) {
        this._notice('没有需要保存的修改。'); return Promise.resolve(false);
      }
      const path = '/api/auth/users' + (this.editingId === null ? '' : '/' + encodeURIComponent(this.editingId));
      const method = this.editingId === null ? 'POST' : 'PATCH';
      this._clearPasswords(); return this._run(method, path, input);
    }
    _current(operation, generation) { return operation === this.operation && generation === this.auth?.generation && this.isOpen && this._canManage(); }
    _request(method, path, body, operation, generation) {
      return new Promise((resolve, reject) => {
        const controller = this.AbortController ? new this.AbortController() : null;
        let settled = false;
        const finish = (error, data) => {
          if (settled) return; settled = true; this.clearTimer(timer);
          if (this._cancel === cancel) this._cancel = null;
          if (error) reject(error); else resolve(data);
        };
        const cancel = () => { finish(cancelled()); controller?.abort(); };
        const timer = this.setTimer(() => {
          finish(Object.assign(Error(method === 'GET' ? '用户列表读取超时，请重新读取。' : '保存响应超时，结果尚未确认；请重新读取用户列表确认后再操作。'), { timeout: true })); controller?.abort();
        }, REQUEST_TIMEOUT_MS);
        this._cancel = cancel;
        Promise.resolve().then(async () => {
          await this.auth.verifyManage();
          if (settled || !this._current(operation, generation)) throw cancelled();
          const response = await this.fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}), ...(controller ? { signal: controller.signal } : {}) });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(Error(String(data.error || '用户管理请求失败（HTTP ' + response.status + '）').slice(0, 300)), { status: response.status });
          return data;
        }).then(data => finish(null, data), error => finish(error));
      });
    }
    _applyList(data) {
      if (!data || !Array.isArray(data.users) || !data.users.length || data.users.length > 64 || typeof data.currentUserId !== 'string') throw Error('用户列表响应无效，请重新读取。');
      const ids = new Set(), names = new Set();
      const users = data.users.map(user => {
        if (!user || typeof user.id !== 'string' || typeof user.username !== 'string' || !USER_ID.test(user.id) || !USERNAME.test(user.username) || !['admin', 'guest'].includes(user.role) || ids.has(user.id) || names.has(user.username)) throw Error('用户列表响应无效，请重新读取。');
        ids.add(user.id); names.add(user.username); return { id: user.id, username: user.username, role: user.role };
      });
      const current = users.find(user => user.id === data.currentUserId);
      if (!current || current.role !== 'admin' || current.username !== this.auth.user.username) throw Error('当前账户与用户列表不一致，请重新登录。');
      this.users = users; this.currentUserId = data.currentUserId; this.loaded = true; this._renderList();
    }
    async _run(method, path, input) {
      if (!this.isOpen || !this._canManage() || this.busy) return false;
      const operation = ++this.operation, generation = this.auth.generation;
      this.busy = true; let saved = false;
      this._notice(method === 'GET' ? '正在读取服务器用户…' : '正在保存用户，请稍候…'); this._renderAccess();
      try {
        let data = await this._request(method, path, input, operation, generation);
        if (!this._current(operation, generation)) return false;
        if (method !== 'GET') {
          if (!data || data.ok !== true || typeof data.reauthenticate !== 'boolean') throw Error('保存响应无效，结果尚未确认；请重新读取用户列表。');
          saved = true; this._clearEditor();
          if (data.reauthenticate) {
            this.auth.expire?.();
            this.auth.message = '账户信息已更新，请重新登录。'; this.auth.notify?.(); this.auth.openLogin?.();
            this.toast('账户信息已更新，请重新登录。'); return true;
          }
          data = await this._request('GET', '/api/auth/users', null, operation, generation);
          if (!this._current(operation, generation)) return false;
        }
        this._applyList(data);
        this._notice(saved ? '用户已保存，已重新读取服务器列表。' : '已读取用户列表。管理员可管理平台，访客仅可查看监测。', saved ? 'success' : 'neutral');
        return true;
      } catch (error) {
        if (error.cancelled || operation !== this.operation || this.destroyed) return false;
        this.loaded = false; this.users = []; this.currentUserId = ''; this._clearEditor(); this._renderList();
        if (error.status === 401) { this.auth.expire?.(); this.auth.openLogin?.(); }
        if (error.status === 403) { this.denied = true; Promise.resolve(this.auth.initialize?.()).catch(() => {}); }
        this._notice(saved ? '用户已保存，但列表刷新失败；请点击“重新读取”确认。' : (error.message || '用户管理请求失败，请重新读取后再试。'), 'error');
        return false;
      } finally { if (operation === this.operation) this.busy = false; this._renderAccess(); }
    }
    destroy() {
      if (this.destroyed) return; this.destroyed = true; this.close();
      this.auth?.removeEventListener('change', this._accountChanged);
      for (const [node, event, callback] of this._listeners) node.removeEventListener(event, callback);
      this._listeners = [];
    }
  }
  scope.BoatUserManagementPanel = BoatUserManagementPanel;
  if (typeof module === 'object' && module.exports) module.exports = { BoatUserManagementPanel, validateUserForm };
})(typeof window === 'object' ? window : globalThis);
