/* 服务器原生录像：网页只发送控制指令，MediaMTX 独立落盘，不占用浏览器内存。 */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createMqttDeviceClient } = require('./mqtt-device-api');
const { READER } = require('./video-media-api');
const PREFIX = '/api/video/recording', DEVICE = /^[A-Za-z0-9_-]{1,64}$/, CLIP = /^[a-f0-9]{64}$/;
const ALIAS_PREFIX = '__boatrec_', MAX_BOATS = 64, MAX_SEGMENTS = 200;
const TEMPLATE = '/%Y-%m-%d_%H-%M-%S-%f_%z', SEGMENT_SECONDS = 60, RETENTION_DAYS = 7;
const fault = (status, message) => Object.assign(Error(message), { status });
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// 目录只接受允许根目录中的普通子目录；不接受格式变量、转义或相对路径。
function normalizeDirectory(value, allowedRoot = '/var/lib/unmanned-boat-video') {
  if (typeof value !== 'string' || value.length > 512 || !/^\/[A-Za-z0-9_./-]+$/.test(value) ||
      value.split('/').some(part => part === '.' || part === '..') || value.includes('//') || value.endsWith('/')) return null;
  if (path.posix.normalize(value) !== value || value === '/' || !(value === allowedRoot || value.startsWith(allowedRoot + '/'))) return null;
  return value;
}

function resolveRecordingConfigFile(env = process.env, file) {
  const candidate = file !== undefined ? file : env.BOAT_VIDEO_RECORDING_CONFIG_FILE ||
    (env.STATE_DIRECTORY ? path.join(env.STATE_DIRECTORY.split(':')[0], 'video-recording.json') :
      env.BOAT_UPDATE_ENABLED === '1' ? path.join(env.BOAT_UPDATE_STATE_DIR || '/var/lib/unmanned-boat-web-update', 'requests', 'video-recording.json') : '');
  if (!candidate) return '';
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) throw Error('Invalid recording config path');
  return path.normalize(candidate);
}

function createRecordingTransport({ port = 9997, timeoutMs = 5000 } = {}) {
  return ({ method, path: requestPath, body, headers = {} }) => new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, agent: false,
      headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { finish(fault(502, '录像目录响应过大')); response.destroy(); } else chunks.push(chunk); });
      response.once('error', () => finish(fault(503, '录像服务连接中断')));
      response.once('end', () => finish(null, { status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => { finish(fault(504, '录像服务请求超时')); request.destroy(); }, timeoutMs); timer.unref?.();
    request.once('error', () => finish(fault(503, '录像服务不可用，请重新安装或检查视频管理组件'))); request.end(body);
  });
}

function readBody(req, timeoutMs) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return Promise.reject(fault(415, '请使用 JSON 录像指令'));
  if (Number(req.headers['content-length']) > 2048) return Promise.reject(fault(413, '录像指令过大'));
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0, finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer);
      req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); req.removeListener('aborted', onError);
      error ? reject(error) : resolve(value); };
    const onData = chunk => { bytes += chunk.length; if (bytes > 2048) finish(fault(413, '录像指令过大')); else chunks.push(chunk); };
    const onEnd = () => { try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); finish(null, value); } catch (_) { finish(fault(400, '录像指令格式不正确')); } };
    const onError = () => finish(fault(400, '录像请求已取消'));
    const timer = setTimeout(() => finish(fault(408, '录像指令超时')), timeoutMs); timer.unref?.();
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onError);
  });
}

