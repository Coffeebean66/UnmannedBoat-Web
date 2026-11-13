/* 音频文件由服务器保存和播报；关闭面板后已开始的文件继续播放一次。 */
(() => {
  'use strict';
  const LIBRARY = '/api/video/camera/audio-files', ID = /^[a-f0-9]{32}$/;
  const duration = value => { const seconds = Math.max(0, Math.floor(Number(value) || 0)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
  class BoatCameraAudio {
    constructor({ camera, document, auth, fetcher }) {
      Object.assign(this, { camera, document, auth, fetch: fetcher });
      this.nodes = Object.fromEntries(['cameraAudioSelect', 'cameraAudioRefresh', 'cameraAudioUploadArea', 'cameraAudioFile', 'cameraAudioUpload', 'cameraAudioPlay', 'cameraAudioStop', 'cameraAudioDelete', 'cameraAudioStatus', 'cameraAudioVolume', 'cameraAudioVolumeValue'].map(id => [id, document.getElementById(id)]));
      this.library = null; this.state = null; this.context = ''; this.generation = 0; this.actionVersion = 0; this.busy = false; this.activity = ''; this.loading = false; this.polling = false; this.message = ''; this.tone = ''; this.requests = new Set();
      this.volume = 100; this.volumeVersion = 0; this.volumePending = false; this.volumeSending = false; this.volumeError = '';
      const listen = (id, event, handler) => camera.listen(this.nodes[id], event, handler);
      listen('cameraAudioSelect', 'change', () => this.camera.render()); listen('cameraAudioFile', 'change', () => this.camera.render());
      listen('cameraAudioRefresh', 'click', () => { void this.loadLibrary(); void this.poll(); });
      listen('cameraAudioUpload', 'click', () => this.upload()); listen('cameraAudioPlay', 'click', () => this.action('POST'));
      listen('cameraAudioStop', 'click', () => this.action('DELETE')); listen('cameraAudioDelete', 'click', () => this.remove());
      listen('cameraAudioVolume', 'input', () => this.changeVolume()); listen('cameraAudioVolume', 'change', () => { void this.flushVolume(); });
    }
    get voiceBusy() { return this.state?.voiceBusy === true; }
    usable() { return this.camera.usable() && this.camera.config?.enabled === true && this.camera.opened; }
    valid(token, boat = this.camera.deviceId) { return token === this.generation && this.usable() && boat === this.camera.deviceId; }
    reset() {
      this.generation++; for (const request of this.requests) request.abort(); this.requests.clear();
      clearTimeout(this.timer); this.timer = null; this.loading = false; this.polling = false; this.busy = false; this.activity = ''; this.state = null; this.message = ''; this.pollError = ''; this.context = '';
      clearTimeout(this.volumeTimer); this.volumeTimer = null; this.volumePending = false; this.volumeSending = false; this.volumeError = '';
    }
    volumeKey() { return 'boat.camera.mp3-volume.v1.' + (this.auth.user?.username || '') + '.' + this.camera.deviceId; }
    rememberVolume() { try { window.localStorage.setItem(this.volumeKey(), String(this.volume)); } catch (_) {} }
    restoreVolume() { let saved; try { saved = window.localStorage.getItem(this.volumeKey()); } catch (_) {} this.volume = saved !== null && saved !== undefined && /^\d+$/.test(saved) && Number(saved) <= 100 ? Number(saved) : 100; }
    receiveState(state) {
      this.state = state;
      if (!this.volumeSending && !this.volumePending && ['preparing', 'playing', 'stopping'].includes(state?.playback?.status) && Number.isInteger(state.playback.volume)) this.volume = state.playback.volume;
    }
    changeVolume() {
      if (this.nodes.cameraAudioVolume.disabled) return;
      this.volume = Math.min(100, Math.max(0, Math.round(Number(this.nodes.cameraAudioVolume.value) || 0))); this.volumeVersion++; this.volumeError = ''; this.rememberVolume();
      if (['preparing', 'playing'].includes(this.state?.playback?.status) && this.state.playback.canStop) {
        this.volumePending = true; clearTimeout(this.volumeTimer); this.volumeTimer = setTimeout(() => { void this.flushVolume(); }, 180);
      }
      this.camera.render();
    }
    async flushVolume() {
      clearTimeout(this.volumeTimer); this.volumeTimer = null;
      if (!this.volumePending || this.volumeSending) return;
      const playback = this.state?.playback;
      if (!this.usable() || this.busy || !playback?.canStop || !ID.test(playback.id || '') || !['preparing', 'playing'].includes(playback.status)) { this.volumePending = false; return; }
      const token = this.generation, boat = this.camera.deviceId, version = this.actionVersion, playbackId = playback.id;
      this.volumePending = false; this.volumeSending = true;
      try {
        const state = await this.request('/api/video/camera/boats/' + encodeURIComponent(boat) + '/audio', { method: 'PATCH', body: { playbackId, volume: this.volume } });
        if (this.valid(token, boat) && version === this.actionVersion && this.state?.playback?.id === playbackId) { this.state = state; this.volumeError = ''; }
      } catch (error) {
        if (this.valid(token, boat) && version === this.actionVersion) this.volumeError = error.name === 'AbortError' ? '音量设置超时，请刷新确认' : error.message;
      } finally {
        if (token === this.generation) { this.volumeSending = false; this.camera.render(); if (this.volumePending) void this.flushVolume(); }
      }
    }
    async request(route, { method = 'GET', body, file, timeout = 10000 } = {}) {
      const controller = new AbortController(); this.requests.add(controller);
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await this.fetch(route, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', ...(file ? { 'Content-Type': 'audio/mpeg', 'X-Audio-Name': encodeURIComponent(file.name) } : body ? { 'Content-Type': 'application/json' } : {}) },
          ...(file ? { body: file } : body ? { body: JSON.stringify(body) } : {}) });
        const value = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(value.error || '服务器音频操作失败'); return value;
      } finally { clearTimeout(timer); this.requests.delete(controller); }
    }
    schedule() {
      if (!this.usable() || this.timer || this.polling) return;
      this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, 1500);
    }
    async poll() {
      if (!this.usable() || this.polling) return;
      const token = this.generation, boat = this.camera.deviceId, version = this.actionVersion, volumeVersion = this.volumeVersion; this.polling = true;
      try {
        const state = await this.request('/api/video/camera/boats/' + encodeURIComponent(boat) + '/audio');
        if (this.valid(token, boat) && version === this.actionVersion && volumeVersion === this.volumeVersion) { this.receiveState(state); this.pollError = ''; }
      } catch (error) { if (this.valid(token, boat)) this.pollError = error.name === 'AbortError' ? '读取播报状态超时，请刷新重试' : error.message; }
      finally { if (token === this.generation) { this.polling = false; this.camera.render(); this.schedule(); } }
    }
    async loadLibrary(selected) {
      if (!this.usable() || this.loading) return;
      const token = this.generation, previous = selected || this.nodes.cameraAudioSelect.value; this.loading = true; this.camera.render();
      try {
        const value = await this.request(LIBRARY);
        if (!this.valid(token)) return;
        if (!Array.isArray(value.files)) throw Error('服务器音频列表格式无效');
        this.library = value; this.nodes.cameraAudioSelect.replaceChildren();
        const placeholder = this.document.createElement('option'); placeholder.value = ''; placeholder.textContent = value.files.length ? '请选择要播报的 MP3' : '还没有音频，请管理员上传 MP3'; this.nodes.cameraAudioSelect.append(placeholder);
        for (const file of value.files) if (ID.test(file.id || '')) {
          const option = this.document.createElement('option'); option.value = file.id; option.textContent = file.name + ' · ' + duration(file.duration); this.nodes.cameraAudioSelect.append(option);
        }
        this.nodes.cameraAudioSelect.value = value.files.some(file => file.id === previous) ? previous : value.files[0]?.id || '';
      } catch (error) { if (this.valid(token)) this.show(error.name === 'AbortError' ? '读取音频列表超时' : error.message, 'danger'); }
      finally { if (token === this.generation) { this.loading = false; this.camera.render(); } }
    }
    show(message, tone = '') { this.message = message; this.tone = tone; }
    async upload() {
      const file = this.nodes.cameraAudioFile.files?.[0];
      if (this.busy || !file || !this.usable()) return;
      if (!/\.mp3$/i.test(file.name) || file.size > 20 * 1024 * 1024) { this.show('请选择20MB以内的 MP3 文件', 'danger'); this.camera.render(); return; }
      const token = this.generation; this.busy = true; this.show('正在上传并校验 MP3…'); this.camera.render();
      try {
        const value = await this.request(LIBRARY, { method: 'POST', file, timeout: 75000 });
        if (!this.valid(token)) return;
        this.nodes.cameraAudioFile.value = ''; this.show('上传成功，已保存在服务器。', 'success'); await this.loadLibrary(value.file?.id);
      } catch (error) { if (this.valid(token)) this.show(error.name === 'AbortError' ? '上传超时，请刷新列表确认后重试' : error.message, 'danger'); }
      finally { if (token === this.generation) { this.busy = false; this.camera.render(); } }
    }
    async action(method) {
      const interrupting = method === 'DELETE' && this.activity === 'starting' && this.state?.playback?.canStop;
      if (!this.usable() || this.busy && !interrupting || method === 'POST' && !ID.test(this.nodes.cameraAudioSelect.value)) return;
      clearTimeout(this.volumeTimer); this.volumeTimer = null; this.volumePending = false; this.volumeError = '';
      const token = this.generation, boat = this.camera.deviceId, version = ++this.actionVersion; this.busy = true; this.activity = method === 'POST' ? 'starting' : 'stopping';
      this.show(method === 'POST' ? '正在连接摄像头并准备播报…' : '正在停止播报…'); this.camera.render();
      try {
        const state = await this.request('/api/video/camera/boats/' + encodeURIComponent(boat) + '/audio', { method, ...(method === 'POST' ? { body: { fileId: this.nodes.cameraAudioSelect.value, volume: this.volume } } : {}), timeout: 45000 });
        if (this.valid(token, boat) && version === this.actionVersion) { this.receiveState(state); this.show('', 'success'); }
      } catch (error) { if (this.valid(token, boat) && version === this.actionVersion) this.show(error.name === 'AbortError' ? '操作超时，请刷新播报状态后重试' : error.message, 'danger'); }
      finally { if (token === this.generation && version === this.actionVersion) { this.busy = false; this.activity = ''; this.camera.render(); void this.poll(); } }
    }
    async remove() {
      const id = this.nodes.cameraAudioSelect.value, file = this.library?.files.find(row => row.id === id);
      if (this.busy || !this.usable() || !file || !window.confirm('删除服务器音频“' + file.name + '”？')) return;
      const token = this.generation; this.busy = true; this.camera.render();
      try { await this.request(LIBRARY + '/' + id, { method: 'DELETE' }); if (this.valid(token)) { this.show('音频已删除。', 'success'); await this.loadLibrary(); } }
      catch (error) { if (this.valid(token)) this.show(error.message, 'danger'); }
      finally { if (token === this.generation) { this.busy = false; this.camera.render(); } }
    }
    render(ready) {
      const context = JSON.stringify([this.camera.deviceId, this.camera.identity, this.camera.config?.revision, this.usable()]);
      if (context !== this.context) {
        this.reset(); this.context = context; this.restoreVolume();
        if (!this.camera.authorized()) this.library = null;
        if (this.usable()) { if (!this.library) void this.loadLibrary(); void this.poll(); }
      }
      const n = this.nodes, admin = this.auth.user?.role === 'admin', file = this.library?.files.find(row => row.id === n.cameraAudioSelect.value), playback = this.state?.playback;
      const running = ['preparing', 'playing', 'stopping'].includes(playback?.status), working = this.busy || this.loading;
      n.cameraAudioUploadArea.hidden = !admin; n.cameraAudioDelete.hidden = !admin;
      n.cameraAudioUpload.disabled = !ready || !admin || working || this.library?.available !== true || !n.cameraAudioFile.files?.length;
      n.cameraAudioFile.disabled = !ready || working; n.cameraAudioSelect.disabled = !ready || working || !this.library?.files.length;
      n.cameraAudioRefresh.disabled = !ready || working;
      n.cameraAudioPlay.disabled = !ready || working || !file || this.library?.available !== true || this.voiceBusy || !!this.camera.talk;
      n.cameraAudioStop.disabled = !ready || this.busy && this.activity !== 'starting' || !running || !playback?.canStop;
      n.cameraAudioDelete.disabled = !ready || working || !file || running && playback.fileId === file.id;
      n.cameraAudioVolume.disabled = !ready || working || this.library?.available !== true || this.voiceBusy && (!running || !playback?.canStop) || playback?.status === 'stopping';
      n.cameraAudioVolume.value = String(this.volume); n.cameraAudioVolumeValue.textContent = this.volume === 0 ? '0% · 静音' : this.volume + '%';
      const state = playback?.status;
      const status = state === 'playing' ? '正在播报：' + playback.name + ' · ' + duration(playback.elapsed) + ' / ' + duration(playback.duration) : state === 'preparing' ? '正在准备：' + playback.name : state === 'stopping' ? '正在结束音频通道…' : state === 'failed' ? playback.error || '播报失败，请重新连接摄像头' : state === 'completed' ? '已播报完成：' + playback.name : state === 'stopped' ? '已停止播报' : this.voiceBusy ? '摄像头正在对讲，请先结束通话。' : '';
      n.cameraAudioStatus.textContent = this.busy ? this.message : this.volumeError || this.pollError || status || this.message || this.library?.reason || '选择音频后点击一键播放，无需电脑麦克风。';
      n.cameraAudioStatus.dataset.tone = state === 'failed' || this.pollError || this.volumeError ? 'danger' : running ? 'success' : this.tone;
      this.schedule();
    }
  }
  window.BoatCameraAudio = BoatCameraAudio;
})();
