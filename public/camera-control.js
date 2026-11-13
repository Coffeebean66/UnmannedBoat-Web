/* 云台按住控制与浏览器麦克风对讲；切船、离页、失焦、注销均释放设备与麦克风。 */
(() => {
  'use strict';
  const BASE = '/api/video/camera/boats/', ID = /^[A-Za-z0-9_-]{1,64}$/;
  class BoatCameraControl {
    constructor({ document = window.document, auth = window.BoatAuth, fetcher = window.fetch.bind(window), mediaDevices = window.navigator.mediaDevices,
      PeerConnection = window.RTCPeerConnection, Sender = window.RTCRtpSender, MediaStream = window.MediaStream } = {}) {
      Object.assign(this, { document, auth, fetch: fetcher, mediaDevices, PeerConnection, Sender, MediaStream });
      this.nodes = Object.fromEntries(['cameraControlToggle', 'cameraControls', 'cameraControlClose', 'cameraControlBoat', 'cameraPtzStop', 'cameraPtzSpeed', 'cameraSpeedValue', 'cameraTalkMode', 'cameraTalkStart', 'cameraTalkStop', 'cameraMicMute', 'cameraListen', 'cameraVoiceHint', 'cameraControlStatus', 'cameraTalkAudio', 'boatVideo'].map(id => [id, document.getElementById(id)]));
      this.buttons = [...this.nodes.cameraControls.querySelectorAll('[data-camera-command]')];
      this.deviceId = ''; this.authenticated = false; this.visible = false; this.opened = false; this.destroyed = false;
      this.config = null; this.loading = false; this.generation = 0; this.configGeneration = 0; this.ptz = null; this.talk = null; this.pendingStop = Promise.resolve();
      this.requests = new Set(); this.handlers = []; this.identity = this.authIdentity();
      this.audioFiles = window.BoatCameraAudio ? new window.BoatCameraAudio({ camera: this, document, auth, fetcher }) : null;
      this.configLoadedAt = 0;
      this.gamepadCommand = ''; this.gamepadNeedsNeutral = true;
      this.panelHome = document.createComment('camera controls home'); this.nodes.cameraControls.before(this.panelHome);
      this.toggleHome = document.createComment('camera toggle home'); this.nodes.cameraControlToggle.before(this.toggleHome);
      this.authChanged = () => { const next = this.authIdentity(); if (this.identity !== next) { this.identity = next; this.reset(); if (this.usable()) this.load(); } this.render(); };
      this.auth?.addEventListener('change', this.authChanged);
      this.listen(this.nodes.cameraControlToggle, 'click', () => { this.opened = !this.opened; if (this.opened) this.load(); else { this.endPtz(); this.stopTalk(); } this.render(); });
      this.listen(this.nodes.cameraControlClose, 'click', () => { this.opened = false; this.endPtz(); this.stopTalk(); this.render(); });
      this.listen(this.nodes.cameraPtzStop, 'click', () => { this.resetGamepadPtz(); this.endPtz(); });
      this.listen(this.nodes.cameraPtzSpeed, 'input', () => { this.nodes.cameraSpeedValue.value = this.nodes.cameraPtzSpeed.value; });
      this.listen(this.nodes.cameraTalkMode, 'change', () => this.render());
      this.listen(this.nodes.cameraTalkStart, 'click', () => this.startTalk());
      this.listen(this.nodes.cameraTalkStop, 'click', () => this.stopTalk('语音已结束，麦克风已关闭。'));
      this.listen(this.nodes.cameraMicMute, 'click', () => { const job = this.talk; if (job?.stream) { job.muted = !job.muted; for (const track of job.stream.getAudioTracks()) track.enabled = !job.muted; this.render(); } });
      this.listen(this.nodes.cameraListen, 'click', () => {
        if (this.talk) { this.nodes.cameraTalkAudio.play()?.then(() => { if (this.talk) this.talk.audioBlocked = false; this.render(); }).catch(() => this.notice('浏览器尚未允许播放声音，请检查音量与站点权限。', 'danger')); return; }
        const video = this.nodes.boatVideo; video.muted = !video.muted; if (!video.muted) video.play()?.catch(() => {}); this.render();
      });
      for (const button of this.buttons) {
        this.listen(button, 'pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); button.setPointerCapture?.(event.pointerId); this.startPtz(button.dataset.cameraCommand, button); });
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this.listen(button, name, () => { if (this.ptz?.button === button) this.endPtz(); });
        this.listen(button, 'contextmenu', event => event.preventDefault());
        this.listen(button, 'keydown', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) this.startPtz(button.dataset.cameraCommand, button); } });
        this.listen(button, 'keyup', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); this.endPtz(); } });
        this.listen(button, 'blur', () => { if (this.ptz?.button === button) this.endPtz(); });
      }
      this.listen(window, 'blur', () => { this.resetGamepadPtz(); this.endPtz(); this.stopTalk(); });
      this.listen(document, 'visibilitychange', () => { if (document.hidden) { this.resetGamepadPtz(); this.endPtz(); this.stopTalk(); } });
      this.render();
    }
    listen(node, event, handler) { node.addEventListener(event, handler); this.handlers.push([node, event, handler]); }
    authIdentity() { return JSON.stringify([this.auth?.generation, this.auth?.ready, this.auth?.user?.username, this.auth?.user?.role]); }
    authorized() { return this.auth?.ready && this.auth.enabled && ['admin', 'driver'].includes(this.auth.user?.role); }
    usable() { return !this.destroyed && this.authorized() && this.authenticated && this.visible && ID.test(this.deviceId); }
    notice(text, tone = 'neutral') { this.nodes.cameraControlStatus.textContent = text; this.nodes.cameraControlStatus.dataset.tone = tone; }
    update({ deviceId = '', authenticated = false } = {}) {
      if (deviceId !== this.deviceId || authenticated !== this.authenticated) { this.reset(); this.deviceId = ID.test(deviceId) ? deviceId : ''; this.authenticated = !!authenticated; }
      if (this.usable() && !this.loading && Date.now() - this.configLoadedAt >= 10000) this.load(); this.render();
    }
    syncWorkspace() {
      const driving = window.BoatWorkspace?.current === 'driving', stage = this.document.getElementById('driverStage'), tools = this.document.getElementById('driverFocusTools');
      // 面板直接挂在驾驶画布，避免被图传小窗裁剪或被底部仪表遮住。
      if (driving && stage && tools) {
        if (this.nodes.cameraControls.parentNode !== stage) stage.append(this.nodes.cameraControls);
        if (this.nodes.cameraControlToggle.parentNode !== tools) tools.append(this.nodes.cameraControlToggle);
      } else {
        this.panelHome.after(this.nodes.cameraControls); this.toggleHome.after(this.nodes.cameraControlToggle);
      }
    }
    setVisible(visible) {
      this.syncWorkspace();
      if (this.visible === !!visible) return; this.visible = !!visible;
      if (!this.visible) { this.opened = false; this.resetGamepadPtz(); this.endPtz(); this.stopTalk(); }
      else if (this.usable()) this.load(); this.render();
    }
    reset() {
      ++this.generation; ++this.configGeneration; for (const controller of this.requests) controller.abort(); this.requests.clear();
      this.resetGamepadPtz(); this.endPtz(); this.stopTalk(); this.config = null; this.configLoadedAt = 0; this.loading = false; this.opened = false;
      this.audioFiles?.reset();
    }
    async request(id, route, { method = 'GET', body, sdp, keepalive = false, signal, timeout = 8000 } = {}) {
      const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort(); if (!keepalive) this.requests.add(controller);
      const timer = setTimeout(abort, timeout);
      try {
        const response = await this.fetch(BASE + encodeURIComponent(id) + route, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', keepalive,
          signal: controller.signal, headers: { Accept: sdp !== undefined ? 'application/sdp' : 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : sdp !== undefined ? { 'Content-Type': 'application/sdp' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : sdp !== undefined ? { body: sdp } : {}) });
        if (!response.ok) { const data = await response.json().catch(() => ({})); throw Object.assign(Error(data.error || '摄像头连接失败，请重试'), { status: response.status }); }
        return sdp !== undefined ? await response.text() : await response.json();
      } finally { clearTimeout(timer); this.requests.delete(controller); signal?.removeEventListener('abort', abort); }
    }
    async load() {
      if (!this.usable() || this.loading) return;
      const token = ++this.configGeneration, id = this.deviceId; this.loading = true; this.configLoadedAt = Date.now(); this.render();
      try {
        const data = await this.request(id, ''); if (!this.usable() || token !== this.configGeneration || id !== this.deviceId) return;
        if (this.config?.revision !== undefined && this.config.revision !== data.revision) { this.resetGamepadPtz(); this.endPtz(); this.stopTalk(); }
        const changed = !this.config || ['enabled', 'revision', 'voice'].some(key => this.config[key] !== data[key]);
        this.config = data;
        if (changed && !this.ptz && !this.talk) this.notice(data.enabled ? '云台按住移动、松开停止；语音需单独授权麦克风。' : data.reason || '当前船未绑定 WVP 摄像头');
      } catch (error) { if (token === this.configGeneration && this.usable()) this.notice(error.message || '摄像头配置读取失败', 'danger'); }
      finally { if (token === this.configGeneration) { this.loading = false; this.render(); } }
    }
    render() {
      const n = this.nodes, ready = this.usable() && this.config?.enabled === true;
      n.cameraControlToggle.hidden = !this.authorized() || !this.deviceId || this.config?.enabled === false;
      n.cameraControlToggle.disabled = !this.usable(); n.cameraControlToggle.setAttribute('aria-expanded', String(this.opened));
      n.cameraControls.hidden = !this.opened || !this.usable(); n.cameraControlBoat.textContent = this.deviceId || '未选择无人船';
      for (const button of this.buttons) button.disabled = !ready;
      n.cameraPtzStop.disabled = !ready; n.cameraPtzSpeed.disabled = !ready;
      n.cameraTalkMode.disabled = !ready || !!this.talk;
      n.cameraTalkStart.disabled = !ready || !this.config?.voice || !!this.talk || !!this.audioFiles?.voiceBusy || !this.mediaDevices?.getUserMedia || !this.PeerConnection;
      n.cameraTalkStart.textContent = this.talk ? '正在连接 / 通话中' : n.cameraTalkMode.value === 'broadcast' ? '开始喊话' : '开始对讲';
      n.cameraTalkStop.disabled = !this.talk; n.cameraMicMute.disabled = !this.talk?.stream;
      n.cameraMicMute.textContent = this.talk?.muted ? '打开麦克风' : '关闭麦克风'; n.cameraMicMute.setAttribute('aria-pressed', String(!!this.talk?.muted));
      n.cameraListen.disabled = !ready || !!this.talk && !this.talk.audioBlocked;
      n.cameraListen.textContent = this.talk ? '播放对讲声音' : n.boatVideo.muted ? '监听画面声音' : '关闭画面声音';
      n.cameraListen.setAttribute('aria-pressed', String(!n.boatVideo.muted && !this.talk));
      n.cameraVoiceHint.textContent = !this.mediaDevices?.getUserMedia ? '麦克风需要 HTTPS（本机可用 localhost）及浏览器授权。' : this.config?.voice === false ? this.config.voiceReason : '推荐兼容对讲；图传需开启音频。仅需向扬声器讲话时选单向喊话，国标双向对讲需设备支持。';
      this.audioFiles?.render(ready);
    }
    // 十字键与 RT 变焦使用同一云台租约；面板收起也可操作，切换目标后须先松键。
    resetGamepadPtz() {
      this.gamepadNeedsNeutral = true; this.gamepadCommand = '';
      if (this.ptz?.source === 'gamepad') this.endPtz();
    }
    setGamepadDirection(x, y, zoom = 0) {
      if (![x, y, zoom].every(value => [-1, 0, 1].includes(value))) { this.resetGamepadPtz(); return false; }
      // 国标接口每次发送一种操作，RT 变焦优先；方向和变焦共用续租、停止与换向队列。
      const command = zoom ? zoom > 0 ? 'zoomin' : 'zoomout' : (y < 0 ? 'up' : y > 0 ? 'down' : '') + (x < 0 ? 'left' : x > 0 ? 'right' : '');
      if (!command) {
        this.gamepadNeedsNeutral = false; this.gamepadCommand = '';
        if (this.ptz?.source === 'gamepad') this.endPtz();
        return false;
      }
      if (this.gamepadNeedsNeutral) return false;
      if (command === this.gamepadCommand) return this.ptz?.source === 'gamepad';
      this.gamepadCommand = command;
      if (!this.usable() || !this.config?.enabled) { this.resetGamepadPtz(); return false; }
      const button = this.buttons.find(node => node.dataset.cameraCommand === command);
      if (!button) return false;
      // 同方向长按由 startPtz 每350ms续租；失败后不逐帧重试，需松键或换向。
      void this.startPtz(command, button, 'gamepad');
      return true;
    }
    async startPtz(command, button, source = 'panel') {
      if (!this.usable() || source !== 'gamepad' && !this.opened || !this.config?.enabled) return;
      if (source !== 'gamepad') this.resetGamepadPtz();
      this.endPtz();
      const job = { id: this.deviceId, leaseId: [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join(''), sequence: 0, command, button, source, ended: false };
      this.ptz = job; button.dataset.held = 'true';
      const send = async () => {
        if (this.ptz !== job || job.ended || !this.usable()) return;
        try {
          await this.request(job.id, '/ptz', { method: 'POST', body: { command, speed: Number(this.nodes.cameraPtzSpeed.value), zoomSpeed: 4, leaseId: job.leaseId, sequence: ++job.sequence }, timeout: 5000 });
          if (this.ptz === job && !job.ended) { this.notice('云台移动中，松开按键即停止。', 'success'); job.timer = setTimeout(send, 350); }
        } catch (error) { if (this.ptz === job && !job.ended) { this.notice(error.message || '云台控制失败', 'danger'); this.endPtz(); } }
      };
      await this.pendingStop; if (this.ptz === job && !job.ended) send();
    }
    endPtz() {
      const job = this.ptz; if (!job) return this.pendingStop;
      this.ptz = null; job.ended = true; clearTimeout(job.timer); delete job.button.dataset.held;
      // 快速斜向 / 换向可能取消尚在等待的操作，停止也排队，避免新租约抢在旧停止之前。
      this.pendingStop = this.pendingStop.then(() => this.request(job.id, '/ptz', { method: 'POST', keepalive: true, timeout: 5000, body: { command: 'stop', speed: 100, zoomSpeed: 4, leaseId: job.leaseId, sequence: ++job.sequence } }))
        .then(data => { if (!this.ptz && this.deviceId === job.id && this.visible) this.notice(data.stopped ? '云台已停止。' : '停止指令正在重试，请确认摄像头通信正常。', data.stopped ? 'neutral' : 'danger'); })
        .catch(() => { if (!this.ptz && this.deviceId === job.id && this.visible) this.notice('尚未收到云台停止确认，服务器会按租约停止并重试。', 'danger'); });
      return this.pendingStop;
    }
    isTalk(job) { return this.talk === job && !job.ended && this.usable(); }
    async waitFor(job, pc, event, done, timeout) {
      await new Promise((resolve, reject) => {
        let finished = false;
        const finish = error => { if (finished) return; finished = true; clearTimeout(timer); pc.removeEventListener(event, changed); job.waiters.delete(cancel); error ? reject(error) : resolve(); };
        const cancel = () => finish(Error('语音连接已取消'));
        const changed = () => { if (!this.isTalk(job)) return cancel(); if (done()) finish(); else if (['failed', 'closed'].includes(pc.connectionState)) finish(Error('语音网络连接失败，请检查服务器 WebRTC 端口')); };
        const timer = setTimeout(() => finish(Error('语音连接超时，请检查摄像头对讲能力与服务器 WebRTC 端口')), timeout);
        job.waiters.add(cancel); pc.addEventListener(event, changed); changed();
      });
    }
    discardPeer(job, direction) { const pc = job.peers.get(direction); if (pc) { pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); job.peers.delete(direction); } }
    async peer(job, direction) {
      this.discardPeer(job, direction);
      const pc = new this.PeerConnection({ iceServers: [] }); job.peers.set(direction, pc);
      try {
        const transceiver = direction === 'push' ? pc.addTransceiver(job.stream.getAudioTracks()[0], { direction: 'sendonly', streams: [job.stream] }) : pc.addTransceiver('audio', { direction: 'recvonly' });
        const codecs = this.Sender?.getCapabilities?.('audio')?.codecs?.filter(codec => codec.mimeType.toLowerCase() === 'audio/pcma');
        if (transceiver.setCodecPreferences && codecs?.length) transceiver.setCodecPreferences(codecs);
        pc.ontrack = event => {
          if (!this.isTalk(job)) { event.track.stop(); return; }
          this.nodes.cameraTalkAudio.srcObject = event.streams?.[0] || new this.MediaStream([event.track]);
          this.nodes.cameraTalkAudio.play()?.catch(() => { if (this.isTalk(job)) { job.audioBlocked = true; this.notice('对讲已接通，点击“播放对讲声音”允许播放。'); this.render(); } });
        };
        pc.onconnectionstatechange = () => { if (this.isTalk(job) && job.ready && ['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.stopTalk('语音网络中断，已关闭麦克风，请重新连接。'); };
        await pc.setLocalDescription(await pc.createOffer());
        await this.waitFor(job, pc, 'icegatheringstatechange', () => pc.iceGatheringState === 'complete', 7000);
        const sdp = await this.request(job.id, '/talk/' + job.session + '/' + direction, { method: 'POST', sdp: pc.localDescription.sdp, signal: job.controller.signal, timeout: 15000 });
        if (!this.isTalk(job)) throw Error('语音连接已取消');
        await pc.setRemoteDescription({ type: 'answer', sdp });
        await this.waitFor(job, pc, 'connectionstatechange', () => pc.connectionState === 'connected', 12000);
      } catch (error) { this.discardPeer(job, direction); throw error; }
    }
    async startTalk() {
      if (this.nodes.cameraTalkStart.disabled || !this.usable() || this.talk) return;
      const job = { id: this.deviceId, mode: this.nodes.cameraTalkMode.value, controller: new AbortController(), peers: new Map(), waiters: new Set(), ended: false, originalMuted: this.nodes.boatVideo.muted };
      this.talk = job; this.nodes.boatVideo.muted = true; this.notice('请允许麦克风，正在连接语音…'); this.render();
      try {
        const stream = await this.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (!this.isTalk(job)) { stream.getTracks().forEach(track => track.stop()); return; } job.stream = stream;
        for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (this.isTalk(job)) this.stopTalk('麦克风已断开，语音已结束。'); }, { once: true });
        const data = await this.request(job.id, '/talk', { method: 'POST', body: { mode: job.mode }, signal: job.controller.signal, timeout: 45000 });
        if (!/^[a-f0-9]{32}$/.test(data.id || '')) throw Error('服务器返回了无效语音会话');
        if (!this.isTalk(job)) { this.request(job.id, '/talk/' + data.id, { method: 'DELETE', keepalive: true }).catch(() => {}); return; }
        job.session = data.id;
        job.heartbeat = setInterval(async () => {
          if (!this.isTalk(job) || job.beating) return; job.beating = true;
          try { await this.request(job.id, '/talk/' + job.session + '/heartbeat', { method: 'POST', signal: job.controller.signal, timeout: 4500 }); }
          catch (_) { if (this.isTalk(job)) this.stopTalk('语音控制连接已中断，麦克风已关闭。'); }
          finally { job.beating = false; }
        }, 1500);
        await this.peer(job, 'push'); if (!this.isTalk(job)) return;
        if (job.mode !== 'broadcast') {
          this.notice(job.mode === 'compatible' ? '麦克风已连接，正在接入摄像头图传音频…' : '麦克风已连接，正在等待摄像头语音回传…');
          const until = Date.now() + 20000;
          for (;;) {
            try { await this.peer(job, 'play'); break; }
            catch (error) {
              if (!this.isTalk(job) || ![404, 503, 504].includes(error.status) || Date.now() >= until) throw error;
              await new Promise(resolve => { job.delayResolve = resolve; job.delay = setTimeout(resolve, 1000); }); job.delayResolve = null;
            }
          }
        }
        if (!this.isTalk(job)) return; job.ready = true;
        this.notice(job.mode === 'compatible' ? '兼容对讲已连接：麦克风通过喊话通道发送，摄像头声音来自图传音轨；结束通话会关闭麦克风。' : job.mode === 'talk' ? '双向对讲已连接，麦克风正在发送；结束通话会关闭麦克风。' : '喊话音频已发送，麦克风正在工作；结束通话会关闭麦克风。', 'success'); this.render();
      } catch (error) {
        if (this.talk !== job) return;
        const message = error.name === 'NotAllowedError' ? '麦克风权限未授权，请在浏览器地址栏允许麦克风后重试。' : error.name === 'NotFoundError' ? '未找到麦克风，请连接或启用电脑麦克风。' : error.message || '语音连接失败，请检查摄像头和服务器。';
        this.stopTalk(); this.notice(message, 'danger');
      }
    }
    stopTalk(message) {
      const job = this.talk; if (!job) return;
      this.talk = null; job.ended = true; job.controller.abort(); clearInterval(job.heartbeat); clearTimeout(job.delay); job.delayResolve?.();
      for (const cancel of [...job.waiters]) cancel(); for (const direction of [...job.peers.keys()]) this.discardPeer(job, direction);
      for (const track of job.stream?.getTracks() || []) track.stop();
      const audio = this.nodes.cameraTalkAudio; for (const track of audio.srcObject?.getTracks() || []) track.stop(); audio.pause(); audio.srcObject = null;
      if (job.id === this.deviceId && this.authenticated) this.nodes.boatVideo.muted = job.originalMuted;
      if (job.session) this.request(job.id, '/talk/' + job.session, { method: 'DELETE', keepalive: true }).catch(() => {});
      this.notice(message || '语音已结束，麦克风已关闭。'); this.render();
    }
    destroy() { if (this.destroyed) return; this.reset(); this.destroyed = true; this.auth?.removeEventListener('change', this.authChanged); for (const [node, event, handler] of this.handlers) node.removeEventListener(event, handler); this.handlers = []; }
  }
  window.BoatCameraControl = BoatCameraControl;
})();
