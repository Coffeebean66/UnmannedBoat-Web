/* 国标云台与语音：绑定当前船的摄像头，短租约防止按键丢失或浏览器关闭后继续动作。 */
'use strict';
const crypto = require('node:crypto');
const { createWvpClient, readWvpConfig } = require('./wvp-client');
const { canOperate } = require('./account-permissions');
const { createCameraAudioApi } = require('./camera-audio-api');
const PREFIX = '/api/video/camera/boats/';
const TOKEN = /^[a-f0-9]{32}$/;
const COMMANDS = ['left', 'right', 'up', 'down', 'upleft', 'upright', 'downleft', 'downright', 'zoomin', 'zoomout', 'stop'];
const fault = (status, message) => Object.assign(Error(message), { status });
function collect(req, type, maximum = 2048) {
  if (String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim() !== type) return Promise.reject(fault(415, '请求内容类型不正确'));
  return new Promise((resolve, reject) => {
    let done = false, size = 0; const chunks = [];
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', aborted); req.removeListener('aborted', aborted); error ? reject(error) : resolve(value); };
    const data = chunk => { size += chunk.length; if (size > maximum) finish(fault(413, '摄像头请求过大')); else chunks.push(chunk); };
    const end = () => { const text = Buffer.concat(chunks).toString('utf8'); if (type !== 'application/json') { finish(null, text); return; } try { finish(null, JSON.parse(text)); } catch (_) { finish(fault(400, '摄像头请求格式无效')); } };
    const aborted = () => finish(fault(400, '摄像头请求已取消'));
    const timer = setTimeout(() => finish(fault(408, '摄像头请求超时')), 5000); timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
}
function validateAudioOffer(offer, direction) {
  if (typeof offer !== 'string' || !/^v=0\r?\n/.test(offer) || offer.includes('\0') || Buffer.byteLength(offer) > 65536 ||
    (offer.match(/^m=audio /gm) || []).length !== 1 || /^m=(?!audio )/m.test(offer) ||
    !/^a=rtpmap:\d+ PCMA\/8000(?:\/1)?\r?$/im.test(offer) ||
    !new RegExp('^a=' + (direction === 'push' ? 'sendonly' : 'recvonly') + '\\r?$', 'm').test(offer)) throw fault(400, '语音需要仅含 G.711A 音频的有效 WebRTC SDP');
  return offer;
}
function createCameraControlApi({ env = process.env, accounts, sources, wvp, audioOptions = {}, now = Date.now, sweepMs = 250, ptzLeaseMs = 1400, talkLeaseMs = 7000 } = {}) {
  const enabled = readWvpConfig(env).enabled;
  wvp ||= createWvpClient({ env });
  const ptzJobs = new Map(), talkJobs = new Map(), talks = new Map(), ended = new Map();
  let closed = false, voiceCheck = null, voiceCheckedAt = -Infinity, voiceReady = false;
  const active = owner => !closed && accounts?.enabled && accounts.isActive(owner) && canOperate(owner.value);
  const keyFor = binding => binding.deviceId + '/' + binding.channelId;
  const nonceFor = (owner, leaseId) => owner.key + ':' + leaseId;
  const reply = (res, status, data) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
  function binding(id) {
    if (!enabled || !sources?.enabled) throw fault(503, '服务器尚未启用 WVP 摄像头控制');
    const value = sources.cameraBinding(id);
    if (!value) throw fault(409, '这艘船当前使用 SRT / UDP；请先由管理员绑定 WVP 摄像头');
    return { ...value, boatId: id };
  }
  function current(job) {
    if (!active(job.owner)) return false;
    try { const value = binding(job.binding.boatId); return value.revision === job.binding.revision && keyFor(value) === keyFor(job.binding); } catch (_) { return false; }
  }
  function remember(owner, leaseId) {
    if (ended.size >= 2048) ended.delete(ended.keys().next().value);
    ended.set(nonceFor(owner, leaseId), now() + 60000);
  }
  async function available() {
    if (now() - voiceCheckedAt < 30000) return voiceReady;
    if (!voiceCheck) voiceCheck = Promise.resolve().then(() => wvp.voiceAvailable()).then(value => { voiceReady = value === true; voiceCheckedAt = now(); return voiceReady; }).catch(() => false).finally(() => { voiceCheck = null; });
    return voiceCheck;
  }
  function stopPtz(job) {
    if (!job) return Promise.resolve();
    job.ended = true; remember(job.owner, job.leaseId);
    if (job.stopping) return job.stopping;
    job.stopping = job.queue.catch(() => {}).then(() => wvp.ptz(job.binding.deviceId, job.binding.channelId, 'stop', 100, 4)).then(() => {
      if (ptzJobs.get(job.key) === job) ptzJobs.delete(job.key);
    }).catch(() => { job.retryAt = now() + 1000; }).finally(() => { job.stopping = null; });
    return job.stopping;
  }
  async function ptz(id, input, owner, res) {
    if (!input || Object.keys(input).some(key => !['command', 'speed', 'zoomSpeed', 'leaseId', 'sequence'].includes(key)) || !COMMANDS.includes(input.command) || !TOKEN.test(input.leaseId || '') || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Number.isInteger(input.speed) || input.speed < 1 || input.speed > 255 || !Number.isInteger(input.zoomSpeed) || input.zoomSpeed < 1 || input.zoomSpeed > 15) throw fault(400, '云台指令、速度或控制序号无效');
    const selected = binding(id), key = keyFor(selected); let job = ptzJobs.get(key);
    const own = job && job.owner.key === owner.key && job.leaseId === input.leaseId;
    if (input.command === 'stop') {
      remember(owner, input.leaseId);
      if (job && !own) throw fault(409, '云台正由另一个控制窗口使用');
      if (job) await stopPtz(job);
      return { stopped: !ptzJobs.has(key), retrying: ptzJobs.has(key) };
    }
    if (ended.has(nonceFor(owner, input.leaseId))) throw fault(409, '本次云台操作已结束，请重新按住方向键');
    if (job && (!own || job.ended)) throw fault(409, '云台正由另一个控制窗口使用或正在停止');
    if (!job) {
      if (ptzJobs.size >= 64) throw fault(429, '云台连接已满');
      job = { key, owner, binding: selected, leaseId: input.leaseId, sequence: 0, queue: Promise.resolve(), ended: false };
      ptzJobs.set(key, job);
    }
    if (input.sequence <= job.sequence || !current(job)) throw fault(409, '云台操作已过期');
    job.sequence = input.sequence; job.expiresAt = now() + ptzLeaseMs;
    const abandoned = () => { if (!res.writableEnded) stopPtz(job); }; res.once('close', abandoned);
    const task = job.queue.catch(() => {}).then(async () => {
      if (job.ended || !current(job) || now() >= job.expiresAt) throw fault(409, '云台操作已停止');
      await wvp.ptz(selected.deviceId, selected.channelId, input.command, input.speed, input.zoomSpeed,
        { beforeSend: () => !job.ended && current(job) && now() < job.expiresAt });
    }); job.queue = task;
    try { await task; if (!current(job) || job.ended) throw fault(409, '云台操作已停止'); return { moving: true, leaseMs: ptzLeaseMs }; }
    catch (error) { stopPtz(job); throw error; }
    finally { res.removeListener('close', abandoned); }
  }
  function stopTalk(job) {
    if (!job) return Promise.resolve();
    job.ended = true; talks.delete(job.id);
    if (job.stopping) return job.stopping;
    job.abort?.abort();
    job.stopping = (async () => {
      await job.worker?.stop();
      await Promise.allSettled([...job.inFlight]);
      await job.worker?.stop();
      for (const [direction, resource] of job.resources) { await wvp.closeAudio(resource); job.resources.delete(direction); }
      // 只释放由本平台成功发布的语音，不中断 WVP 中其他用户的会话。
      if (job.published) { await wvp.talkStop(job.binding.deviceId, job.binding.channelId); job.published = false; }
      if (talkJobs.get(job.key) === job) talkJobs.delete(job.key);
      job.onStop?.();
    })().catch(() => { job.retryAt = now() + 1000; }).finally(() => { job.stopping = null; });
    return job.stopping;
  }
  async function startTalk(id, input, owner, res) {
    if (!input || Object.keys(input).join(',') !== 'mode' || !['compatible', 'talk', 'broadcast'].includes(input.mode)) throw fault(400, '请选择兼容对讲、国标双向对讲或单向喊话');
    const selected = binding(id), key = keyFor(selected);
    if (!await available()) throw fault(503, '语音需要服务器 ZLMediaKit 启用 WebRTC / WHIP / WHEP，请联系管理员更新视频组件');
    if (!active(owner) || res.destroyed) throw fault(401, '登录会话已失效');
    if (talkJobs.has(key)) throw fault(409, talkJobs.get(key).kind === 'file' ? '摄像头正在播放服务器音频，请先停止播放' : '摄像头语音正由另一个窗口使用');
    if (talkJobs.size >= 32) throw fault(429, '语音连接已满');
    // 首次点播和登录可能超过心跳周期；准备期间尚未发布麦克风，返回会话后再按正常短租约续期。
    const job = { id: crypto.randomBytes(16).toString('hex'), owner, binding: selected, key, mode: input.mode, expiresAt: now() + Math.max(talkLeaseMs, 45000), resources: new Map(), inFlight: new Set(), negotiating: new Set(), ended: false };
    talkJobs.set(key, job); talks.set(job.id, job);
    const abandoned = () => { if (!res.writableEnded) stopTalk(job); }; res.once('close', abandoned);
    try {
      job.target = await wvp.talkStart(selected.deviceId, selected.channelId, input.mode);
      if (job.ended || !current(job) || res.destroyed) throw fault(401, '语音连接已取消');
      job.expiresAt = now() + talkLeaseMs;
      return { id: job.id, mode: job.mode, leaseMs: talkLeaseMs, canListen: !!job.target.play, codec: 'PCMA / G.711A' };
    } catch (error) { await stopTalk(job); throw error; }
    finally { res.removeListener('close', abandoned); }
  }
  const ownedTalk = (id, session, owner) => {
    const job = talks.get(session);
    if (!job || job.binding.boatId !== id || job.owner.key !== owner.key || job.ended) throw fault(404, '语音会话不存在或已结束');
    if (!current(job) || now() >= job.expiresAt) { stopTalk(job); throw fault(409, '语音会话已过期，请重新连接'); }
    return job;
  };
  async function negotiate(job, direction, offer, res) {
    validateAudioOffer(offer, direction);
    if (job.resources.has(direction) || job.negotiating.has(direction) || !job.target[direction]) throw fault(409, '语音方向不可用或已连接');
    job.negotiating.add(direction);
    const operation = Promise.resolve().then(() => wvp.openAudio(job.target[direction], direction, offer)).then(value => { job.resources.set(direction, value.resource); if (direction === 'push') job.published = true; return value; });
    job.inFlight.add(operation);
    const abandoned = () => { if (!res.writableEnded) stopTalk(job); }; res.once('close', abandoned);
    try {
      const result = await operation;
      if (job.ended || !current(job) || res.destroyed) throw fault(409, '语音连接已结束');
      return result.sdp;
    } finally { job.inFlight.delete(operation); job.negotiating.delete(direction); res.removeListener('close', abandoned); }
  }
  function sweep() {
    for (const [key, until] of ended) if (until <= now()) ended.delete(key);
    for (const job of ptzJobs.values()) if (job.ended ? now() >= (job.retryAt || 0) : !current(job) || now() >= job.expiresAt) stopPtz(job);
    for (const job of talkJobs.values()) if (job.ended ? now() >= (job.retryAt || 0) : !current(job) || now() >= job.expiresAt) stopTalk(job);
  }
  const timer = enabled ? setInterval(sweep, sweepMs) : null; timer?.unref?.();
  const audio = createCameraAudioApi({ env, accounts, wvp, binding, current, active, talkJobs, stopTalk, collect, reply, now, ...audioOptions });
  const detach = accounts?.onInvalidate?.(key => { for (const job of ptzJobs.values()) if (job.owner.key === key) stopPtz(job); for (const job of talkJobs.values()) if (job.owner.key === key) stopTalk(job); });
  return { async close() {
    if (closed) return; closed = true; clearInterval(timer); detach?.();
    await Promise.allSettled([...ptzJobs.values()].map(stopPtz).concat([...talkJobs.values()].map(stopTalk)));
    await audio.close();
    wvp.close?.(); ended.clear();
  }, sweep, async handle(req, res, url) {
    if (!url.pathname.startsWith('/api/video/camera/')) return false;
    const owner = accounts?.sessionFor(req);
    if (!owner || !accounts?.isActive(owner)) { reply(res, 401, { error: '请先登录平台' }); return true; }
    if (!canOperate(owner.value)) { reply(res, 403, { error: '只有管理员和驾驶员可以控制云台与使用语音' }); return true; }
    const browserRead = req.method === 'GET' && !req.headers.origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
    if (!browserRead && !accounts.sameOrigin(req)) { reply(res, 403, { error: '请从本站操作摄像头' }); return true; }
    const match = url.pathname.match(/^\/api\/video\/camera\/boats\/([A-Za-z0-9_-]{1,64})(?:\/(ptz|talk)(?:\/([a-f0-9]{32})(?:\/(heartbeat|push|play))?)?)?$/);
    try {
      if (closed || !enabled) throw fault(503, '服务器尚未启用 WVP 摄像头控制');
      if (await audio.handle(req, res, url, owner)) return true;
      if (!match || url.search) throw fault(404, '摄像头接口不存在');
      const [, id, action, session, direction] = match;
      if (!action && req.method === 'GET') {
        let selected; try { selected = binding(id); } catch (error) { if (error.status === 409) { reply(res, 200, { enabled: false, reason: error.message }); return true; } throw error; }
        const voice = await available(); if (!active(owner)) throw fault(401, '登录会话已失效');
        reply(res, 200, { enabled: true, revision: selected.revision, ptz: true, voice, voiceReason: voice ? null : '服务器 ZLMediaKit 尚未启用 WebRTC 语音', ptzBusy: ptzJobs.has(keyFor(selected)), voiceBusy: talkJobs.has(keyFor(selected)) });
      } else if (action === 'ptz' && !session && req.method === 'POST') {
        const input = await collect(req, 'application/json'); if (!active(owner)) throw fault(401, '登录会话已失效');
        reply(res, 200, await ptz(id, input, owner, res));
      } else if (action === 'talk' && !session && req.method === 'POST') {
        const input = await collect(req, 'application/json'); if (!active(owner)) throw fault(401, '登录会话已失效');
        reply(res, 201, await startTalk(id, input, owner, res));
      } else if (action === 'talk' && session) {
        // DELETE 可重复调用；退出时不要求摄像头仍绑定在原船上。
        if (!direction && req.method === 'DELETE') {
          const job = talks.get(session);
          if (job && (job.owner.key !== owner.key || job.binding.boatId !== id)) throw fault(404, '语音会话不存在');
          await stopTalk(job); reply(res, 200, { stopped: true });
        } else {
          const job = ownedTalk(id, session, owner);
          if (direction === 'heartbeat' && req.method === 'POST') { job.expiresAt = now() + talkLeaseMs; reply(res, 200, { active: true }); }
          else if (['push', 'play'].includes(direction) && req.method === 'POST') {
            const offer = await collect(req, 'application/sdp', 65536); ownedTalk(id, session, owner);
            try {
              const sdp = await negotiate(job, direction, offer, res);
              if (!res.destroyed) { res.writeHead(201, { 'Content-Type': 'application/sdp', 'Cache-Control': 'no-store' }); res.end(sdp); }
            } catch (error) { if (direction === 'push') await stopTalk(job); throw error; }
          } else throw fault(404, '语音接口不存在');
        }
      } else throw fault(404, '摄像头接口不存在');
    } catch (error) {
      req.resume(); reply(res, [400, 401, 403, 404, 405, 408, 409, 413, 415, 429, 502, 503, 504].includes(error.status) ? error.status : 503,
        { error: error.status ? error.message : '摄像头操作失败，请检查 WVP 和视频服务' });
    }
    return true;
  } };
}
module.exports = { createCameraControlApi, validateAudioOffer, collect };