function createVideoRecordingApi({ env = process.env, accounts, file, client = createMqttDeviceClient({ timeoutMs: 5000 }),
  transport = createRecordingTransport(), playbackPort = 9996, now = Date.now, bodyTimeoutMs = 5000,
  reconcileMs = 15000, maxStreams = 8, streamTimeoutMs = 10 * 60 * 1000, httpRequest = http.request } = {}) {
  const allowedRoot = env.BOAT_VIDEO_RECORDING_ROOT || '/var/lib/unmanned-boat-video';
  if (!normalizeDirectory(allowedRoot, allowedRoot)) throw Error('Invalid recording storage root');
  const enabled = env.BOAT_VIDEO_RECORDING_ENABLED === '1' && env.BOAT_VIDEO_MEDIA_ENABLED === '1' && /^[a-f0-9]{64}$/.test(env.BOAT_VIDEO_MEDIA_READER_PASSWORD || '');
  const authHeaders = { Authorization: 'Basic ' + Buffer.from(READER + ':' + (env.BOAT_VIDEO_MEDIA_READER_PASSWORD || '')).toString('base64') };
  let state = { version: 1, directory: allowedRoot + '/recordings', boats: {} }, closed = false, busy = false, configFile = '', loadError = null, serviceError = null;
  const streams = new Set(), inputActivity = new Map(); let background = null;
  try {
    configFile = resolveRecordingConfigFile(env, file);
    if (configFile) {
      try {
        const stat = fs.lstatSync(configFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw Error();
        const input = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (input?.version !== 1 || !normalizeDirectory(input.directory, allowedRoot) || !input.boats || typeof input.boats !== 'object' || Array.isArray(input.boats) || Object.keys(input.boats).length > MAX_BOATS) throw Error();
        for (const [id, item] of Object.entries(input.boats)) {
          if (!DEVICE.test(id) || id.startsWith(ALIAS_PREFIX) || !item || typeof item.armed !== 'boolean') throw Error();
        }
        state = { version: 1, directory: input.directory, boats: input.boats };
      } catch (error) { if (error.code !== 'ENOENT') loadError = '录像配置损坏或不可读取，请检查服务器配置文件后重启；当前已禁止修改录像'; }
    }
  } catch (_) { loadError = '录像配置文件路径无效，请设置绝对路径 BOAT_VIDEO_RECORDING_CONFIG_FILE'; }
  const active = owner => !closed && accounts?.enabled === true && accounts.isActive(owner);
  const ownBoat = (input, id) => Object.hasOwn(input.boats, id) ? input.boats[id] : null;
  const admin = owner => active(owner) && owner.value.role === 'admin';
  const assertActive = (owner, res, mutation = false) => { if (!(mutation ? admin(owner) : active(owner)) || res?.destroyed) throw fault(401, '登录会话已失效，请重新登录'); };
  const assertUsable = () => { if (!enabled) throw fault(503, '服务器尚未启用原生录像，请按录像教程更新视频管理组件'); if (loadError) throw fault(503, loadError); };
  const json = (res, status, value) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const configSnapshot = owner => ({ enabled, persistent: !!configFile, segmentSeconds: SEGMENT_SECONDS, retentionDays: RETENTION_DAYS,
    activeCount: Object.values(state.boats).filter(item => item.armed).length, error: loadError || serviceError || (!enabled ? '服务器尚未启用原生录像，请更新视频管理组件' : null),
    ...(owner.value.role === 'admin' ? { directory: state.directory, allowedRoot } : {}) });
  async function control(method, route, input, allowed = []) {
    const result = await transport({ method, path: route, headers: { ...authHeaders, Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: Buffer.from(JSON.stringify(input)) } : {}) });
    if (closed) throw fault(503, '录像服务已停止');
    if (allowed.includes(result.status)) return { missing: true, status: result.status };
    // MediaMTX v1.21 返回 200 JSON，兼容空响应的删除成功状态。
    if (method === 'DELETE' && result.status === 204) return {};
    if (result.status !== 200 && result.status !== 201) throw fault(503, '录像管理接口不可用，请更新视频管理组件或检查服务日志');
    let value; try { value = JSON.parse(Buffer.isBuffer(result.body) ? result.body.toString('utf8') : result.body || '{}'); } catch (_) { throw fault(502, '录像服务响应格式不正确'); }
    return value;
  }
  async function ensureBoat(id) {
    if (!DEVICE.test(id) || id.startsWith(ALIAS_PREFIX)) throw fault(404, '无人船不存在');
    const data = await client('GET', '/devices');
    if (!Array.isArray(data?.devices)) throw fault(503, '无法读取已注册无人船，请检查 MQTT 管理组件');
    if (!data.devices.some(item => item?.deviceId === id)) throw fault(404, '无人船未注册');
  }
  // MediaMTX 要求保留 %path，由媒体服务用实际的船只 ID 代入。
  const recordPath = (id, directory) => directory + '/%path' + TEMPLATE;
  const nativeSettings = (id, directory, armed) => ({ record: armed, recordPath: recordPath(id, directory), recordFormat: 'fmp4', recordPartDuration: '1s', recordSegmentDuration: '60s', recordDeleteAfter: '168h' });
  const sameDuration = (a, b) => a === b || a === '1m0s' && b === '60s' || a === '168h0m0s' && b === '168h' || a === '1s' && b === '1s';
  function receivingInput(id, native) {
    // 静态 UDP/RTP 源即使尚未收到数据也可能 online，需核对字节计数是否近期增长。
    if (native.missing || !(native.online === true || native.ready === true)) { inputActivity.delete(id); return false; }
    const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const hasCounter = Object.hasOwn(native, 'inboundBytes') || Object.hasOwn(native, 'bytesReceived');
    const bytes = valid(native.inboundBytes) ? native.inboundBytes : valid(native.bytesReceived) ? native.bytesReceived : null;
    // 老版本没有计数器时保留原在线判定；提供了无效计数器则按未接收处理。
    if (bytes === null) { inputActivity.delete(id); return !hasCounter; }
    const time = now(), epoch = typeof native.onlineTime === 'string' ? native.onlineTime : typeof native.readyTime === 'string' ? native.readyTime : null;
    let current = inputActivity.get(id);
    if (!current || current.epoch !== epoch || bytes < current.bytes) current = { bytes, epoch, progressedAt: bytes > 0 ? time : null };
    else {
      if (bytes > current.bytes || current.progressedAt !== null && time < current.progressedAt) current.progressedAt = time;
      current.bytes = bytes;
    }
    inputActivity.delete(id); inputActivity.set(id, current);
    while (inputActivity.size > MAX_BOATS) inputActivity.delete(inputActivity.keys().next().value);
    // 页面每8秒轮询一次，留12秒避免正常轮询间隔被误判为断流。
    return bytes > 0 && current.progressedAt !== null && time - current.progressedAt <= 12000;
  }
  async function applyPath(name, settings) {
    const current = await control('GET', '/v3/config/paths/get/' + name, null, [404]);
    if (current.missing) { await control('POST', '/v3/config/paths/add/' + name, settings); return; }
    if (Object.entries(settings).some(([key, value]) => !(typeof value === 'string' && /Duration|DeleteAfter/.test(key) ? sameDuration(current[key], value) : current[key] === value))) {
      await control('PATCH', '/v3/config/paths/patch/' + name, settings);
    }
  }
  async function applyBoat(id, input = state) {
    const item = ownBoat(input, id); if (!item) return;
    await applyPath(id, nativeSettings(id, input.directory, item.armed));
  }
  async function save(next, owner, res) {
    let temporary, handle;
    try {
      if (configFile) {
        const directory = path.dirname(configFile); await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        temporary = path.join(directory, '.' + path.basename(configFile) + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
        handle = await fs.promises.open(temporary, 'wx', 0o640); await handle.chmod(0o640); await handle.writeFile(JSON.stringify(next) + '\n', 'utf8'); await handle.sync(); await handle.close(); handle = null;
      }
      assertActive(owner, res, true);
      if (temporary) fs.renameSync(temporary, configFile);
      state = next;
    } catch (error) { if (error.status) throw error; throw fault(503, '录像配置保存失败，请检查服务器状态目录的写入权限'); }
    finally { if (handle) await handle.close().catch(() => {}); if (temporary) await fs.promises.unlink(temporary).catch(() => {}); }
  }
  async function withLock(operation) {
    if (busy) throw fault(409, '录像设置正在更新，请稍后重试'); busy = true;
    try { return await operation(); } finally { busy = false; }
  }
  async function reconcile() {
    if (closed || !enabled || loadError || busy) return;
    if (!Object.keys(state.boats).length) return;
    busy = true;
    try {
      const managed = await client('GET', '/devices');
      if (!Array.isArray(managed?.devices)) throw Error();
      const known = new Set(managed.devices.map(item => item.deviceId));
      for (const id of Object.keys(state.boats)) {
        if (closed) break;
        // 已删除的设备保留索引但停止写盘；重新登记后才恢复原录像设置。
        if (known.has(id)) await applyBoat(id);
        else await applyPath(id, nativeSettings(id, state.directory, false));
      }
      serviceError = null;
    } catch (_) { serviceError = '录像服务暂不可用，请检查媒体服务；已保存的录像意图会自动重试'; }
    finally { busy = false; }
  }
  async function segmentsFor(id, owner, res) {
    const item = ownBoat(state, id); if (!item) return [];
    const segments = [], directory = state.directory;
      assertActive(owner, res);
      const result = await control('GET', '/v3/recordings/get/' + id, null, [404]);
      assertActive(owner, res);
      if (result.missing) return [];
      if (!Array.isArray(result.segments)) throw fault(502, '录像列表响应无效');
      for (const segment of result.segments) {
        const time = Date.parse(segment.start), duration = segment.duration;
        // 分段开始时间由媒体服务给出；进行中的零时长文件不提供播放链接。
        if (typeof segment.start !== 'string' || segment.start.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(segment.start) || !Number.isFinite(time) || time > now() + 60000 || !Number.isFinite(duration) || duration <= 0 || duration > 3600) continue;
        const clipId = digest(id + '\0' + directory + '\0' + segment.start);
        const playbackUrl = PREFIX + '/boats/' + id + '/clips/' + clipId;
        segments.push({ id: clipId, start: segment.start, duration, playbackUrl, downloadUrl: playbackUrl + '?download=1', alias: id });
      }
    return segments.sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).slice(0, MAX_SEGMENTS);
  }
  async function boatSnapshot(id, owner, res) {
    const base = { deviceId: id, enabled, armed: !!ownBoat(state, id)?.armed, receiving: false, recording: false,
      segmentSeconds: SEGMENT_SECONDS, retentionDays: RETENTION_DAYS, segments: [], error: loadError || (!enabled ? '服务器尚未启用原生录像' : null) };
    if (!enabled || loadError) return base;
    try {
      const native = await control('GET', '/v3/paths/get/' + id, null, [404]); assertActive(owner, res);
      const configured = ownBoat(state, id) ? await control('GET', '/v3/config/paths/get/' + id, null, [404]) : null;
      assertActive(owner, res);
      base.receiving = receivingInput(id, native);
      // 此字段表示录像已开启且有视频输入；磁盘故障仍应检查 MediaMTX 日志。
      const confirmed = !!configured && !configured.missing && configured.record === base.armed && configured.recordPath === recordPath(id, state.directory);
      base.recording = base.armed && base.receiving && confirmed;
      if (ownBoat(state, id) && !confirmed) base.error = '录像指令已保存，等待媒体服务确认；系统会自动重试';
      base.segments = (await segmentsFor(id, owner, res)).map(({ alias, ...segment }) => segment);
    } catch (error) { if (error.status === 401) throw error; base.error = '无法读取录像状态，请检查视频管理组件和媒体服务日志'; }
    return base;
  }
  async function changeArmed(id, armed, owner, res) {
    assertUsable(); await ensureBoat(id); assertActive(owner, res, true);
    return withLock(async () => {
      const next = clone(state), existing = ownBoat(next, id);
      if (!existing && Object.keys(next.boats).length >= MAX_BOATS) throw fault(409, '录像最多管理64艘无人船');
      Object.defineProperty(next.boats, id, { value: existing || { armed: false }, writable: true, enumerable: true, configurable: true }); next.boats[id].armed = armed;
      // 先确认原生接口可用，再持久化意图；提交后发生网络故障会由后台恢复。
      if (armed) await control('GET', '/v3/config/global/get');
      assertActive(owner, res, true);
      const previous = state; await save(next, owner, res);
      try { await applyBoat(id); }
      catch (error) {
        // 失败状态仍明确返回已保存意图，防止网页误认为点击失败就没有后台录像。
        const pendingMessage = '录像指令已保存，媒体服务尚未确认；系统会自动重试';
        serviceError = pendingMessage;
        const snapshot = await boatSnapshot(id, owner, res); snapshot.error = pendingMessage; snapshot.recording = false; return snapshot;
      }
      if (previous !== state) serviceError = null;
      return boatSnapshot(id, owner, res);
    });
  }
  async function changeDirectory(directory, owner, res) {
    assertUsable();
    if (!normalizeDirectory(directory, allowedRoot)) throw fault(400, '保存目录必须是允许根目录中的绝对路径，仅可包含字母、数字、短横线、下划线和目录分隔符');
    return withLock(async () => {
      if (Object.values(state.boats).some(item => item.armed)) throw fault(409, '请先停止所有无人船录像，再修改保存目录');
      if (directory === state.directory) return configSnapshot(owner);
      const next = clone(state); next.directory = directory;
      await save(next, owner, res); serviceError = null;
      try { for (const id of Object.keys(state.boats)) await applyBoat(id); }
      catch (_) { serviceError = '保存目录已保存，媒体服务尚未确认；系统会自动重试'; }
      // 目录由 MediaMTX 首次写入时建立；旧文件保留原目录，列表显示当前目录。
      return configSnapshot(owner);
    });
  }
  async function deleteClip(id, clipId, owner, res) {
    assertUsable();
    // 与切目录、开始/停止录像和后台配置恢复共用锁，防止校验后换了目标目录。
    return withLock(async () => {
      assertActive(owner, res, true);
      const directory = state.directory, clips = await segmentsFor(id, owner, res);
      const clip = clips.find(item => item.id === clipId);
      if (!clip) throw fault(404, '录像不存在或已超过保留期限，请刷新录像列表');
      const configured = await control('GET', '/v3/config/paths/get/' + id, null, [404]);
      assertActive(owner, res, true);
      if (configured.missing || configured.recordPath !== recordPath(id, directory))
        throw fault(409, '录像保存目录尚未同步，请刷新列表并等待媒体服务确认');
      // 原生删除接口不区分正在写入的文件。录制开启时保留最新片段，
      // 较早片段已由后续片段接替写入，可以在不中断整船录像的情况下删除。
      if ((ownBoat(state, id)?.armed || configured.record === true) && clips[0].id === clipId)
        throw fault(409, '最新片段可能仍在写入，请先停止这艘船的录像后再删除');
      const query = new URLSearchParams({ path: clip.alias, start: clip.start });
      // 仅用服务端目录中查得的船只和开始时间；客户端不能传磁盘路径或时间。
      await control('DELETE', '/v3/recordings/segments/delete?' + query);
      assertActive(owner, res, true);
      for (const record of streams) if (record.deviceId === id && record.clipId === clipId) stopStream(record);
      return { deviceId: id, deletedId: clipId, deleted: true };
    });
  }
  function stopStream(record) { record.request?.destroy(); record.response?.destroy(); record.res.destroy(); }
  const invalidate = key => { for (const record of streams) if (record.owner.key === key) stopStream(record); };
  const detach = accounts?.onInvalidate?.(invalidate);
  async function streamClip(req, res, id, clipId, owner, download) {
    assertUsable();
    if (streams.size >= maxStreams) throw fault(429, '录像播放连接已满，请关闭其他录像后重试');
    const clips = await segmentsFor(id, owner, res), clip = clips.find(item => item.id === clipId);
    if (!clip) throw fault(404, '录像不存在或已超过保留期限');
    assertActive(owner, res);
    if (streams.size >= maxStreams) throw fault(429, '录像播放连接已满，请稍后重试');
    const range = req.headers.range;
    if (range !== undefined && (typeof range !== 'string' || !/^bytes=\d*-\d*$/.test(range) || range.length > 80)) throw fault(416, '录像仅支持单段字节范围');
    const query = new URLSearchParams({ path: clip.alias, start: clip.start, duration: String(clip.duration), format: 'mp4' });
    await new Promise((resolve, reject) => {
      const record = { owner, res, deviceId: id, clipId, request: null, response: null }; streams.add(record); let finished = false;
      const finish = error => { if (finished) return; finished = true; clearTimeout(timer); streams.delete(record); res.removeListener('close', cancelled); req.removeListener('aborted', cancelled); error ? reject(error) : resolve(); };
      const cancelled = () => { record.request?.destroy(); record.response?.destroy(); finish(); };
      res.once('close', cancelled); req.once('aborted', cancelled);
      const timer = setTimeout(() => { record.request?.destroy(); record.response?.destroy(); if (res.headersSent) res.destroy(); finish(fault(504, '录像播放请求超时')); }, streamTimeoutMs); timer.unref?.();
      record.request = httpRequest({ host: '127.0.0.1', port: playbackPort, path: '/get?' + query, method: 'GET', agent: false,
        headers: { ...authHeaders, ...(range ? { Range: range } : {}) } }, upstream => {
        record.response = upstream;
        if (!active(owner) || res.destroyed) { cancelled(); return; }
        if (![200, 206].includes(upstream.statusCode)) { upstream.destroy(); finish(fault(upstream.statusCode === 404 ? 404 : 503, '录像暂时无法播放，请稍后刷新录像列表')); return; }
        const contentType = String(upstream.headers['content-type'] || '');
        if (!/^video\/mp4(?:;|$)/i.test(contentType)) { upstream.destroy(); finish(fault(502, '录像服务未返回 MP4 视频')); return; }
        const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': (download ? 'attachment' : 'inline') + '; filename="' + id + '-' + new Date(clip.start).toISOString().replace(/[:.]/g, '-') + '.mp4"' };
        for (const key of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers[key]) headers[key] = upstream.headers[key];
        res.writeHead(upstream.statusCode, headers);
        if (req.method === 'HEAD') { upstream.destroy(); res.end(); finish(); return; }
        upstream.once('error', () => { res.destroy(); finish(); }); upstream.once('end', () => finish()); upstream.pipe(res);
      });
      record.request.once('error', () => { if (finished) return; if (res.headersSent) { res.destroy(); finish(); } else finish(fault(503, '录像回放服务暂不可用')); });
      record.request.end();
    });
  }
  const timer = enabled ? setInterval(() => { if (!background) { background = reconcile().finally(() => { background = null; }); } }, Math.max(1000, reconcileMs)) : null; timer?.unref?.();
  if (enabled) background = reconcile().finally(() => { background = null; });
  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PREFIX + '/')) return false;
      if (!accounts?.enabled || closed) { req.resume(); json(res, 503, { error: '录像功能需要启用平台账户登录' }); return true; }
      const owner = accounts.sessionFor(req);
      if (!owner) { req.resume(); json(res, 401, { error: '请先登录监测平台' }); return true; }
      const read = ['GET', 'HEAD'].includes(req.method);
      const browserRead = read && !req.headers.origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
      if (!browserRead && !accounts.sameOrigin(req)) { req.resume(); json(res, 403, { error: '请从本站发起录像请求' }); return true; }
      try {
        const configRoute = url.pathname === PREFIX + '/config';
        if (configRoute && url.search) throw fault(400, '录像设置不接受查询参数');
        if (configRoute && req.method === 'GET') { json(res, 200, configSnapshot(owner)); return true; }
        if (configRoute && req.method === 'PATCH') {
          if (!admin(owner)) throw fault(403, '仅管理员可以修改录像设置');
          const input = await readBody(req, bodyTimeoutMs);
          if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'directory')) throw fault(400, '录像设置只允许修改保存目录');
          json(res, 200, await changeDirectory(input.directory, owner, res)); return true;
        }
        const match = url.pathname.match(/^\/api\/video\/recording\/boats\/([A-Za-z0-9_-]{1,64})(?:\/(start|stop)|\/clips\/([a-f0-9]{64}))?$/);
        if (!match) { if (configRoute) throw fault(405, '录像设置仅支持 GET、PATCH'); throw fault(404, '录像接口不存在'); }
        const id = match[1]; await ensureBoat(id); assertActive(owner, res);
        if (match[3]) {
          if (req.method === 'DELETE') {
            if (!admin(owner)) throw fault(403, '仅管理员可以删除录像');
            if (url.search || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0)
              throw fault(400, '删除录像不接受查询参数或请求内容');
            json(res, 200, await deleteClip(id, match[3], owner, res)); return true;
          }
          if (!read) throw fault(405, '录像播放仅支持 GET、HEAD');
          if ([...url.searchParams.keys()].some(key => key !== 'download') || url.searchParams.getAll('download').length > 1 || url.searchParams.has('download') && url.searchParams.get('download') !== '1') throw fault(400, '录像播放参数不正确');
          await streamClip(req, res, id, match[3], owner, url.searchParams.get('download') === '1'); return true;
        }
        if (url.search) throw fault(400, '录像指令不接受查询参数');
        if (!match[2] && req.method === 'GET') { json(res, 200, await boatSnapshot(id, owner, res)); return true; }
        if (match[2] && req.method === 'POST') {
          if (!admin(owner)) throw fault(403, '仅管理员可以开始或停止录像');
          const input = await readBody(req, bodyTimeoutMs); if (Object.keys(input).length) throw fault(400, '录像指令不能包含额外参数');
          json(res, 200, await changeArmed(id, match[2] === 'start', owner, res)); return true;
        }
        throw fault(405, '录像接口不支持此方法');
      } catch (error) {
        req.resume(); if (res.headersSent) res.destroy();
        else json(res, error.status || 503, { error: error.status ? error.message : '录像操作失败，请检查服务器媒体服务' });
      }
      return true;
    },
    async close() { if (closed) return; closed = true; if (timer) clearInterval(timer); detach?.(); inputActivity.clear(); for (const record of streams) stopStream(record); await background?.catch(() => {}); },
    reconcile,
    getState: () => clone(state)
  };
}
module.exports = { createVideoRecordingApi, createRecordingTransport, normalizeDirectory, resolveRecordingConfigFile, PREFIX, ALIAS_PREFIX };
