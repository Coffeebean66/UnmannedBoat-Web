/* 服务器音频库及一次性广播；与麦克风语音共用每台物理摄像头的互斥锁。 */
'use strict';
const crypto = require('node:crypto');
const { createCameraAudioTools, validateVolume } = require('./camera-audio-tools');
const { createCameraAudioStore } = require('./camera-audio-store');
const LIBRARY = '/api/video/camera/audio-files', ID = /^[a-f0-9]{32}$/;
const fault = (status, message) => Object.assign(Error(message), { status });
function createCameraAudioApi({ env, accounts, wvp, binding, current, active, talkJobs, stopTalk, collect, reply, now = Date.now,
  tools = createCameraAudioTools({ env }), store = createCameraAudioStore({ env, tools, now }), directory, uploadTimeoutMs } = {}) {
  // 测试与非标准安装可注入独立存储；正式安装默认使用源码目录外的私有状态目录。
  if (directory !== undefined || uploadTimeoutMs !== undefined) store = createCameraAudioStore({ env, tools, directory, uploadTimeoutMs, now });
  const last = new Map(); let closed = false;
  const keyFor = value => value.deviceId + '/' + value.channelId;
  const canManage = owner => active(owner) && owner.value.role === 'admin';
  function item(job, owner) {
    return { id: job.id, status: job.ended ? 'stopping' : job.phase, fileId: job.audio.id, name: job.audio.name, duration: job.audio.duration, volume: job.volume,
      startedAt: job.startedAt || null, elapsed: job.startedAt ? Math.min(job.audio.duration, Math.max(0, (now() - job.startedAt) / 1000)) : 0,
      canStop: active(owner) && (owner.key === job.owner.key || owner.value.role === 'admin'), error: job.error || null };
  }
  function snapshot(id, owner) {
    const selected = binding(id), key = keyFor(selected), job = talkJobs.get(key), previous = last.get(key);
    const finished = previous && previous.revision === selected.revision && now() - previous.finishedAt < 10 * 60 * 1000 ? previous.value : null;
    return { voiceBusy: !!job, playback: job?.kind === 'file' ? item(job, owner) : finished || { status: 'idle', canStop: false } };
  }
  async function start(id, input, owner, res) {
    if (!input || Object.keys(input).some(key => !['fileId', 'volume'].includes(key)) || !ID.test(input.fileId || '')) throw fault(400, '请选择服务器上的 MP3 文件');
    const volume = validateVolume(input.volume === undefined ? 100 : input.volume);
    const selected = binding(id), key = keyFor(selected);
    if (!await tools.available()) throw fault(503, '服务器需安装 FFmpeg 和 FFprobe 后才能播放 MP3');
    if (!active(owner) || res.destroyed) throw fault(401, '登录会话已失效');
    if (talkJobs.has(key)) throw fault(409, '摄像头正在对讲或播放音频，请先结束当前语音');
    if (talkJobs.size >= 32) throw fault(429, '语音连接已满');
    const audio = store.acquire(input.fileId);
    const job = { id: crypto.randomBytes(16).toString('hex'), kind: 'file', phase: 'preparing', audio, volume, owner, binding: selected, key,
      expiresAt: now() + 60000, resources: new Map(), inFlight: new Set(), ended: false, abort: new AbortController() };
    job.onStop = () => {
      audio.release();
      const status = ['completed', 'failed'].includes(job.phase) ? job.phase : 'stopped';
      if (last.size >= 64 && !last.has(key)) last.delete(last.keys().next().value);
      last.set(key, { revision: selected.revision, finishedAt: now(), value: { ...item(job, owner), status, canStop: false } });
    };
    talkJobs.set(key, job);
    const abandoned = () => { if (!res.writableEnded) stopTalk(job); }; res.once('close', abandoned);
    const operation = (async () => {
      if (!current(job)) throw fault(409, '摄像头来源已变化，请重新选择');
      const target = await wvp.talkStart(selected.deviceId, selected.channelId, 'broadcast'); job.published = true;
      if (job.ended || !current(job)) throw fault(409, '音频播放已取消');
      const url = await wvp.broadcastPublishUrl(target.push);
      if (job.ended || !current(job)) throw fault(409, '音频播放已取消');
      job.worker = tools.play(audio.file, url, { signal: job.abort.signal, volume: job.volume });
      job.worker.done.then(result => {
        if (!job.ended) {
          job.phase = result.code === 0 ? 'completed' : 'failed';
          if (result.code !== 0) job.error = '音频发送中断，请检查摄像头在线状态';
          void stopTalk(job);
        }
      });
      await job.worker.ready;
      // 极短的文件可能在 ready 返回前已正常结束，仍应向发起者报告完成。
      if (job.ended && job.phase === 'completed') return;
      if (job.ended || !current(job)) throw fault(409, '音频播放已结束或已取消');
      job.phase = 'playing'; job.startedAt = now(); job.expiresAt = now() + audio.duration * 1000 + 30000;
    })();
    job.inFlight.add(operation);
    let failure;
    try { await operation; } catch (error) { failure = error; }
    finally { job.inFlight.delete(operation); res.removeListener('close', abandoned); }
    if (failure) {
      if (!job.ended) { job.phase = 'failed'; job.error = failure.status ? failure.message : '音频播放失败，请检查摄像头与服务器音频组件'; }
      await stopTalk(job); throw failure;
    }
    return snapshot(id, owner);
  }
  return { snapshot, async close() { closed = true; await store.close(); last.clear(); }, async handle(req, res, url, owner) {
    const fileRoute = url.pathname === LIBRARY || url.pathname.startsWith(LIBRARY + '/');
    const boat = url.pathname.match(/^\/api\/video\/camera\/boats\/([A-Za-z0-9_-]{1,64})\/audio$/);
    if (!fileRoute && !boat) return false;
    if (closed) throw fault(503, '服务器音频服务已关闭');
    if (url.search) throw fault(404, '音频接口不存在');
    if (fileRoute) {
      const file = url.pathname === LIBRARY ? null : url.pathname.slice(LIBRARY.length + 1);
      if (file !== null && !ID.test(file)) throw fault(404, '音频文件不存在');
      if (req.method === 'GET' && file === null) {
        const files = store.list(), available = await tools.available();
        if (!active(owner)) throw fault(401, '登录会话已失效');
        reply(res, 200, { files, limits: store.limits, canManage: canManage(owner), available, reason: available ? null : '服务器需安装 FFmpeg 和 FFprobe 后才能上传与播放 MP3' });
      } else if (req.method === 'POST' && file === null) {
        if (!canManage(owner)) throw fault(403, '只有管理员可以上传音频文件');
        let name; try { name = decodeURIComponent(req.headers['x-audio-name'] || ''); } catch (_) { throw fault(400, 'MP3 文件名无效'); }
        const result = await store.upload(req, name, () => canManage(owner) && !res.destroyed);
        reply(res, 201, { file: result });
      } else if (req.method === 'DELETE' && file !== null) {
        if (!canManage(owner)) throw fault(403, '只有管理员可以删除音频文件');
        await store.remove(file, () => canManage(owner) && !res.destroyed); reply(res, 200, { deleted: true });
      } else throw fault(405, '音频文件操作不支持此方法');
      return true;
    }
    const id = boat[1];
    if (req.method === 'GET') reply(res, 200, snapshot(id, owner));
    else if (req.method === 'POST') {
      const input = await collect(req, 'application/json');
      if (!active(owner)) throw fault(401, '登录会话已失效');
      reply(res, 201, await start(id, input, owner, res));
    } else if (req.method === 'PATCH') {
      const input = await collect(req, 'application/json');
      if (!active(owner)) throw fault(401, '登录会话已失效');
      if (!input || Object.keys(input).some(key => !['playbackId', 'volume'].includes(key)) || !ID.test(input.playbackId || '')) throw fault(400, '音频播放编号无效，请刷新后重试');
      const volume = validateVolume(input.volume), selected = binding(id), job = talkJobs.get(keyFor(selected));
      // 携带本次播放编号，避免迟到的音量请求修改下一次播放或另一台摄像头。
      if (!job || job.kind !== 'file' || job.id !== input.playbackId || job.ended || !current(job)) throw fault(409, '本次音频播放已结束或来源已变化');
      if (job.owner.key !== owner.key && owner.value.role !== 'admin') throw fault(403, '仅发起者或管理员可以调节这次播放的音量');
      job.worker?.setVolume(volume); job.volume = volume;
      reply(res, 200, snapshot(id, owner));
    } else if (req.method === 'DELETE') {
      const selected = binding(id), job = talkJobs.get(keyFor(selected));
      if (job && job.kind !== 'file') throw fault(409, '摄像头正在对讲，请在对讲窗口结束通话');
      if (job && job.owner.key !== owner.key && owner.value.role !== 'admin') throw fault(403, '仅发起者或管理员可以停止这次文件播放');
      await stopTalk(job); reply(res, 200, snapshot(id, owner));
    } else throw fault(405, '音频播放操作不支持此方法');
    return true;
  } };
}
module.exports = { createCameraAudioApi };
