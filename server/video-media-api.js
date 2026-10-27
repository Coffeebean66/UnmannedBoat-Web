/* SRT 媒体鉴权和同源 WHEP 信令代理。视频包由 MediaMTX 通过 UDP 转发，Node 只处理鉴权/SDP。 */
'use strict';
const http = require('node:http'), crypto = require('node:crypto'), { isIP } = require('node:net');
const { createMqttDeviceClient } = require('./mqtt-device-api');
const NAME = /^[A-Za-z0-9_-]{1,64}$/, SECRET = /^[a-f0-9]{64}$/, RESOURCE = /^[a-f0-9]{32}$/;
const READER = 'boat-web-media-reader', PREFIX = '/api/video/media';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const error = (status, message) => Object.assign(Error(message), { status });
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

function readMediaConfig(env = process.env) {
  if (env.BOAT_VIDEO_MEDIA_ENABLED !== '1') return { enabled: false };
  const authToken = env.BOAT_VIDEO_MEDIA_AUTH_TOKEN, readerPassword = env.BOAT_VIDEO_MEDIA_READER_PASSWORD;
  const host = env.BOAT_VIDEO_MEDIA_PUBLIC_HOST;
  const port = Number(env.BOAT_VIDEO_SRT_PORT || 8890), webRtcPort = Number(env.BOAT_VIDEO_WEBRTC_PORT || 8189);
  if (!SECRET.test(authToken || '') || !SECRET.test(readerPassword || '') || typeof host !== 'string' ||
    !(isIP(host) || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) ||
    host.includes('..') || !Number.isInteger(port) || port < 1024 || port > 65535 ||
    !Number.isInteger(webRtcPort) || webRtcPort < 1024 || webRtcPort > 65535 || port === webRtcPort) {
    throw Error('Low-latency video configuration is invalid; check the media installation');
  }
  return { enabled: true, authToken, readerPassword, host, port, webRtcPort };
}

function collectBody(req, type, maximum, timeoutMs) {
  if (!new RegExp('^' + type.replace('/', '\\/') + '(?:\\s*;|$)', 'i').test(String(req.headers['content-type'] || ''))) return Promise.reject(error(415, '视频请求内容类型不正确'));
  if (Number(req.headers['content-length']) > maximum) return Promise.reject(error(413, '视频信令过大'));
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks = [];
    const finish = (fault, value) => {
      if (done) return; done = true; clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', aborted); req.removeListener('aborted', aborted);
      fault ? reject(fault) : resolve(value);
    };
    const data = chunk => { size += chunk.length; if (size > maximum) finish(error(413, '视频信令过大')); else chunks.push(chunk); };
    const end = () => finish(null, Buffer.concat(chunks));
    const aborted = () => finish(error(400, '视频请求已取消'));
    const timer = setTimeout(() => finish(error(408, '视频请求超时')), timeoutMs); timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
}

// 上游地址不能来自网页或环境变量。测试可注入 transport，而生产固定连接回环 MediaMTX。
function createMediaTransport({ port = 8889, timeoutMs = 12000 } = {}) {
  return ({ method, path, body, headers = {} }) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fault, value) => { if (settled) return; settled = true; clearTimeout(timer); fault ? reject(fault) : resolve(value); };
    const request = http.request({ host: '127.0.0.1', port, path, method, agent: false,
      headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 65536) { finish(error(502, '视频服务信令响应过大')); response.destroy(); } else chunks.push(chunk); });
      response.once('error', () => finish(error(502, '视频服务连接中断')));
      response.once('end', () => finish(null, { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => { finish(error(504, '视频服务连接超时')); request.destroy(); }, timeoutMs); timer.unref?.();
    request.once('error', () => finish(error(503, '低延迟视频服务暂不可用，请检查媒体服务')));
    request.end(body);
  });
}

function upstreamLocation(value, deviceId, port = 8889) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\\]/.test(value)) throw error(502, '视频服务返回了无效会话');
  const origin = 'http://127.0.0.1:' + port;
  let location; try { location = new URL(value, origin + '/' + deviceId + '/whep'); } catch (_) { throw error(502, '视频服务返回了无效会话'); }
  const expected = new RegExp('^/' + deviceId + '/whep/[A-Za-z0-9_-]{1,128}$');
  if (location.origin !== origin || location.username || location.password || location.search || location.hash || !expected.test(location.pathname)) throw error(502, '视频服务返回了无效会话');
  return location.pathname;
}

