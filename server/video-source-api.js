/* 每船视频来源：WVP 由 ZLM 直接播放；本机 RTSP → MediaMTX 独立保留录像路径。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createWvpClient, readWvpConfig, ID } = require('./wvp-client');
const { createRecordingTransport } = require('./video-recording-api');
const { resolveDriverLayoutFile } = require('./driver-layout-api');
const PREFIX = '/api/video/sources', BOAT = /^[A-Za-z0-9_-]{1,64}$/;
const fault = (status, message) => Object.assign(Error(message), { status });
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : null;
function resolveSourceFile(env, file) {
  if (file !== undefined || env.BOAT_VIDEO_SOURCE_FILE) return resolveDriverLayoutFile(env, file ?? env.BOAT_VIDEO_SOURCE_FILE);
  return resolveDriverLayoutFile({ ...env, BOAT_DRIVER_LAYOUT_FILE: '' }).replace(/driver-layout\.json$/, 'video-sources.json');
}
function readBody(req, timeoutMs) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return Promise.reject(fault(415, '请使用 JSON 图传设置'));
  return new Promise((resolve, reject) => {
    let done = false, size = 0; const chunks = [];
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end); req.removeListener('aborted', aborted); req.removeListener('error', aborted); error ? reject(error) : resolve(value); };
    const data = chunk => { size += chunk.length; if (size > 2048) finish(fault(413, '图传设置过大')); else chunks.push(chunk); };
    const end = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { finish(fault(400, '图传设置格式不正确')); } };
    const aborted = () => finish(fault(400, '图传设置请求已取消'));
    const timer = setTimeout(() => finish(fault(408, '图传设置请求超时')), timeoutMs); timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted);
  });
}
function createVideoSourceApi({ env = process.env, accounts, file, client, wvp, transport = createRecordingTransport(),
  now = Date.now, reconcileMs = 15000, bodyTimeoutMs = 5000 } = {}) {
  const config = readWvpConfig(env), enabled = config.enabled;
  wvp ||= createWvpClient({ config });
  if (!client) client = require('./mqtt-device-api').createMqttDeviceClient({ timeoutMs: 5000 });
  const headers = { Authorization: 'Basic ' + Buffer.from('boat-web-media-reader:' + (env.BOAT_VIDEO_MEDIA_READER_PASSWORD || '')).toString('base64'), Accept: 'application/json' };
  let state = { version: 1, revision: 0, boats: {} }, closed = false, pending = null, filePath = '', loadError = '';
  const operations = new Map(), runtime = new Map(); let background = null;
  const validBoat = id => typeof id === 'string' && BOAT.test(id) && !id.startsWith('__boatrec_');
  if (enabled) {
    try {
      filePath = resolveSourceFile(env, file);
      try {
        const stat = fs.lstatSync(filePath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error();
        const input = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (input?.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 1 || !input.boats || typeof input.boats !== 'object' || Array.isArray(input.boats) || Object.keys(input.boats).length > 64) throw Error();
        for (const [id, item] of Object.entries(input.boats)) {
          if (!validBoat(id) || !item || !['direct', 'wvp'].includes(item.provider) || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
            (item.provider === 'wvp' && (!ID.test(item.deviceId || '') || !ID.test(item.channelId || ''))) ||
            !item.original || typeof item.original.source !== 'string' || !['boolean'].includes(typeof item.original.sourceOnDemand) || !['automatic', 'udp', 'multicast', 'tcp'].includes(item.original.rtspTransport)) throw Error();
        }
        state = input;
      } catch (error) { if (error.code !== 'ENOENT') loadError = '图传通道配置无法读取，请检查服务器状态文件后重启'; }
    } catch (_) { loadError = '图传通道状态路径无效，请设置 BOAT_VIDEO_SOURCE_FILE 的绝对路径'; }
  }
  const active = session => !closed && accounts?.enabled && accounts.isActive(session);
  const admin = session => active(session) && session.value.role === 'admin';
  const assertUsable = () => { if (closed || !enabled) throw fault(503, '服务器尚未启用 WVP 接入，请按 WVP_SETUP.md 配置'); if (loadError) throw fault(503, loadError); };
  const json = (res, status, data) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  async function control(method, route, body, missing = false) {
    const result = await transport({ method, path: route, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: Buffer.from(JSON.stringify(body)) } : {}) });
    if (closed) throw fault(503, '图传通道服务已停止');
    if (missing && result.status === 404) return null;
    if (![200, 201, 204].includes(result.status)) throw fault(503, '媒体管理接口不可用，请更新视频组件并检查服务状态');
    try { return result.body?.length ? JSON.parse(result.body.toString('utf8')) : {}; } catch (_) { throw fault(502, '媒体管理响应格式不正确'); }
  }
  async function managed() {
    const data = await client('GET', '/devices');
    if (!Array.isArray(data?.devices)) throw fault(503, '无法读取无人船列表，请检查 MQTT 管理组件');
    return data.devices.filter(item => validBoat(item?.deviceId)).map(item => ({ deviceId: item.deviceId }));
  }
  async function ensureBoat(id) {
    if (!validBoat(id) || !(await managed()).some(item => item.deviceId === id)) throw fault(404, '无人船未注册，请先在平台设置添加设备');
  }
  const sourceFields = value => ({ source: value?.source || 'publisher', sourceOnDemand: value?.sourceOnDemand === true, rtspTransport: value?.rtspTransport || 'automatic' });
  // 新版 MediaMTX 的 online 只说明源已启动，ready 才表示已收到可播放的轨道。
  const receiving = native => native?.ready === true || !!native && !Object.hasOwn(native, 'ready') && native.online === true;
  async function patchPath(id, fields) {
    const current = await control('GET', '/v3/config/paths/get/' + id, null, true);
    if (!current) await control('POST', '/v3/config/paths/add/' + id, fields);
    else if (Object.entries(fields).some(([key, value]) => current[key] !== value)) await control('PATCH', '/v3/config/paths/patch/' + id, fields);
  }
  function source(id) {
    const item = own(state.boats, id), live = runtime.get(id);
    return { provider: item?.provider || 'direct', revision: item?.revision || 0, label: item?.provider === 'wvp' ? 'WVP / GB28181' : 'SRT / UDP',
      applied: live?.applied ?? !item, receiving: live?.receiving || false, error: live?.error || loadError || null };
  }
  const summaries = () => Object.fromEntries(Object.keys(state.boats).map(id => [id, source(id)]));
  async function apply(id) {
    const item = own(state.boats, id); if (!item || closed) return;
    try {
      let live = runtime.get(id);
      if (item.provider === 'direct') {
        runtime.delete(id); live = null;
        await patchPath(id, item.original);
      }
      else {
        // 摄像头离线时先停止原输入，避免页面或录像误用上一条通道的画面。
        if (!live?.url || live.revision !== item.revision) {
          await patchPath(id, { source: 'rtsp://127.0.0.1:' + config.rtspPort + '/__boat_pending/' + id, sourceOnDemand: false, rtspTransport: 'tcp' });
        } else {
          await patchPath(id, { source: live.url, sourceOnDemand: false, rtspTransport: 'tcp' });
        }
        const native = await control('GET', '/v3/paths/get/' + id, null, true);
        if (!live?.url || live.revision !== item.revision || !receiving(native)) {
          const started = await wvp.start(item.deviceId, item.channelId);
          if (closed || own(state.boats, id) !== item) return;
          await patchPath(id, { source: started.url, sourceOnDemand: false, rtspTransport: 'tcp' });
          live = { ...started, revision: item.revision };
        }
      }
      const native = await control('GET', '/v3/paths/get/' + id, null, true);
      runtime.set(id, { ...live, deviceId: item.provider === 'wvp' ? item.deviceId : undefined, channelId: item.provider === 'wvp' ? item.channelId : undefined,
        revision: item.revision, applied: true, receiving: receiving(native), error: null, checkedAt: now() });
    } catch (error) {
      runtime.set(id, { ...runtime.get(id), revision: item.revision, applied: false, receiving: false, error: error.status ? error.message : '视频来源连接失败，请检查 WVP 和媒体服务', checkedAt: now() });
      throw error;
    }
  }
  async function prepare(id, { force = false } = {}) {
    if (!enabled) return;
    assertUsable(); if (!own(state.boats, id)) return;
    if (operations.has(id)) return operations.get(id);
    const live = runtime.get(id);
    if (!force && live?.revision === own(state.boats, id).revision && now() - live.checkedAt < 5000) {
      if (!live.applied) throw fault(503, live.error); return;
    }
    const task = apply(id); operations.set(id, task);
    try { await task; } finally { if (operations.get(id) === task) operations.delete(id); }
  }
  async function persist(next, session, res) {
    const temporary = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + crypto.randomBytes(12).toString('hex') + '.tmp'); let handle;
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      handle = await fs.promises.open(temporary, 'wx', 0o600); await handle.chmod(0o600); await handle.writeFile(JSON.stringify(next) + '\n', 'utf8'); await handle.sync(); await handle.close(); handle = null;
      if (!admin(session) || res.destroyed) throw fault(401, '登录会话已失效，请重新登录');
      fs.renameSync(temporary, filePath); state = next;
    } finally { if (handle) await handle.close().catch(() => {}); await fs.promises.unlink(temporary).catch(() => {}); }
  }
  const snapshot = devices => ({ enabled, revision: state.revision, persistent: !!filePath, error: loadError || null,
    boats: devices.map(({ deviceId }) => ({ deviceId, ...source(deviceId), ...(own(state.boats, deviceId)?.provider === 'wvp' ? { wvpDeviceId: own(state.boats, deviceId).deviceId, channelId: own(state.boats, deviceId).channelId } : {}) })) });
  async function save(id, input, session, res) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['revision', 'provider', 'deviceId', 'channelId'].includes(key)) ||
      !Number.isSafeInteger(input.revision) || !['direct', 'wvp'].includes(input.provider) || input.provider === 'wvp' && (!ID.test(input.deviceId || '') || !ID.test(input.channelId || ''))) throw fault(400, '图传通道参数无效');
    if (input.revision !== state.revision) throw fault(409, '图传通道已被修改，请重新读取后再保存');
    await ensureBoat(id);
    if (input.provider === 'wvp') {
      const { channels } = await wvp.channels(input.deviceId);
      if (!channels.some(item => item.channelId === input.channelId)) throw fault(400, 'WVP 通道不存在，请先刷新设备与通道列表');
    }
    await operations.get(id)?.catch(() => {});
    if (!admin(session) || res.destroyed) throw fault(401, '登录会话已失效，请重新登录');
    const current = own(state.boats, id);
    const original = current?.original || sourceFields(await control('GET', '/v3/config/paths/get/' + id, null, true));
    const revision = state.revision + 1;
    const item = { provider: input.provider, revision, original, ...(input.provider === 'wvp' ? { deviceId: input.deviceId, channelId: input.channelId } : {}) };
    await persist({ version: 1, revision, boats: { ...state.boats, [id]: item } }, session, res);
    runtime.delete(id);
    // 选择已经落盘；离线时返回明确待接收状态，后台会重试，用户不必反复保存。
    try { await prepare(id, { force: true }); } catch (_) { /* source() 提供经过过滤的错误原因。 */ }
    const devices = await managed();
    if (!admin(session) || res.destroyed) throw fault(401, '登录会话已失效，请重新登录');
    return { ...snapshot(devices), saved: true, selected: source(id) };
  }
  async function reconcile() {
    if (closed || !enabled || loadError || pending) return;
    const boats = await managed();
    await Promise.allSettled(boats.filter(item => own(state.boats, item.deviceId)).map(item => prepare(item.deviceId)));
  }
  const timer = enabled ? setInterval(() => { if (!background) { background = reconcile().catch(() => {}).finally(() => { background = null; }); } }, reconcileMs) : null;
  timer?.unref?.();
  return { enabled, source, summaries, prepare, async openPlayback(id, offer, { beforeSend = () => true } = {}) {
    assertUsable();
    const item = validBoat(id) ? own(state.boats, id) : null;
    if (item?.provider !== 'wvp') throw fault(409, '视频来源已切换，请重新连接');
    const current = () => !closed && own(state.boats, id) === item && beforeSend();
    const session = await wvp.openVideo(item.deviceId, item.channelId, offer, { beforeSend: current });
    // 点播/协商可能晚于切换通道、退出登录或取消请求完成，不能留下旧来源会话。
    if (!current()) {
      await wvp.closeVideo(session.resource).catch(() => {});
      throw fault(409, '视频来源或登录状态已变化，请重新连接');
    }
    return session;
  }, closePlayback: resource => wvp.closeVideo(resource), cameraBinding(id) {
    assertUsable();
    const item = validBoat(id) ? own(state.boats, id) : null;
    return item?.provider === 'wvp' ? { deviceId: item.deviceId, channelId: item.channelId, revision: item.revision } : null;
  }, async close() {
    closed = true; if (timer) clearInterval(timer); wvp.close?.();
    await Promise.allSettled([pending, background, ...operations.values()].filter(Boolean));
  }, async handle(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    const session = accounts?.sessionFor(req);
    if (!active(session)) { json(res, accounts?.enabled ? 401 : 503, { error: '请登录平台后管理图传通道' }); return true; }
    if (!admin(session)) { json(res, 403, { error: '只有管理员可以切换服务器图传通道' }); return true; }
    const browserRead = req.method === 'GET' && !req.headers.origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
    if (!browserRead && !accounts.sameOrigin(req)) { json(res, 403, { error: '请从本站管理视频来源' }); return true; }
    try {
      if (url.pathname === PREFIX && req.method === 'GET') { json(res, 200, enabled ? snapshot(await managed()) : { enabled: false, error: '服务器尚未配置 WVP，请参考 WVP_SETUP.md' }); return true; }
      assertUsable();
      if (url.pathname === PREFIX + '/wvp/devices' && req.method === 'GET') {
        const [devices, media] = await Promise.all([wvp.devices(), wvp.media()]);
        if (active(session)) json(res, 200, { ...devices, media }); return true;
      }
      const channels = url.pathname.match(/^\/api\/video\/sources\/wvp\/devices\/([A-Za-z0-9_-]{1,128})\/channels$/);
      if (channels && req.method === 'GET') { const result = await wvp.channels(channels[1]); if (active(session)) json(res, 200, result); return true; }
      const boat = url.pathname.match(/^\/api\/video\/sources\/boats\/([A-Za-z0-9_-]{1,64})$/);
      if (boat && req.method === 'PUT' && !url.search) {
        const input = await readBody(req, bodyTimeoutMs);
        if (pending) throw fault(409, '另一项图传设置正在保存，请稍后再试');
        if (Object.keys(state.boats).length >= 64 && !own(state.boats, boat[1])) throw fault(409, '已达到图传通道配置数量上限');
        pending = save(boat[1], input, session, res);
        try { json(res, 200, await pending); } finally { pending = null; }
        return true;
      }
      json(res, 404, { error: '图传通道接口不存在' });
    } catch (error) {
      req.resume(); json(res, [400, 401, 404, 408, 409, 413, 415, 502, 503, 504].includes(error.status) ? error.status : 503,
        { error: error.status ? error.message : '图传通道操作失败，请检查服务器状态目录及视频服务' });
    }
    return true;
  } };
}
module.exports = { createVideoSourceApi, resolveSourceFile, PREFIX };
