/* OTA 任务在服务器运行，页面关闭不取消；仅设备确认推进进度，重启后摘要匹配才成功。 */
'use strict';
const crypto = require('node:crypto');
const protocol = require('./firmware-protocol');
const ACTIVE = new Set(['queued', 'transferring', 'verifying', 'installing']);
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const fault = (status, message) => Object.assign(Error(message), { status });
class FirmwareService {
  constructor({ bridge, key, now = Date.now, capabilityMs = 5000, beginTimeoutMs = 60000, blockTimeoutMs = 15000,
    installTimeoutMs = 90000, maxAttempts = 3, maxActive = 4, maxJobs = 64 } = {}) {
    this.bridge = bridge; this.key = key; this.now = now; this.capabilityMs = capabilityMs; this.beginTimeoutMs = beginTimeoutMs;
    this.blockTimeoutMs = blockTimeoutMs; this.installTimeoutMs = installTimeoutMs; this.maxAttempts = Math.min(3, Math.max(1, maxAttempts));
    this.maxActive = maxActive; this.maxJobs = maxJobs; this.caps = new Map(); this.jobs = new Map(); this.closed = false;
    this.onCapability = event => this.acceptCapability(event);
    this.onResponse = event => this.acceptResponse(event);
    this.onState = event => {
      if (event?.brokerConnected === false) for (const cap of this.caps.values()) cap.receivedAt = -Infinity;
      else if (event?.device?.status === 'offline') { const cap = this.caps.get(event.device.id); if (cap) cap.receivedAt = -Infinity; }
      for (const job of this.jobs.values()) if (ACTIVE.has(job.state) && job.state !== 'installing' &&
          (event?.brokerConnected === false || event?.device?.id === job.deviceId && event.device.status === 'offline')) {
        if (job.commitSent) this.awaitInstallation(job, '安装指令已发出，等待设备恢复连接并核对重启后的固件摘要');
        else this.finish(job, 'failed', '网络连接已断开，本次升级未提交，请重新开始');
      }
    };
    // 未启用OTA的旧部署不增加长驻监听器，原SSE/遥测的连接上限与清理行为保持一致。
    if (key) { bridge?.on?.('firmware-capability', this.onCapability); bridge?.on?.('firmware-response', this.onResponse); bridge?.on?.('state', this.onState); }
  }
  isActive(id) { return ACTIVE.has(this.jobs.get(id)?.state); }
  fresh(cap) { const age = cap ? this.now() - cap.receivedAt : -1; return !!(cap && age >= 0 && age <= this.capabilityMs && this.bridge?.brokerConnected); }
  snapshot(id) {
    const cap = this.caps.get(id), job = this.jobs.get(id);
    let capability = null;
    if (cap) { const { session, bootId, receivedAt, ...visible } = cap; capability = visible; }
    return { deviceId: id, supported: this.fresh(cap), online: this.fresh(cap), capability,
      job: job ? { id: job.id, deviceId: id, name: job.name, size: job.size, sha256: job.sha256, state: job.state,
        receivedBytes: job.receivedBytes, progress: Math.floor(job.receivedBytes * 100 / job.size), error: job.error,
        startedAt: job.startedAt, updatedAt: job.updatedAt, cancelable: ACTIVE.has(job.state) && !job.commitSent } : null };
  }
  acceptCapability({ deviceId, payload, retained } = {}) {
    if (this.closed || retained || typeof deviceId !== 'string' || !DEVICE.test(deviceId)) return false;
    const cap = protocol.capability(payload); if (!cap) return false;
    if (!this.caps.has(deviceId) && this.caps.size >= this.maxJobs) {
      const unused = [...this.caps.keys()].find(id => !this.isActive(id)); if (!unused) return false; this.caps.delete(unused);
    }
    this.caps.set(deviceId, { ...cap, receivedAt: this.now() });
    const job = this.jobs.get(deviceId);
    if (job && ACTIVE.has(job.state)) {
      if (job.commitSent && cap.bootId !== job.bootId && cap.imageSha256 === job.sha256) this.finish(job, 'succeeded', null);
      else if (job.state !== 'installing' && (cap.session !== job.session || cap.bootId !== job.bootId || job.commitSent && cap.state === 'installing')) {
        if (job.commitSent) this.awaitInstallation(job, '安装指令已发出，正在等待重启后的固件摘要确认');
        else this.finish(job, 'failed', '单片机会话已变化，请重新读取状态；未确认的升级不会显示成功');
      }
    }
    return true;
  }
  acceptResponse({ deviceId, payload, retained } = {}) {
    const job = this.jobs.get(deviceId), ack = protocol.response(payload), pending = job?.pending;
    if (this.closed || retained || !job || !pending || !ack || ack.session !== job.session || ack.transferId !== job.id || ack.op !== pending.op) return false;
    if (ack.status) { pending.finish(Object.assign(fault(409, protocol.errors[ack.status] || '单片机拒绝固件升级'), { deviceRejected: true })); return true; }
    // 同一 DATA 操作的迟到 ACK 只能对应当时的下一偏移，不能跳块或重写 Flash。
    if (ack.nextOffset !== pending.nextOffset || ack.size !== job.size) return false;
    pending.finish(null, ack); return true;
  }
  start(id, name, image) {
    if (this.closed || !this.key) throw fault(503, '服务器尚未配置OTA密钥');
    if (typeof id !== 'string' || !DEVICE.test(id)) throw fault(400, '设备编号不正确');
    const cap = this.caps.get(id);
    if (!this.fresh(cap) || !cap.ready || !['idle', 'failed'].includes(cap.state)) throw fault(503, '该船未在线提供可用OTA能力；需先有线安装Bootloader及OTA固件，并确认电机停稳');
    if (this.isActive(id)) throw fault(409, '该船已有固件升级任务');
    if ([...this.jobs.values()].filter(job => ACTIVE.has(job.state)).length >= this.maxActive) throw fault(429, '同时升级的船只已达上限，请稍后再试');
    const info = protocol.validateImage(image), signed = protocol.manifest(image, this.key);
    if (image.length > cap.maxSize) throw fault(400, '固件超过该设备允许大小');
    this.bridge.claimFirmware(id);
    while (this.jobs.size >= this.maxJobs && !this.jobs.has(id)) {
      const old = [...this.jobs.values()].filter(job => !ACTIVE.has(job.state)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!old) { this.bridge.releaseFirmware(id); throw fault(429, '升级任务目录已满'); } this.jobs.delete(old.deviceId);
    }
    const job = { id: crypto.randomBytes(16).toString('hex'), deviceId: id, name, ...info, image: Buffer.from(image), manifest: signed,
      state: 'queued', receivedBytes: 0, error: null, startedAt: this.now(), updatedAt: this.now(), session: cap.session, bootId: cap.bootId,
      commitSent: false, pending: null, installTimer: null };
    this.jobs.set(id, job); setImmediate(() => this.run(job)); return this.snapshot(id);
  }
  update(job, state) { job.state = state; job.updatedAt = this.now(); }
  send(job, op, offset, payload, nextOffset) {
    if (!ACTIVE.has(job.state) || this.closed) return Promise.reject(fault(409, '升级任务已结束'));
    const packet = protocol.command(op, job.session, job.id, offset, payload), timeout = op === protocol.OP.BEGIN ? this.beginTimeoutMs : this.blockTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer, attempts = 0, settled = false;
      const pending = { op, nextOffset, finish: (error, ack) => {
        if (settled) return; settled = true; clearTimeout(timer); if (job.pending === pending) job.pending = null; error ? reject(error) : resolve(ack);
      } };
      job.pending = pending;
      const attempt = () => {
        if (settled || !ACTIVE.has(job.state)) return;
        if (attempts++ >= this.maxAttempts) { pending.finish(fault(504, '单片机升级响应超时；请重新读取状态确认结果')); return; }
        timer = setTimeout(attempt, timeout); timer.unref?.();
        try { this.bridge.publishFirmware(job.deviceId, packet).catch(() => pending.finish(fault(503, '固件分块发送失败，请检查云端连接'))); }
        catch (_) { pending.finish(fault(503, '固件分块发送失败，请检查云端连接')); }
      };
      attempt();
    });
  }
  async run(job) {
    if (this.closed || this.jobs.get(job.deviceId) !== job || !ACTIVE.has(job.state)) return;
    try {
      this.update(job, 'transferring'); await this.send(job, protocol.OP.BEGIN, 0, job.manifest, 0);
      while (ACTIVE.has(job.state) && job.receivedBytes < job.size) {
        const offset = job.receivedBytes, block = job.image.subarray(offset, Math.min(job.size, offset + protocol.CHUNK_SIZE));
        await this.send(job, protocol.OP.DATA, offset, block, offset + block.length); if (!ACTIVE.has(job.state)) return;
        job.receivedBytes += block.length; job.updatedAt = this.now();
      }
      if (!ACTIVE.has(job.state)) return;
      this.update(job, 'verifying'); job.commitSent = true;
      await this.send(job, protocol.OP.COMMIT, 0, Buffer.alloc(0), job.size); if (!ACTIVE.has(job.state)) return;
      this.awaitInstallation(job);
    } catch (error) {
      if (!ACTIVE.has(job.state) || error.awaitInstall) return;
      if (job.commitSent && !error.deviceRejected) { this.awaitInstallation(job, '安装提交应答未确认，继续等待设备重启并核对固件摘要'); return; }
      if (!job.commitSent || error.deviceRejected) this.abortDevice(job);
      this.finish(job, 'failed', error.status ? error.message : '固件升级失败，请检查设备和网络');
    }
  }
  awaitInstallation(job, message = null) {
    if (!ACTIVE.has(job.state) || this.closed || job.state === 'installing') return;
    this.update(job, 'installing'); job.error = message;
    // COMMIT可能已执行但ACK在复位前丢失；停止旧会话重发，保留锁等待真正的重启证据。
    job.pending?.finish(Object.assign(fault(409, '等待重启确认'), { awaitInstall: true }));
    if (job.image) job.image.fill(0); job.image = null;
    job.installTimer = setTimeout(() => this.finish(job, 'unknown', '已发送安装指令，但尚未收到重启后匹配的固件摘要；请检查单片机启动和网络'), this.installTimeoutMs); job.installTimer.unref?.();
  }
  abortDevice(job) {
    try { this.bridge.publishFirmware(job.deviceId, protocol.command(protocol.OP.ABORT, job.session, job.id)).catch(() => {}); } catch (_) { /* 无法确认取消时设备自行超时退出下载，旧应用保持。 */ }
  }
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || !ACTIVE.has(job.state)) throw fault(409, '该船没有可取消的升级任务');
    if (job.commitSent) throw fault(409, '固件已提交安装，不能取消；请等待重启核验');
    this.abortDevice(job); this.finish(job, 'cancelled', '服务器已取消传输；设备若未收到取消命令，会在等待超时后退出下载'); return this.snapshot(id);
  }
  finish(job, state, error) {
    if (!ACTIVE.has(job.state)) return;
    this.update(job, state); job.error = error; clearTimeout(job.installTimer); job.installTimer = null;
    job.pending?.finish(fault(409, '升级任务已结束')); if (job.image) job.image.fill(0); job.image = null; job.manifest?.fill(0); job.manifest = null;
    this.bridge.releaseFirmware(job.deviceId);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.values()) if (ACTIVE.has(job.state)) {
      if (!job.commitSent) this.abortDevice(job);
      this.finish(job, job.commitSent ? 'unknown' : 'failed', '网页服务已停止；未确认的升级结果需设备重新上线后核对');
    }
    this.bridge?.removeListener?.('firmware-capability', this.onCapability); this.bridge?.removeListener?.('firmware-response', this.onResponse); this.bridge?.removeListener?.('state', this.onState);
    this.caps.clear();
  }
}
module.exports = { FirmwareService, ACTIVE, DEVICE };
