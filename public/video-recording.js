/* 录像由服务器持续保存；浏览器只发控制指令、查询目录和播放已保存片段。 */
(function (scope) {
  'use strict';
  const BASE = '/api/video/recording', DEVICE = /^[A-Za-z0-9_-]{1,64}$/, CLIP = /^[A-Za-z0-9_-]{1,160}$/;
  const cancelled = () => Object.assign(Error('录像请求已取消'), { cancelled: true });
  class BoatVideoRecordingPanel {
    constructor(options = {}) {
      this.document = options.document || scope.document; this.auth = options.auth || scope.BoatAuth;
      this.fetch = options.fetcher || options.fetch || scope.fetch.bind(scope);
      this.AbortController = options.AbortController || scope.AbortController;
      this.setTimer = options.setTimeout || scope.setTimeout.bind(scope); this.clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
      this.nodes = Object.fromEntries(['recordingDevice', 'recordingStatus', 'recordingStart', 'recordingStop', 'recordingRefresh', 'recordingCount',
        'recordingList', 'recordingEmpty', 'recordingPlayerWrap', 'recordingPlayer', 'recordingPlaybackTitle', 'recordingPlaybackClose',
        'recordingSettings', 'recordingSettingsForm', 'recordingDirectory', 'recordingSettingsRead', 'recordingSettingsSave',
        'recordingSettingsRoot', 'recordingSettingsStatus'].map(id => [id, this.document.getElementById(id)]));
      this.deviceId = ''; this.authenticated = false; this.visible = false; this.opened = false; this.destroyed = false;
      this.snapshot = null; this.config = null; this.channels = { boat: { generation: 0, busy: false }, config: { generation: 0, busy: false } };
      this.listeners = []; this.poll = null; this.playingId = ''; this.identity = this._identity();
      this.onChange = () => {
        const identity = this._identity();
        if (identity !== this.identity) {
          this.identity = identity; this._cancel('boat'); this._cancel('config'); this._clearPoll(); this.snapshot = null; this.config = null;
          this.stopPlayback(); this._renderList(); this.nodes.recordingDirectory.value = ''; this.settingsNotice('请重新读取录像保存设置。');
          this.notice('请选择一艘无人船查看服务器录像。');
          if (this.visible && this.monitor()) this.refresh();
          if (this.opened && this.admin()) this.readSettings();
        }
        this.render();
      };
      this.auth?.addEventListener('change', this.onChange);
      this.listen('recordingStart', 'click', () => this.command('start'));
      this.listen('recordingStop', 'click', () => this.command('stop'));
      this.listen('recordingRefresh', 'click', () => this.refresh());
      this.listen('recordingPlaybackClose', 'click', () => this.stopPlayback());
      this.listen('recordingSettingsRead', 'click', () => this.readSettings());
      this.listen('recordingSettingsForm', 'submit', event => { event.preventDefault(); this.saveSettings(); });
      this.listen('recordingPlayer', 'error', () => { if (this.playingId) this.notice('录像播放失败，请刷新列表后重试，或下载到本地播放。', 'error'); });
      this.notice('请选择一艘无人船查看服务器录像。'); this.render();
    }
    listen(id, event, handler) { const node = this.nodes[id]; node.addEventListener(event, handler); this.listeners.push([node, event, handler]); }
    _identity() { return JSON.stringify([this.auth?.generation, this.auth?.enabled, this.auth?.ready, this.auth?.user?.username, this.auth?.user?.role]); }
    monitor() { return !this.destroyed && this.authenticated && this.auth?.enabled === true && this.auth?.ready === true && !!this.auth.user && DEVICE.test(this.deviceId); }
    admin() { return !this.destroyed && this.auth?.enabled === true && this.auth?.ready === true && this.auth.user?.role === 'admin'; }
    notice(message, tone = 'neutral') { this.nodes.recordingStatus.textContent = message; this.nodes.recordingStatus.dataset.tone = tone; }
    settingsNotice(message, tone = 'neutral') { this.nodes.recordingSettingsStatus.textContent = message; this.nodes.recordingSettingsStatus.dataset.tone = tone; }
    _cancel(kind) { const channel = this.channels[kind]; ++channel.generation; channel.cancel?.(); channel.busy = false; }
    _clearPoll() { if (this.poll !== null) this.clearTimer(this.poll); this.poll = null; }
    _schedule() {
      this._clearPoll();
      if (!this.destroyed && this.visible && this.monitor()) this.poll = this.setTimer(() => { this.poll = null; this.refresh(); }, 8000);
    }
    update({ deviceId = '', authenticated = false } = {}) {
      if (this.destroyed) return;
      const changed = this.deviceId !== deviceId || this.authenticated !== !!authenticated;
      this.deviceId = DEVICE.test(deviceId) ? deviceId : ''; this.authenticated = !!authenticated;
      if (changed) {
        this._cancel('boat'); this._clearPoll(); this.snapshot = null; this.stopPlayback(); this._renderList();
        this.notice(this.monitor() ? '正在读取这艘无人船的服务器录像…' : '请登录并选择一艘无人船查看录像。');
        if (this.visible && this.monitor()) this.refresh();
      }
      this.render();
    }
    setVisible(visible) {
      if (this.destroyed || this.visible === !!visible) return;
      this.visible = !!visible;
      if (!this.visible) { this._clearPoll(); this._cancel('boat'); this.stopPlayback(); }
      else if (this.monitor()) this.refresh();
      this.render();
    }
    open() { this.opened = true; this.render(); return this.admin() ? this.readSettings() : Promise.resolve(false); }
    close() { this.opened = false; this._cancel('config'); this.config = null; this.nodes.recordingDirectory.value = ''; this.render(); }
    state() { return { deviceId: this.deviceId, visible: this.visible, armed: this.snapshot?.armed === true, recording: this.snapshot?.recording === true, clips: this.snapshot?.segments.length || 0, playingId: this.playingId }; }
    render() {
      const n = this.nodes, monitor = this.monitor(), admin = this.admin(), busy = this.channels.boat.busy, configBusy = this.channels.config.busy;
      n.recordingDevice.textContent = this.deviceId || '未选择无人船';
      n.recordingStart.hidden = !admin; n.recordingStop.hidden = !admin;
      n.recordingStart.disabled = !monitor || busy || this.snapshot?.enabled !== true || this.snapshot.armed;
      n.recordingStop.disabled = !monitor || busy || this.snapshot?.enabled !== true || !this.snapshot.armed;
      n.recordingRefresh.disabled = !monitor || busy;
      n.recordingCount.textContent = this.snapshot ? this.snapshot.segments.length + ' 段录像' : '尚未读取';
      n.recordingEmpty.hidden = !!this.snapshot?.segments.length;
      n.recordingEmpty.textContent = this.snapshot?.enabled === false ? '服务器录像尚未启用' : this.snapshot ? '暂无录像，开始录像后按片段自动保存。' : '选择无人船后读取已保存的录像。';
      n.recordingSettings.hidden = !admin;
      const active = Number(this.config?.activeCount || 0) > 0;
      n.recordingDirectory.disabled = !admin || configBusy || !this.config?.enabled || active || !!this.config?.error;
      n.recordingSettingsSave.disabled = !admin || configBusy || !this.config?.enabled || active || !!this.config?.error;
      n.recordingSettingsRead.disabled = !admin || configBusy;
      n.recordingSettingsForm.setAttribute('aria-busy', String(configBusy));
      n.recordingSettingsRoot.textContent = this.config?.enabled
        ? '允许的保存范围：' + this.config.allowedRoot + '；每段约 ' + this.config.segmentSeconds + ' 秒，保留 ' + this.config.retentionDays + ' 天。' +
          (active ? ' 当前有 ' + this.config.activeCount + ' 艘船已开启录像，请全部停止后修改目录。' : '') +
          (this.config.persistent === false ? ' 当前设置未持久化，重启服务后会恢复默认。' : '')
        : '保存目录位于服务器，需先启用 SRT / UDP 录像组件。';
    }
    _request(kind, method, url, body, requiresAdmin, current) {
      const channel = this.channels[kind];
      return new Promise((resolve, reject) => {
        const controller = this.AbortController ? new this.AbortController() : null;
        let settled = false;
        const finish = (fault, data) => { if (settled) return; settled = true; this.clearTimer(timer); if (channel.cancel === cancel) channel.cancel = null; fault ? reject(fault) : resolve(data); };
        const cancel = () => { finish(cancelled()); controller?.abort(); };
        const timer = this.setTimer(() => { finish(Error(method === 'GET' ? '录像信息读取超时，请重试。' : '操作响应超时，请重新读取确认服务器状态。')); controller?.abort(); }, 20000);
        channel.cancel = cancel;
        Promise.resolve().then(async () => {
          if (requiresAdmin) await this.auth.verifyManage?.();
          if (settled || !current()) throw cancelled();
          const response = await this.fetch(url, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}), ...(controller ? { signal: controller.signal } : {}) });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            if (method === 'GET' && response.status === 404) return { enabled: false, reason: '服务器尚未安装录像功能，请更新网页和视频组件。' };
            throw Object.assign(Error(String(data.error || '录像请求失败（HTTP ' + response.status + '）').slice(0, 300)), { status: response.status });
          }
          return data;
        }).then(data => finish(null, data), fault => finish(fault));
      });
    }
    async _run(kind, method, url, body, accept) {
      const channel = this.channels[kind], adminOperation = kind === 'config' || method !== 'GET';
      if (this.destroyed || channel.busy || kind === 'boat' && (!this.visible || !this.monitor()) || kind === 'config' && (!this.opened || !this.admin()) || adminOperation && !this.admin()) return false;
      const operation = ++channel.generation, identity = this._identity(), boat = this.deviceId;
      const current = () => !this.destroyed && operation === channel.generation && identity === this._identity() &&
        (kind === 'boat' ? this.visible && this.monitor() && boat === this.deviceId : this.opened && this.admin());
      channel.busy = true; if (kind === 'boat') this._clearPoll(); this.render();
      try {
        const data = await this._request(kind, method, url, body, adminOperation, current);
        if (!current()) return false;
        accept(data); return true;
      } catch (fault) {
        if (fault.cancelled || !current()) return false;
        if (kind === 'boat') { this.snapshot = null; this._renderList(); this.notice(fault.message || '无法读取录像，请重试。', 'error'); }
        else { this.config = null; this.settingsNotice(fault.message || '录像目录保存失败，请重新读取。', 'error'); }
        if (fault.status === 401) { this.auth.expire?.(); this.auth.openLogin?.(); }
        if (fault.status === 403) Promise.resolve(this.auth.initialize?.()).catch(() => {});
        return false;
      } finally {
        if (operation === channel.generation) { channel.busy = false; if (kind === 'boat') this._schedule(); }
        this.render();
      }
    }
    refresh() {
      return this._run('boat', 'GET', BASE + '/boats/' + encodeURIComponent(this.deviceId), null, data => this.applyBoat(data));
    }
    command(action) {
      if (!['start', 'stop'].includes(action) || !this.admin() || this.snapshot?.enabled !== true || (action === 'start') === this.snapshot.armed) return Promise.resolve(false);
      this.notice(action === 'start' ? '正在请求服务器开始录像…' : '正在停止录像并保存最后一个片段…');
      return this._run('boat', 'POST', BASE + '/boats/' + encodeURIComponent(this.deviceId) + '/' + action, {}, data => this.applyBoat(data));
    }
    applyBoat(data) {
      if (data?.enabled === false) { this.snapshot = { enabled: false, segments: [] }; this._renderList(); this.notice(data.reason || data.error || '服务器尚未启用录像功能，请联系管理员安装视频组件。', 'warning'); return; }
      if (!data || data.deviceId !== this.deviceId || data.enabled !== true || typeof data.armed !== 'boolean' || typeof data.receiving !== 'boolean' || typeof data.recording !== 'boolean' || !Array.isArray(data.segments) || data.segments.length > 2000) throw Error('录像响应格式无效，请刷新后重试。');
      const ids = new Set();
      const segments = data.segments.map(item => {
        if (!item || typeof item.id !== 'string' || !CLIP.test(item.id) || ids.has(item.id) || typeof item.start !== 'string' || !Number.isFinite(Date.parse(item.start)) || !Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 86400) throw Error('录像片段列表无效，请刷新后重试。');
        const url = BASE + '/boats/' + this.deviceId + '/clips/' + item.id;
        if (item.playbackUrl !== url || item.downloadUrl !== url + '?download=1') throw Error('录像播放地址无效，请刷新后重试。');
        ids.add(item.id); return { id: item.id, start: item.start, duration: item.duration, playbackUrl: url, downloadUrl: url + '?download=1' };
      });
      this.snapshot = { ...data, segments }; this._renderList();
      if (data.error) this.notice(String(data.error).slice(0, 300), 'error');
      else if (data.armed && data.receiving) this.notice('服务器录像已开启 · 正在接收视频，关闭网页仍会继续', 'success');
      else if (data.armed) this.notice('录像已开启，等待船端视频 · 视频恢复后自动续录', 'warning');
      else this.notice('录像已停止 · 已保存的片段可回放或下载');
      if (data.persistent === false) this.nodes.recordingStatus.textContent += ' · 设置未持久化，服务重启后需重新开启录像';
    }
    _renderList() {
      const segments = this.snapshot?.segments || [];
      this.nodes.recordingList.replaceChildren(...segments.map(item => {
        const row = this.document.createElement('li'); row.className = 'recording-row';
        const details = this.document.createElement('div'), title = this.document.createElement('strong'), subtitle = this.document.createElement('span');
        title.textContent = new Date(item.start).toLocaleString('zh-CN', { hour12: false });
        subtitle.textContent = item.duration.toFixed(1) + ' 秒 · MP4'; details.append(title, subtitle);
        const actions = this.document.createElement('div'); actions.className = 'recording-row-actions';
        const play = this.document.createElement('button'); play.type = 'button'; play.className = 'small-button'; play.textContent = '回放';
        play.addEventListener('click', () => this.playClip(item.id));
        const download = this.document.createElement('a'); download.href = item.downloadUrl; download.className = 'recording-download'; download.textContent = '下载'; download.setAttribute('download', '');
        actions.append(play, download); row.append(details, actions); return row;
      }));
    }
    playClip(id) {
      if (!this.monitor() || !this.visible) return false;
      const item = this.snapshot?.segments.find(item => item.id === id); if (!item) return false;
      this.stopPlayback(); this.playingId = id;
      this.nodes.recordingPlayerWrap.hidden = false; this.nodes.recordingPlaybackTitle.textContent = this.deviceId + ' · ' + new Date(item.start).toLocaleString('zh-CN', { hour12: false });
      this.nodes.recordingPlayer.src = item.playbackUrl; this.nodes.recordingPlayer.load();
      // 用户点击触发播放，失败时仍保留浏览器播放器自己的播放按钮。
      try { this.nodes.recordingPlayer.play()?.catch(() => {}); } catch (_) { /* 可使用播放器手动开始。 */ }
      return true;
    }
    stopPlayback() {
      const player = this.nodes.recordingPlayer;
      if (this.playingId || player.getAttribute('src')) { player.pause(); player.removeAttribute('src'); player.load(); }
      this.playingId = ''; this.nodes.recordingPlayerWrap.hidden = true; this.nodes.recordingPlaybackTitle.textContent = '';
    }
    readSettings() {
      return this._run('config', 'GET', BASE + '/config', null, data => this.applyConfig(data, false));
    }
    saveSettings() {
      if (!this.config?.enabled || this.config.activeCount > 0 || this.config.error) return Promise.resolve(false);
      const directory = this.nodes.recordingDirectory.value.trim();
      if (!directory || directory.length > 500 || !directory.startsWith('/') || /[\x00-\x1f\x7f\\%]/.test(directory) || directory.split('/').some(part => part === '.' || part === '..')) { this.settingsNotice('请填写允许范围内的服务器绝对目录，不要包含 ..、反斜杠或特殊控制字符。', 'error'); return Promise.resolve(false); }
      this.settingsNotice('正在保存服务器录像目录…');
      return this._run('config', 'PATCH', BASE + '/config', { directory }, data => this.applyConfig(data, true));
    }
    applyConfig(data, saved) {
      if (!data || typeof data.enabled !== 'boolean') throw Error('录像设置响应格式无效，请重新读取。');
      if (!data.enabled) { this.config = { enabled: false }; this.nodes.recordingDirectory.value = ''; this.settingsNotice(data.reason || data.error || '服务器尚未启用录像功能，请更新并安装视频录像组件。', 'warning'); return; }
      if (typeof data.directory !== 'string' || typeof data.allowedRoot !== 'string' || !Number.isFinite(data.segmentSeconds) || !Number.isFinite(data.retentionDays) || typeof data.persistent !== 'boolean') throw Error('录像保存目录响应无效，请重新读取。');
      const activeCount = Number.isInteger(data.activeCount) ? data.activeCount : Array.isArray(data.activeBoats) ? data.activeBoats.length : 0;
      this.config = { ...data, activeCount }; this.nodes.recordingDirectory.value = data.directory;
      this.settingsNotice(data.error ? String(data.error).slice(0, 300) : saved ? '录像目录已保存；旧文件保留原目录，列表显示当前目录录像，不自动搬迁。' : '已读取服务器录像保存设置。', data.error ? 'error' : saved ? 'success' : 'neutral');
      if (saved) {
        // 保存目录变更后立即撤下旧目录链接，避免轮询前仍展示上个目录的片段。
        this._cancel('boat'); this.snapshot = null; this.stopPlayback(); this._renderList();
        if (this.visible && this.monitor()) this.refresh();
      }
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this._clearPoll(); this._cancel('boat'); this._cancel('config'); this.stopPlayback();
      this.auth?.removeEventListener('change', this.onChange);
      for (const [node, event, handler] of this.listeners) node.removeEventListener(event, handler);
      this.listeners = [];
    }
  }
  scope.BoatVideoRecordingPanel = BoatVideoRecordingPanel;
  if (typeof module === 'object' && module.exports) module.exports = { BoatVideoRecordingPanel };
})(typeof window === 'object' ? window : globalThis);
