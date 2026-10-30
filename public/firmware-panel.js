/* 固件任务属于服务器和指定船只；关闭弹窗只停止查询，不会取消后台升级。 */
(function (scope) {
  'use strict';
  const DEVICE = /^[A-Za-z0-9_-]{1,64}$/, BASE = '/api/firmware';
  const ACTIVE = new Set(['queued', 'transferring', 'verifying', 'installing']);
  const STATES = { queued: '等待单片机准备', transferring: '传输固件', verifying: '校验下载内容', installing: '等待重启验证',
    succeeded: '升级完成', failed: '升级失败', cancelled: '已取消', unknown: '尚未确认升级结果' };
  const cancelled = () => Object.assign(Error('固件请求已取消'), { cancelled: true });
  class BoatFirmwarePanel {
    constructor(options = {}) {
      this.document = options.document || scope.document; this.auth = options.auth || scope.BoatAuth;
      this.fetch = options.fetcher || scope.fetch.bind(scope);
      this.confirm = options.confirm || scope.confirm.bind(scope);
      this.AbortController = options.AbortController || scope.AbortController;
      this.setTimer = options.setTimeout || scope.setTimeout.bind(scope); this.clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
      this.nodes = Object.fromEntries(['firmwareDialog', 'firmwareClose', 'firmwareDevice', 'firmwareStatus', 'firmwareCapability',
        'firmwareFile', 'firmwareFileInfo', 'firmwareStart', 'firmwareForceStart', 'firmwareForceHint', 'firmwareCancel', 'firmwareRefresh', 'firmwareProgress',
        'firmwarePhase', 'firmwarePercent', 'firmwareBytes', 'firmwareHash', 'firmwareJobName'].map(id => [id, this.document.getElementById(id)]));
      this.listeners = []; this.deviceId = ''; this.config = null; this.snapshot = null; this.busy = false;
      this.opened = false; this.destroyed = false; this.generation = 0; this.poll = null; this.identity = this._identity();
      this.listen('firmwareClose', 'click', () => this.nodes.firmwareDialog.close());
      // 原生 close 事件可能排队到下一轮；快速重新打开时不能清掉新船任务。
      this.listen('firmwareDialog', 'close', () => { if (!this.nodes.firmwareDialog.open) this.close(); });
      this.listen('firmwareFile', 'change', () => this.render());
      this.listen('firmwareRefresh', 'click', () => this.refresh());
      this.listen('firmwareStart', 'click', () => this.start());
      this.listen('firmwareForceStart', 'click', () => this.start(true));
      this.listen('firmwareCancel', 'click', () => this.cancel());
      this.onAuth = () => {
        const next = this._identity();
        if (next !== this.identity) { this.identity = next; this.close(); this.nodes.firmwareDialog.close(); }
        this.render();
      };
      this.auth?.addEventListener('change', this.onAuth); this.render();
    }
    _identity() { return JSON.stringify([this.auth?.generation, this.auth?.enabled, this.auth?.ready, this.auth?.user?.username, this.auth?.user?.role]); }
    admin() { return !this.destroyed && this.auth?.enabled === true && this.auth?.ready === true && this.auth.user?.role === 'admin'; }
    listen(id, event, handler) { const node = this.nodes[id]; node.addEventListener(event, handler); this.listeners.push([node, event, handler]); }
    notice(text, tone = 'neutral') { this.nodes.firmwareStatus.textContent = text; this.nodes.firmwareStatus.dataset.tone = tone; }
    _stopPoll() { if (this.poll !== null) this.clearTimer(this.poll); this.poll = null; }
    _schedule() {
      this._stopPoll();
      if (this.opened && this.admin()) this.poll = this.setTimer(() => { this.poll = null; this.refresh(); }, this.snapshot?.job && ACTIVE.has(this.snapshot.job.state) ? 1000 : 4000);
    }
    _invalidate() { ++this.generation; this.cancelRequest?.(); this.busy = false; this._stopPoll(); }
    async open(id) {
      if (!this.admin() || !DEVICE.test(id || '')) return false;
      this._invalidate(); this.deviceId = id; this.config = null; this.snapshot = null; this.nodes.firmwareFile.value = '';
      this.opened = true; this.notice('正在检查服务器配置与这艘船的升级能力…');
      if (!this.nodes.firmwareDialog.open) this.nodes.firmwareDialog.showModal();
      this.render(); return this.refresh();
    }
    close() {
      this.opened = false; this._invalidate(); this.deviceId = ''; this.snapshot = null; this.config = null;
      this.nodes.firmwareFile.value = ''; this.render();
    }
    current(generation, id) { return this.opened && this.admin() && this.generation === generation && this.deviceId === id; }
    request(method, url, body, current, { force = false } = {}) {
      return new Promise((resolve, reject) => {
        const controller = this.AbortController ? new this.AbortController() : null;
        let settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; this.clearTimer(timer); if (this.cancelRequest === cancel) this.cancelRequest = null; error ? reject(error) : resolve(value); };
        const cancel = () => { finish(cancelled()); controller?.abort(); };
        const timer = this.setTimer(() => { finish(Error('固件请求超时，请重新读取任务状态确认，服务器可能已接收。')); controller?.abort(); }, 30000);
        this.cancelRequest = cancel;
        Promise.resolve().then(async () => {
          if (method !== 'GET') await this.auth.verifyManage?.();
          if (settled || !current()) throw cancelled();
          const upload = method === 'POST' && body && typeof body.name === 'string';
          const response = await this.fetch(url, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller?.signal,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': upload ? 'application/octet-stream' : 'application/json' } : {}),
              ...(upload ? { 'X-Firmware-Name': encodeURIComponent(body.name), ...(force ? { 'X-Firmware-Force': '1' } : {}) } : {}) }, ...(body ? { body: upload ? body : JSON.stringify(body) } : {}) });
          const value = await response.json().catch(() => ({}));
          if (!current()) throw cancelled();
          if (!response.ok) {
            if (response.status === 401) this.auth.expire?.();
            throw Error(value.error || '固件操作失败（' + response.status + '）');
          }
          finish(null, value);
        }).catch(error => finish(error));
      });
    }
    async run(operation) {
      if (!this.opened || !this.admin() || this.busy) return false;
      const generation = this.generation, id = this.deviceId, current = () => this.current(generation, id);
      this.busy = true; this._stopPoll(); this.render();
      try { await operation(id, current); return current(); }
      catch (error) { if (current() && !error.cancelled) this.notice(error.message, 'error'); return false; }
      finally { if (current()) { this.busy = false; this.render(); this._schedule(); } }
    }
    accept(value, id) {
      if (!value || value.deviceId !== id || typeof value.supported !== 'boolean' || typeof value.online !== 'boolean' ||
          value.job && (!Object.hasOwn(STATES, value.job.state) || value.job.deviceId !== id)) throw Error('固件任务响应无效，请重新读取');
      this.snapshot = value; this.describe();
    }
    refresh() {
      return this.run(async (id, current) => {
        if (!this.config) {
          const config = await this.request('GET', BASE + '/config', null, current);
          if (typeof config.enabled !== 'boolean') throw Error('固件服务配置响应无效');
          this.config = config;
        }
        this.accept(await this.request('GET', BASE + '/boats/' + encodeURIComponent(id), null, current), id);
      });
    }
    file() { return this.nodes.firmwareFile.files?.[0] || null; }
    fileValid() { const file = this.file(); return !!(file && /\.bin$/i.test(file.name) && file.size >= 256 && file.size <= (this.config?.maxSize || 655360)); }
    ready(force = false) {
      const cap = this.snapshot?.capability;
      return !!(this.config?.enabled && this.snapshot?.supported && this.snapshot.online &&
        (force ? this.config.forceSupported === true && cap?.forceSupported === true && cap.forceReady === true : cap?.ready) &&
        ['idle', 'failed'].includes(cap.state) && !ACTIVE.has(this.snapshot.job?.state));
    }
    start(force = false) {
      if (!this.ready(force) || !this.fileValid() || this.busy || !this.admin()) return Promise.resolve(false);
      const file = this.file(), id = this.deviceId;
      const prompt = force ? '强制 OTA 升级“' + file.name + '”到 ' + id + '？\n适用于电调、接收机或传感器未通电、没有外设数据的维护场景。请确认推进器已断电或船已停稳；单片机会检查 PWM 归零并锁定推进。升级期间保持单片机供电与网络稳定，完成后自动重启。关闭窗口不会取消任务。' :
        '将固件“' + file.name + '”升级到 ' + id + '？\n请保持 CH6 低档、电机停稳和供电稳定。升级会锁定推进并自动重启；关闭此窗口不会取消任务。';
      if (!this.confirm(prompt)) return Promise.resolve(false);
      return this.run(async (target, current) => {
        this.notice(force ? '正在上传固件，准备强制 OTA 升级…' : '正在上传固件到服务器…');
        this.accept(await this.request('POST', BASE + '/boats/' + encodeURIComponent(target), file, current, { force }), target);
        this.nodes.firmwareFile.value = '';
      });
    }
    cancel() {
      if (!this.snapshot?.job?.cancelable || this.busy || !this.admin()) return Promise.resolve(false);
      if (!this.confirm('取消 ' + this.deviceId + ' 的本次固件传输？安装已提交后无法取消。')) return Promise.resolve(false);
      return this.run(async (id, current) => {
        this.accept(await this.request('POST', BASE + '/boats/' + encodeURIComponent(id) + '/cancel', {}, current), id);
      });
    }
    describe() {
      const job = this.snapshot?.job;
      if (job) {
        const text = job.state === 'succeeded' ? '已确认单片机重启，运行固件摘要与本次上传一致。' : job.state === 'installing' ? '下载已完成，正在等待单片机重启并确认新固件，请保持供电。' :
          job.state === 'unknown' ? '尚未收到新固件的重启确认，请检查船端状态后重新读取。下载达到 100% 不代表安装成功。' :
          job.state === 'failed' ? job.error || '升级失败，请检查船端状态后重新开始。' : job.state === 'cancelled' ? '固件传输已取消。再次运行电机前需重新满足停机解锁条件。' : STATES[job.state] + '，任务在服务器后台继续。';
        this.notice((job.force ? '强制 OTA · ' : '') + text, job.state === 'succeeded' ? 'success' : ['failed', 'unknown'].includes(job.state) ? 'error' : 'neutral');
      } else if (!this.config?.enabled) this.notice(this.config?.reason || '服务器尚未启用无线升级，请按接入教程配置。');
      else if (!this.snapshot?.supported) this.notice('尚未收到这艘船的有效 OTA 能力，请确认船端在线。首次需有线烧入 Bootloader 和 OTA 应用。');
      else if (!this.snapshot.online) this.notice('这艘无人船当前离线，保持船端通电联网后重新读取。');
      else if (!this.snapshot.capability?.ready && this.ready(true)) this.notice('普通升级的外设停机条件未满足；若外设未通电，可选择固件后点击“强制 OTA 升级”。单片机已确认 PWM 归零并允许维护。');
      else if (!this.snapshot.capability?.ready) this.notice('普通升级需 CH6 低档、两路电机停稳且反馈正常满 1 秒；外设未通电时请查看下方强制 OTA 状态。');
      else this.notice('设备已就绪。选择为此工程构建的 OTA 应用 .bin，然后点击“上传并升级”。');
    }
    render() {
      const n = this.nodes, admin = this.admin(), job = this.snapshot?.job, file = this.file();
      n.firmwareDevice.textContent = this.deviceId || '未选择无人船';
      n.firmwareCapability.textContent = this.snapshot?.supported ? '支持 OTA · 应用地址 0x08020000 · 最大 640 KiB' : '等待设备上报升级能力';
      n.firmwareFile.disabled = !admin || this.busy || !!(job && ACTIVE.has(job.state));
      n.firmwareFileInfo.textContent = file ? file.name + ' · ' + (file.size / 1024).toFixed(1) + ' KiB' + (this.fileValid() ? '' : ' · 请选择 256 字节至 640 KiB 的 .bin') : '上传 OTA 构建的应用 .bin，不能选择 Bootloader、.hex 或原直烧固件。';
      n.firmwareStart.disabled = !admin || this.busy || !this.ready() || !this.fileValid();
      n.firmwareForceStart.disabled = !admin || this.busy || !this.ready(true) || !this.fileValid();
      n.firmwareForceHint.textContent = !this.config?.enabled ? '强制 OTA 需要服务器启用升级服务。' : !this.snapshot?.supported || !this.snapshot.online ? '强制 OTA 仍需单片机通电联网，并上报有效升级能力。' :
        this.config.forceSupported !== true || this.snapshot.capability?.forceSupported !== true ? '当前服务器或单片机固件不支持强制 OTA；需先更新配套程序。' :
        this.snapshot.job && ACTIVE.has(this.snapshot.job.state) ? '当前升级任务正在运行，请等待完成或取消传输。' :
        this.snapshot.capability.forceReady !== true ? '强制 OTA 等待本地两路 PWM 归零满 1 秒；电机仍转动、网页接管或 Flash 忙碌时不可用。' :
        '强制 OTA 已就绪：允许电调、接收机、RTK / IMU 没有数据；请确保推进器断电或船已停稳。';
      n.firmwareRefresh.disabled = !admin || this.busy || !this.opened;
      n.firmwareCancel.hidden = !job?.cancelable; n.firmwareCancel.disabled = !admin || this.busy || !job?.cancelable;
      const percent = job ? Math.max(0, Math.min(100, Number(job.progress) || 0)) : 0;
      n.firmwareProgress.hidden = !job; n.firmwareProgress.value = percent;
      n.firmwarePhase.textContent = job ? STATES[job.state] : '尚无升级任务'; n.firmwarePercent.textContent = job ? percent.toFixed(0) + '%' : '--';
      n.firmwareBytes.textContent = job ? Math.max(0, Number(job.receivedBytes) || 0) + ' / ' + job.size + ' 字节已确认接收' : '下载后会完整校验，再重启安装';
      n.firmwareHash.textContent = job?.sha256 || '尚未上传'; n.firmwareJobName.textContent = job?.name || '尚无固件';
    }
    destroy() {
      if (this.destroyed) return; this.close(); this.destroyed = true;
      this.auth?.removeEventListener('change', this.onAuth);
      for (const [node, event, handler] of this.listeners) node.removeEventListener(event, handler);
      this.listeners = [];
    }
  }
  scope.BoatFirmwarePanel = BoatFirmwarePanel;
})(window);
