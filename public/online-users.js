/* 仅管理员查看近期在线账户；会话令牌、密码及 IP 不进入此面板。 */
(function (scope) {
  'use strict';
  const ROLES = { admin: '管理员', driver: '驾驶员', guest: '访客' };
  class BoatOnlineUsersPanel {
    constructor(options = {}) {
      this.document = options.document || scope.document; this.auth = options.auth || scope.BoatAuth;
      this.fetch = options.fetch || scope.fetch.bind(scope);
      this.setTimer = options.setTimeout || scope.setTimeout.bind(scope); this.clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
      this.AbortController = options.AbortController || scope.AbortController;
      this.nodes = Object.fromEntries(['onlineUsers', 'onlineUsersRead', 'onlineUsersCount', 'onlineUsersList', 'onlineUsersStatus'].map(id => [id, this.document.getElementById(id)]));
      this.opened = false; this.destroyed = false; this.busy = false; this.denied = false; this.generation = 0; this.poll = null;
      this.identity = this._identity();
      this.readClick = () => this.read(); this.nodes.onlineUsersRead.addEventListener('click', this.readClick);
      this.accountChanged = () => {
        const identity = this._identity();
        if (identity !== this.identity) { this.identity = identity; this.denied = false; this.reset(); if (this.opened && this.allowed()) this.read(); }
        this.renderAccess();
      };
      this.visibilityChanged = () => { this.clearPoll(); if (this.opened && !this.document.hidden) this.read(); };
      this.auth?.addEventListener('change', this.accountChanged);
      this.document.addEventListener?.('visibilitychange', this.visibilityChanged);
      this.reset(); this.renderAccess();
    }
    _identity() { return JSON.stringify([this.auth?.generation, this.auth?.ready, this.auth?.enabled, this.auth?.user]); }
    allowed() { return !this.destroyed && !this.denied && this.auth?.enabled === true && this.auth.ready === true && this.auth.user?.role === 'admin'; }
    renderAccess() { this.nodes.onlineUsers.hidden = !this.allowed(); this.nodes.onlineUsersRead.disabled = !this.allowed() || this.busy; this.nodes.onlineUsersList.setAttribute('aria-busy', String(this.busy)); }
    notice(message, tone = 'neutral') { this.nodes.onlineUsersStatus.textContent = message; this.nodes.onlineUsersStatus.dataset.tone = tone; }
    clearPoll() { if (this.poll !== null) this.clearTimer(this.poll); this.poll = null; }
    schedule() { this.clearPoll(); if (this.opened && this.allowed() && !this.document.hidden) this.poll = this.setTimer(() => { this.poll = null; this.read(); }, 15000); }
    reset() { ++this.generation; this.cancel?.(); this.clearPoll(); this.busy = false; this.nodes.onlineUsersList.replaceChildren(); this.nodes.onlineUsersCount.textContent = '尚未读取'; this.notice('打开平台设置后自动读取，每 15 秒刷新。'); }
    open() { this.opened = true; this.renderAccess(); return this.read(); }
    close() { this.opened = false; this.reset(); this.renderAccess(); }
    request(current) {
      return new Promise((resolve, reject) => {
        const controller = this.AbortController ? new this.AbortController() : null; let done = false;
        const finish = (error, value) => { if (done) return; done = true; this.clearTimer(timer); if (this.cancel === cancel) this.cancel = null; error ? reject(error) : resolve(value); };
        const cancel = () => { finish(Object.assign(Error('已取消在线用户读取'), { cancelled: true })); controller?.abort(); };
        const timer = this.setTimer(() => { finish(Error('在线用户读取超时，请重试。')); controller?.abort(); }, 12000);
        this.cancel = cancel;
        Promise.resolve().then(async () => {
          if (!current()) throw Object.assign(Error('身份已变化'), { cancelled: true });
          const response = await this.fetch('/api/auth/online', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, ...(controller ? { signal: controller.signal } : {}) });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(Error(String(data.error || '在线用户读取失败（HTTP ' + response.status + '）').slice(0, 300)), { status: response.status });
          return data;
        }).then(value => finish(null, value), error => finish(error));
      });
    }
    apply(data) {
      const validTime = value => Number.isSafeInteger(value) && value >= 0;
      if (!data || !Array.isArray(data.users) || data.users.length > 64 || data.userCount !== data.users.length || !Number.isInteger(data.sessionCount) || data.sessionCount < 0 || !validTime(data.serverTime) || data.onlineWindowMs !== 90000) throw Error('在线用户响应无效，请重新读取。');
      const ids = new Set(), names = new Set(); let count = 0; const rows = [];
      for (const user of data.users) {
        if (!user || typeof user.id !== 'string' || !/^[a-f0-9]{32}$/.test(user.id) || typeof user.username !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(user.username) || !Object.hasOwn(ROLES, user.role) || ids.has(user.id) || names.has(user.username) || !Number.isInteger(user.sessionCount) || user.sessionCount < 1 || user.sessionCount > 128 || !validTime(user.loginAt) || !validTime(user.lastSeenAt)) throw Error('在线用户响应无效，请重新读取。');
        ids.add(user.id); names.add(user.username); count += user.sessionCount;
        const row = this.document.createElement('li'); row.className = 'user-management-row';
        const detail = this.document.createElement('div'); detail.className = 'user-management-identity';
        const name = this.document.createElement('strong'); name.textContent = user.username;
        const meta = this.document.createElement('div'); meta.className = 'user-management-meta';
        const role = this.document.createElement('span'); role.className = 'user-management-role'; role.dataset.role = user.role; role.textContent = ROLES[user.role];
        const activity = this.document.createElement('span'); activity.textContent = user.sessionCount + ' 个在线会话 · ' + Math.max(0, Math.round((data.serverTime - user.lastSeenAt) / 1000)) + ' 秒前活动';
        meta.append(role, activity); detail.append(name, meta);
        const badge = this.document.createElement('span'); badge.className = 'user-management-current'; badge.textContent = user.username === this.auth.user.username ? '当前账户' : '在线';
        row.append(detail, badge); rows.push(row);
      }
      if (count !== data.sessionCount) throw Error('在线会话统计无效，请重新读取。');
      this.nodes.onlineUsersList.replaceChildren(...rows);
      this.nodes.onlineUsersCount.textContent = data.userCount + ' 位用户在线 · ' + data.sessionCount + ' 个会话';
      this.notice('已更新 · 按最近 90 秒内的请求或实时连接心跳统计；同一账户的多个会话合并显示。', 'success');
    }
    async read() {
      if (!this.opened || !this.allowed() || this.busy || this.document.hidden) return false;
      this.clearPoll(); const generation = ++this.generation, identity = this._identity();
      const current = () => this.opened && this.allowed() && generation === this.generation && identity === this._identity();
      this.busy = true; this.renderAccess();
      try { const data = await this.request(current); if (!current()) return false; this.apply(data); return true; }
      catch (error) {
        if (error.cancelled || !current()) return false;
        this.nodes.onlineUsersList.replaceChildren(); this.nodes.onlineUsersCount.textContent = '读取失败'; this.notice(error.message, 'error');
        if (error.status === 401) this.auth.expire?.();
        if (error.status === 403) { this.denied = true; Promise.resolve(this.auth.initialize?.()).catch(() => {}); }
        return false;
      } finally { if (generation === this.generation) { this.busy = false; this.schedule(); } this.renderAccess(); }
    }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.close(); this.auth?.removeEventListener('change', this.accountChanged); this.document.removeEventListener?.('visibilitychange', this.visibilityChanged); this.nodes.onlineUsersRead.removeEventListener('click', this.readClick); }
  }
  scope.BoatOnlineUsersPanel = BoatOnlineUsersPanel;
  if (typeof module === 'object' && module.exports) module.exports = { BoatOnlineUsersPanel };
})(typeof window === 'object' ? window : globalThis);