function createVideoMediaApi({ env = process.env, accounts, client = createMqttDeviceClient({ timeoutMs: 5000 }),
  upstreamPort = 8889, transport = createMediaTransport({ port: upstreamPort }), now = Date.now, bodyTimeoutMs = 5000, maxSessions = 64, maxPerSession = 4 } = {}) {
  const config = readMediaConfig(env), sessions = new Map(), pending = new Set(), attempts = new Map();
  let closed = false, authWork = 0, managedRead;
  const headers = config.enabled ? { Authorization: 'Basic ' + Buffer.from(READER + ':' + config.readerPassword).toString('base64') } : {};
  const active = session => !closed && !!accounts?.enabled && accounts.isActive(session);
  const reply = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const readManaged = () => {
    if (!managedRead) {
      const task = Promise.resolve().then(() => client('GET', '/devices'));
      managedRead = task; const clear = () => { if (managedRead === task) managedRead = null; }; task.then(clear, clear);
    }
    return managedRead;
  };
  const ensureBoat = async id => {
    const data = await readManaged();
    if (data?.canAuthenticateVideo !== true) throw error(503, '请更新 MQTT 管理组件以启用 SRT 视频鉴权');
    if (!Array.isArray(data.devices) || !data.devices.some(device => device?.deviceId === id)) throw error(404, '无人船未注册，请先在平台设置添加该设备');
  };
  const remove = async record => {
    if (!record || record.removing) return;
    record.removing = true; sessions.delete(record.id);
    try { await transport({ method: 'DELETE', path: record.upstream, headers }); } catch (_) { /* MediaMTX 同时超时/关闭时无需恢复旧连接。 */ }
  };
  const invalidate = key => {
    for (const operation of pending) if (operation.owner.key === key) operation.cancelled = true;
    for (const record of sessions.values()) if (record.owner.key === key) remove(record);
  };
  const detach = accounts?.onInvalidate?.(invalidate);
  const sweep = setInterval(() => {
    for (const record of sessions.values()) if (!active(record.owner) || record.expiresAt <= now()) remove(record);
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
  }, 15000); sweep.unref?.();

  async function mediaAuth(req, res, url) {
    const deny = () => { if (!res.destroyed && !res.writableEnded) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); } };
    if (!config.enabled || closed || req.method !== 'POST' || !LOOPBACK.has(req.socket.remoteAddress) || req.headers.origin ||
      [...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1 ||
      !sameSecret(url.searchParams.get('token'), config.authToken)) { req.resume(); deny(); return; }
    let input;
    try { input = JSON.parse((await collectBody(req, 'application/json', 4096, bodyTimeoutMs)).toString('utf8')); }
    catch (_) { req.resume(); deny(); return; }
    if (!input || typeof input !== 'object' || Array.isArray(input) || !NAME.test(input.path || '') || typeof input.path !== 'string' || authWork >= 8) { deny(); return; }
    if (input.action === 'read' && input.protocol === 'webrtc') {
      if (!LOOPBACK.has(input.ip) || input.user !== READER || !sameSecret(input.password, config.readerPassword)) { deny(); return; }
      res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (input.action !== 'publish' || input.protocol !== 'srt' || typeof input.user !== 'string' || !NAME.test(input.user) ||
      typeof input.password !== 'string' || !/^[\x21-\x39\x3b-\x7e]{6,64}$/.test(input.password) || typeof input.ip !== 'string' || !isIP(input.ip)) { deny(); return; }
    const key = input.ip, time = now(); let rate = attempts.get(key);
    if (!rate || rate.until <= time) { if (attempts.size >= 1024) attempts.delete(attempts.keys().next().value); rate = { count: 0, until: time + 60000 }; attempts.set(key, rate); }
    if (++rate.count > 30) { deny(); return; }
    authWork++;
    try {
      const result = await client('POST', '/video-auth/' + input.path, { username: input.user, password: input.password });
      if (closed || result?.authorized !== true) { deny(); return; }
      res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end();
    } catch (_) { deny(); }
    finally { delete input.password; authWork--; }
  }

  async function createPlayback(req, res, deviceId, owner) {
    if (sessions.size + pending.size >= maxSessions || [...sessions.values()].filter(item => item.owner.key === owner.key).length + [...pending].filter(item => item.owner.key === owner.key).length >= maxPerSession) throw error(429, '视频连接已满，请先关闭其他画面');
    const operation = { owner, cancelled: false }; pending.add(operation);
    const abandoned = () => { if (!res.writableEnded) operation.cancelled = true; };
    req.once('aborted', abandoned); res.once('close', abandoned);
    let record;
    try {
      const body = await collectBody(req, 'application/sdp', 65536, bodyTimeoutMs);
      const offer = body.toString('utf8');
      if (!offer.startsWith('v=0\r\n') && !offer.startsWith('v=0\n') || !/(?:^|\r?\n)m=video /.test(offer) || offer.includes('\0')) throw error(400, '视频 SDP 请求无效');
      await ensureBoat(deviceId);
      if (!active(owner) || operation.cancelled) throw error(401, '登录会话已失效，请重新登录');
      const response = await transport({ method: 'POST', path: '/' + deviceId + '/whep', body,
        headers: { ...headers, 'Content-Type': 'application/sdp', Accept: 'application/sdp' } });
      if (response.status !== 201) throw error(response.status === 404 ? 404 : 503, response.status === 404 ? '该船尚未上传低延迟视频，请检查发送端' : '视频连接未建立，请检查媒体服务及编码');
      const location = upstreamLocation(response.headers?.location, deviceId, upstreamPort);
      record = { id: crypto.randomBytes(16).toString('hex'), deviceId, upstream: location, owner, expiresAt: owner.value.expiresAt || now() + 12 * 60 * 60 * 1000, removing: false };
      if (!response.body?.length || !String(response.headers?.['content-type'] || '').startsWith('application/sdp') || !response.body.toString('utf8').startsWith('v=0')) { await remove(record); record = null; throw error(502, '视频服务返回了无效 SDP'); }
      if (!active(owner) || operation.cancelled || res.destroyed) { await remove(record); record = null; throw error(401, '登录会话已失效，请重新登录'); }
      sessions.set(record.id, record);
      res.writeHead(201, { 'Content-Type': 'application/sdp', 'Cache-Control': 'no-store',
        Location: PREFIX + '/boats/' + deviceId + '/whep/' + record.id, 'Content-Length': response.body.length });
      res.end(response.body);
    } finally {
      pending.delete(operation); req.removeListener('aborted', abandoned); res.removeListener('close', abandoned);
      if (record && (!active(owner) || operation.cancelled || res.destroyed)) await remove(record);
    }
  }

  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PREFIX + '/')) return false;
      if (url.pathname === PREFIX + '/auth') { await mediaAuth(req, res, url); return true; }
      const browserRead = req.method === 'GET' && !req.headers.origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
      // 旧版云端口令登录仍能使用 HTTP 视频；未安装媒体服务时只公开一个关闭标记。
      if (!closed && !config.enabled && !accounts?.enabled && url.pathname === PREFIX + '/config' && req.method === 'GET') {
        if (!browserRead && !accounts?.sameOrigin(req)) reply(res, 403, { error: '请从本站发起视频请求' });
        else reply(res, 200, { enabled: false });
        return true;
      }
      if (closed || !accounts?.enabled) { reply(res, 503, { error: '低延迟视频需要启用平台账户登录' }); return true; }
      const owner = accounts.sessionFor(req);
      if (!owner) { reply(res, 401, { error: '请先登录监测平台' }); return true; }
      if (!browserRead && !accounts.sameOrigin(req)) { reply(res, 403, { error: '请从本站发起视频请求' }); return true; }
      if (url.pathname === PREFIX + '/config' && req.method === 'GET') {
        reply(res, 200, config.enabled ? { enabled: true, format: 'webrtc', playbackBase: PREFIX + '/boats/', ingest: { protocol: 'srt', host: config.host, port: config.port } } : { enabled: false }); return true;
      }
      if (!config.enabled) { reply(res, 503, { error: '服务器尚未启用 SRT / WebRTC 视频服务' }); return true; }
      const match = url.pathname.match(/^\/api\/video\/media\/boats\/([A-Za-z0-9_-]{1,64})\/whep(?:\/([a-f0-9]{32}))?$/);
      if (!match || url.search) { reply(res, 404, { error: '视频接口不存在' }); return true; }
      try {
        if (!match[2] && req.method === 'POST') await createPlayback(req, res, match[1], owner);
        else if (match[2] && req.method === 'DELETE') {
          const record = sessions.get(match[2]);
          if (!RESOURCE.test(match[2]) || !record || record.deviceId !== match[1] || record.owner.key !== owner.key || !active(record.owner)) { reply(res, 404, { error: '视频会话不存在或已结束' }); return true; }
          await remove(record); if (!res.destroyed) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); }
        } else { res.setHeader('Allow', match[2] ? 'DELETE' : 'POST'); reply(res, 405, { error: '视频接口不支持此方法；请使用完整 ICE 的 WHEP 会话' }); }
      } catch (fault) {
        req.resume(); reply(res, [400, 401, 404, 408, 413, 415, 429, 502, 503, 504].includes(fault.status) ? fault.status : 503,
          { error: fault.status ? fault.message : '低延迟视频连接失败，请检查媒体服务' });
      }
      return true;
    },
    async close() {
      if (closed) return; closed = true; clearInterval(sweep); detach?.(); managedRead = null;
      for (const operation of pending) operation.cancelled = true;
      await Promise.allSettled([...sessions.values()].map(remove)); attempts.clear();
    },
    getSessionCount: () => sessions.size
  };
}
module.exports = { createVideoMediaApi, createMediaTransport, readMediaConfig, upstreamLocation, READER };
