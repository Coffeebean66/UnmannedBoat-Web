/* 独立的平台更新管理：不复用云端监测密码，也不触碰蓝牙和设备参数。 */
(() => {
  'use strict';
  const STORAGE_KEY = 'boat_web_update_ticket_v1';
  const WATCH_MS = 10 * 60 * 1000;
  const TICKET_MS = 30 * 60 * 1000;
  const active = job => job && (job.status === 'queued' || job.status === 'running');
  const brief = (value, limit = 320) => String(value || '').slice(0, limit);

  class UpdateError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }

  class BoatUpdateController {
    constructor(options = {}) {
      this.fetch = options.fetch || window.fetch.bind(window);
      try { this.storage = options.storage || window.sessionStorage; }
      catch (_) { this.storage = { getItem: () => null, setItem() {}, removeItem() {} }; }
      this.now = options.now || Date.now;
      this.setTimer = options.setTimeout || ((fn, delay) => setTimeout(fn, delay));
      this.clearTimer = options.clearTimeout || (id => clearTimeout(id));
      this.onChange = options.onChange || (() => {});
      this.timer = null;
      this.polling = false;
      this.pending = null;
      this.state = { enabled: null, authenticated: false, busy: false, current: null,
        latestCommit: '', latestVersion: '', available: false, job: null,
        notice: '正在检查服务器更新配置…', tone: 'neutral', waiting: false,
        completed: false, needsRefresh: false };
      this.restoreTicket();
      this.accountGeneration=window.BoatAuth?.generation;
      this.accountKnown=!!window.BoatAuth?.ready;
      window.BoatAuth?.addEventListener('change',()=>{
        const auth=window.BoatAuth;
        if(this.accountGeneration===auth.generation)return;
        this.accountGeneration=auth.generation;
        if(auth.enabled===true){
          const restoringAnonymous=!this.accountKnown&&auth.ready&&!auth.user&&this.pending?.ticket;
          this.state.authenticated=auth.canManage;
          if(!auth.canManage&&!restoringAnonymous){this.clearPending();this.state.waiting=false;this.state.job=null;this.state.current=null;this.state.available=false;this.state.latestCommit='';}
          this.accountKnown=auth.ready;
          this.emit();
        }
      });
    }

    emit() { this.onChange(this.state); }
    notice(message, tone = 'neutral') { this.state.notice = brief(message); this.state.tone = tone; }

    restoreTicket() {
      try {
        const record = JSON.parse(this.storage.getItem(STORAGE_KEY) || 'null');
        if (!record) return;
        if (typeof record.ticket !== 'string' || record.ticket.length > 2048 || !record.ticket ||
            typeof record.id !== 'string' || !record.id || typeof record.expectedCommit !== 'string' ||
            !/^[a-f0-9]{40,64}$/i.test(record.expectedCommit) || !Number.isFinite(record.deadline) ||
            !Number.isFinite(record.expiresAt) || record.deadline <= this.now() ||
            record.expiresAt <= this.now() || record.expiresAt > this.now() + TICKET_MS) {
          this.storage.removeItem(STORAGE_KEY); return;
        }
        this.pending = record;
        this.state.job = { id: record.id, status: 'running', phase: 'recovering', expectedCommit: record.expectedCommit };
        this.state.waiting = true;
        this.notice('正在恢复上次更新的进度…');
      } catch (_) { /* 禁用浏览器存储时仍可更新，不能跨页面恢复。 */ }
    }

    saveTicket() {
      try {
        if (this.pending && this.pending.ticket) this.storage.setItem(STORAGE_KEY, JSON.stringify(this.pending));
        else this.storage.removeItem(STORAGE_KEY);
      } catch (_) {}
    }

    clearPending() {
      this.pending = null;
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
      this.saveTicket();
    }

    async request(path, { method = 'GET', body, ticket } = {}) {
      const auth=window.BoatAuth;
      if(auth&&auth.enabled!==false&&path!=='config'){
        if(path==='login'||path==='session')throw new UpdateError('请使用平台账户登录或退出');
        if(!(path==='status'&&ticket&&!auth.user))auth.assertManage();
      }
      const abort = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = abort ? this.setTimer(() => abort.abort(), 15000) : null;
      try {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (ticket) headers['X-Boat-Update-Ticket'] = ticket;
        const response = await this.fetch('/api/update/' + path, { method, headers,
          credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(abort ? { signal: abort.signal } : {}) });
        let data;
        try { data = await response.json(); } catch (_) { data = {}; }
        if (!response.ok) throw new UpdateError(brief(data.error) || '服务器暂时无法响应（' + response.status + '）', response.status);
        return data;
      } catch (error) {
        if (error instanceof UpdateError) throw error;
        throw new UpdateError('暂时无法连接服务器，请稍后重试。');
      } finally { if (timer !== null) this.clearTimer(timer); }
    }

    async exclusive(action) {
      if (this.state.busy) return;
      this.state.busy = true; this.emit();
      try { await action(); }
      catch (error) {
        if (error.status === 401 || error.status === 403){this.state.authenticated = false;if(error.status===401)window.BoatAuth?.expire();}
        this.notice(error.message, 'error');
      } finally { this.state.busy = false; this.emit(); }
    }

    async open() {
      return this.exclusive(async () => {
        if(window.BoatAuth){await window.BoatAuth.whenReady();if(window.BoatAuth.enabled!==false)window.BoatAuth.assertManage();}
        let config;
        try { config = await this.request('config'); }
        catch (error) {
          if (error.status === 404 || error.status === 501) {
            this.state.enabled = false;
            this.notice('此服务器尚未安装一键更新组件，需要先按部署说明安装一次。', 'warning'); return;
          }
          throw error;
        }
        this.state.enabled = config.enabled === true && config.apiVersion === 1;
        if (!this.state.enabled) {
          this.notice(config.reason || '服务器尚未启用一键更新，需要先安装更新组件并设置独立的更新管理密码。', 'warning'); return;
        }
        try {
          await this.readStatus();
          if (this.state.authenticated && !this.pending) await this.checkInternal();
        } catch (error) {
          if (this.pending && this.transient(error)) { this.notice('服务正在重启，正在恢复更新进度…'); this.schedule(); return; }
          if (error.status === 401 || error.status === 403) {
            this.state.authenticated = false;
            this.notice('请使用独立的更新管理密码登录。'); return;
          }
          throw error;
        }
      });
    }

    async login(password) {
      if(window.BoatAuth&&window.BoatAuth.enabled!==false){window.BoatAuth.openLogin?.();return;}
      if (!this.state.enabled || this.pending) return;
      return this.exclusive(async () => {
        await this.request('login', { method: 'POST', body: { password } });
        this.state.authenticated = true;
        await this.readStatus();
        if (!this.pending) await this.checkInternal();
      });
    }

    async logout() {
      if(window.BoatAuth?.enabled===true)return window.BoatAuth.logout();
      if (this.pending) return;
      return this.exclusive(async () => {
        await this.request('session', { method: 'DELETE' });
        this.state.authenticated = false;
        this.state.latestCommit = ''; this.state.available = false;
        this.notice('已退出更新管理，监测连接不受影响。');
      });
    }

    async checkInternal() {
      if(window.BoatAuth)await window.BoatAuth.verifyManage();
      const accountGeneration=window.BoatAuth?.generation;
      const data = await this.request('check', { method: 'POST', body: {} });
      if(window.BoatAuth&&accountGeneration!==window.BoatAuth.generation)return;
      this.state.latestCommit = brief(data.latestCommit, 64);
      this.state.latestVersion = brief(data.latestVersion, 80);
      this.state.available = data.available === true;
      this.state.completed = false;
      this.notice(this.state.available ? '发现新提交，可以更新并重启服务。' : '当前服务器已是 GitHub main 分支的最新提交。', this.state.available ? 'info' : 'success');
    }

    async check() {
      if (this.pending) return;
      // 未配置/断网时也提供一个明确的重新检测入口。
      if (!this.state.enabled || !this.state.authenticated) return this.open();
      return this.exclusive(() => this.checkInternal());
    }

    async start() {
      if (!this.state.enabled || !this.state.authenticated || !this.state.available || this.pending || !this.state.latestCommit) return;
      return this.exclusive(async () => {
        if(window.BoatAuth)await window.BoatAuth.verifyManage();
        const accountGeneration=window.BoatAuth?.generation;
        const expectedCommit = this.state.latestCommit;
        const data = await this.request('start', { method: 'POST', body: { expectedCommit } });
        if(window.BoatAuth&&accountGeneration!==window.BoatAuth.generation)return;
        if (!data.job || typeof data.job.id !== 'string' || typeof data.ticket !== 'string' || !data.ticket) {
          throw new UpdateError('服务器没有返回有效的更新任务，请重新读取状态。');
        }
        this.pending = { ticket: data.ticket, id: data.job.id, expectedCommit,
          expiresAt: this.now() + TICKET_MS, deadline: this.now() + WATCH_MS };
        this.state.job = data.job;
        this.state.waiting = true; this.state.completed = false; this.state.needsRefresh = false;
        this.notice('更新任务已提交，监控可能短暂断开；请等待服务自动恢复。', 'info');
        this.saveTicket(); this.schedule(1000);
      });
    }

    transient(error) { return error.status === 0 || error.status === 404 || error.status >= 500; }

    schedule(delay = 2500) {
      if (!this.pending || this.timer !== null) return;
      this.timer = this.setTimer(() => { this.timer = null; this.poll(); }, delay);
    }

    async poll() {
      if (!this.pending || this.polling) return;
      if (this.now() >= Math.min(this.pending.deadline, this.pending.expiresAt)) {
        this.clearPending(); this.state.waiting = false; this.state.authenticated = false;
        this.notice('等待已超过 10 分钟。后台任务不会因此取消，请重新登录查看结果；请勿重复启动更新。', 'warning'); this.emit(); return;
      }
      this.polling = true;
      try { await this.readStatus(); }
      catch (error) {
        if (this.transient(error)) this.notice('服务暂时离线或正在重启，正在自动重连更新状态…', 'info');
        else {
          this.clearPending(); this.state.waiting = false;
          if (error.status === 401 || error.status === 403) this.state.authenticated = false;
          this.notice('进度查询已失效，请重新登录查看任务结果。' + error.message, 'warning');
        }
      } finally { this.polling = false; this.emit(); this.schedule(); }
    }

    async readStatus() {
      const accountGeneration=window.BoatAuth?.generation;
      const ticket = this.pending && this.pending.ticket;
      const data = await this.request('status', { ticket });
      if(window.BoatAuth&&accountGeneration!==window.BoatAuth.generation)return;
      if (!ticket) this.state.authenticated = true;
      this.state.current = data.current || null;
      const job = data.job;
      if (this.pending && (!job || job.id !== this.pending.id)) {
        this.notice('正在等待后台任务进入更新流程…', 'info'); this.schedule(); return;
      }
      this.state.job = job || null;
      if (!job) return;
      if (!this.pending && active(job)) {
        this.pending = { id: job.id, expectedCommit: job.expectedCommit,
          deadline: this.now() + WATCH_MS, expiresAt: this.now() + TICKET_MS };
      }
      if (job.status === 'failed' || job.status === 'rolled_back') {
        this.clearPending(); this.state.waiting = false; this.state.completed = false;
        this.notice((job.status === 'rolled_back' ? '更新失败，已回滚到原版本。' : '更新未完成。') + brief(job.message), 'error'); return;
      }
      if (job.status === 'succeeded') {
        const expected = this.pending ? this.pending.expectedCommit : job.expectedCommit;
        const target = job.targetCommit || job.expectedCommit;
        if (target && target === expected && data.current && data.current.commit === target) {
          const watched = !!this.pending;
          this.clearPending(); this.state.waiting = false; this.state.completed = true;
          this.state.needsRefresh = watched; this.state.available = false;
          this.notice(watched ? '更新成功，新版本服务已启动。点击“刷新到新版本”加载最新界面。' : '上次更新已完成，当前正在运行该提交。', 'success'); return;
        }
        this.state.waiting = !!this.pending;
        this.notice('代码更新完成，正在等待新版本服务启动并核对提交…', 'info');
      } else if (active(job)) {
        this.state.waiting = true;
        this.notice('更新正在服务器后台进行，服务重启期间会自动重连。', 'info');
      }
      this.schedule();
    }
  }

  window.BoatUpdateController = BoatUpdateController;
  if (typeof document === 'undefined' || !document.getElementById('updateDialog')) return;
  const $ = id => document.getElementById(id);
  const dialog = $('updateDialog');
  const shortCommit = value => value ? brief(value, 10) : '未知提交';
  const labels = { queued: '排队中', running: '更新中', succeeded: '已完成', failed: '失败', rolled_back: '已回滚' };
  const phases = { queued: '等待后台更新', recovering: '恢复任务进度', preparing: '准备更新',
    fetching: '获取 GitHub 代码', downloading: '下载 GitHub 代码', checking: '检查更新包', installing: '安装依赖', testing: '验证更新包', building: '构建并验证新版本',
    switching: '切换新版本', restarting: '重启监测服务', healthcheck: '检查新服务',
    rolling_back: '恢复原版本', rollback: '恢复原版本', recovery: '恢复更新任务', interrupted: '更新中断', complete: '更新完成', succeeded: '更新完成', failed: '更新失败', rolled_back: '已恢复原版本' };
  const controller = new BoatUpdateController({ onChange: render });

  function render(state) {
    const watching = !!controller.pending;
    $('updateStatus').textContent = state.notice;
    $('updateStatus').dataset.tone = state.tone;
    const accountMode=!!window.BoatAuth&&window.BoatAuth.enabled!==false;
    $('updateLoginForm').hidden = accountMode || state.enabled !== true || state.authenticated || watching;
    $('updateDetails').hidden = !state.authenticated && !watching && !state.job;
    $('updateLoginSubmit').disabled = state.busy;
    $('updatePassword').disabled = state.busy;
    $('updateLogout').hidden = accountMode || !state.authenticated;
    $('updateLogout').disabled = state.busy || watching;
    $('updateCheck').disabled = state.busy || watching;
    $('updateCheck').textContent = state.enabled === false || state.enabled === null ? '重新检测' : '检查更新';
    $('updateStart').disabled = state.busy || watching || !state.enabled || !state.authenticated || !state.available;
    $('updateStart').hidden = state.needsRefresh;
    $('updateRefresh').hidden = !state.needsRefresh;
    $('updateBusyDot').hidden = !watching;
    $('updateToggle').setAttribute('aria-label', watching ? '查看平台更新进度' : '更新监测平台');
    $('updateCurrentVersion').textContent = state.current ? brief(state.current.version, 80) || '版本未知' : '--';
    $('updateCurrentCommit').textContent = state.current ? shortCommit(state.current.commit) : '尚未读取提交';
    $('updateCurrentCommit').title = state.current ? brief(state.current.commit, 64) : '';
    $('updateLatestCommit').textContent = state.latestCommit ? shortCommit(state.latestCommit) : '尚未检查';
    $('updateLatestCommit').title = state.latestCommit;
    $('updateLatestVersion').textContent = state.latestVersion || (state.latestCommit ? (state.available ? 'main · 有可用更新' : 'main · 已是最新') : '以已推送到 GitHub main 的提交为准');
    $('updateProgress').hidden = !state.job;
    if (state.job) {
      $('updatePhase').textContent = phases[state.job.phase] || (watching ? '更新处理中' : '上次更新任务');
      $('updateJobState').textContent = labels[state.job.status] || '处理中';
      $('updateJobMessage').textContent = brief(state.job.message) || (watching ? '正在等待服务器报告进度…' : '');
      $('updateProgressTrack').dataset.running = String(watching);
      $('updateProgress').dataset.tone = state.job.status === 'failed' || state.job.status === 'rolled_back' ? 'error' : state.completed ? 'success' : 'neutral';
    }
  }

  $('updateToggle').addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
    document.documentElement.classList.add('update-modal-open');
    controller.open();
  });
  $('updateClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    $('updatePassword').value = '';
    document.documentElement.classList.toggle('update-modal-open', dialog.open);
  });
  $('updateLoginForm').addEventListener('submit', event => {
    event.preventDefault();
    const password = $('updatePassword').value;
    $('updatePassword').value = '';
    controller.login(password);
  });
  $('updateLogout').addEventListener('click', () => controller.logout());
  $('updateCheck').addEventListener('click', () => controller.check());
  $('updateStart').addEventListener('click', () => controller.start());
  $('updateRefresh').addEventListener('click', () => window.location.reload());
  render(controller.state);
  // 刷新页面后只恢复只读票据；不恢复密码或管理员会话。
  if (controller.pending) { controller.schedule(0); }
})();
