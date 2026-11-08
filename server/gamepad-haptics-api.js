/* 平台统一震动配置：驾驶员可读取，管理员可修改，文件保存在部署源码之外。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DEFAULTS, normalizeSettings } = require('../public/utils/gamepadHaptics');
const { resolveDriverLayoutFile } = require('./driver-layout-api');
const PREFIX = '/api/gamepad-haptics', MAX_BYTES = 2048;
const fault = (status, message) => Object.assign(Error(message), { status });
function resolveGamepadHapticsFile(env = process.env, file) {
  if (file !== undefined || env.BOAT_GAMEPAD_HAPTICS_FILE) return resolveDriverLayoutFile({}, file ?? env.BOAT_GAMEPAD_HAPTICS_FILE);
  return path.join(path.dirname(resolveDriverLayoutFile({ ...env, BOAT_DRIVER_LAYOUT_FILE: undefined })), 'gamepad-haptics.json');
}
function readJson(req, timeoutMs) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return Promise.reject(fault(415, '请使用 JSON 配置'));
  if (Number(req.headers['content-length']) > MAX_BYTES) return Promise.reject(fault(413, '震动设置过大'));
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      for (const [event, handler] of [['data', data], ['end', end], ['error', aborted], ['aborted', aborted]]) req.removeListener(event, handler);
      error ? reject(error) : resolve(value);
    };
    const data = chunk => { size += chunk.length; if (size > MAX_BYTES) finish(fault(413, '震动设置过大')); else chunks.push(chunk); };
    const end = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { finish(fault(400, '震动设置格式不正确')); } };
    const aborted = () => finish(fault(400, '请求已取消'));
    const timer = setTimeout(() => finish(fault(408, '震动设置请求超时')), timeoutMs); timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
}
function createGamepadHapticsApi({ env = process.env, accounts, file, bodyTimeoutMs = 5000, now = Date.now, heartbeatMs = 15000, maxClients = 128, maxClientsPerSession = 4 } = {}) {
  let configFile = '', error = '', pending = null, closed = false;
  const clients = new Set(); let lastAlertAt = -Infinity;
  let state = { version: 1, revision: 0, ...DEFAULTS, updatedAt: null };
  try {
    configFile = resolveGamepadHapticsFile(env, file);
    try {
      const stat = fs.lstatSync(configFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error('Invalid file');
      const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')), settings = normalizeSettings(stored);
      if (!settings || stored.version !== 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 1 ||
          typeof stored.updatedAt !== 'string' || !Number.isFinite(Date.parse(stored.updatedAt))) throw Error('Invalid configuration');
      state = { version: 1, revision: stored.revision, ...settings, updatedAt: stored.updatedAt };
    } catch (failure) { if (failure.code !== 'ENOENT') { error = '震动配置文件无法读取，请管理员重新保存'; state.enabled = false; } }
  } catch (_) { error = '震动配置路径无效，请设置绝对路径 BOAT_GAMEPAD_HAPTICS_FILE'; state.enabled = false; }
  const snapshot = () => ({ ...state, persistent: !!configFile, error: error || null });
  const active = session => !closed && accounts?.isActive(session) && session.value.role === 'admin';
  const json = (res, status, body) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
  function closeClient(client, force = false) {
    if (!clients.delete(client)) return;
    clearInterval(client.timer);
    if (force) client.res.destroy(); else client.res.end();
  }
  function send(client, event, value) {
    if (!accounts.isActive(client.session) || client.res.destroyed || client.res.writableEnded) { closeClient(client); return false; }
    // 安全提醒只发给当前在线页面；慢连接直接关闭，不排队、不在重连时重播。
    if (client.res.writableLength > 16384 || !client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n')) { closeClient(client, true); return false; }
    return true;
  }
  const unsubscribe = accounts?.onInvalidate(key => { for (const client of [...clients]) if (client.session.key === key) closeClient(client); });
  async function save(next, session, res) {
    if (!configFile) throw fault(503, '震动配置存储路径不可用');
    const temporary = path.join(path.dirname(configFile), '.gamepad-haptics.' + crypto.randomBytes(12).toString('hex') + '.tmp');
    let handle;
    try {
      await fs.promises.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
      handle = await fs.promises.open(temporary, 'wx', 0o640); await handle.chmod(0o640);
      await handle.writeFile(JSON.stringify(next) + '\n', 'utf8'); await handle.sync(); await handle.close(); handle = null;
      if (!active(session) || res.destroyed) throw fault(401, '登录会话已失效，请重新登录');
      fs.renameSync(temporary, configFile); state = next; error = '';
    } finally { if (handle) await handle.close().catch(() => {}); await fs.promises.unlink(temporary).catch(() => {}); }
  }
  return { snapshot, getClientCount: () => clients.size, close() { closed = true; unsubscribe?.(); for (const client of [...clients]) closeClient(client); return pending?.catch(() => {}); }, async handle(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    if (![PREFIX, PREFIX + '/events', PREFIX + '/alert'].includes(url.pathname)) { json(res, 404, { error: '未知的震动设置接口' }); return true; }
    if (!accounts?.enabled || closed) { json(res, 503, { error: '震动配置需要启用平台账户' }); return true; }
    const session = accounts.sessionFor(req);
    if (!session) { json(res, 401, { error: '请先登录平台' }); return true; }
    if (url.pathname === PREFIX + '/events') {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(res, 405, { error: '请使用实时提醒通道' }); return true; }
      if (clients.size >= maxClients || [...clients].filter(client => client.session.key === session.key).length >= maxClientsPerSession) { json(res, 503, { error: '实时提醒连接数已达上限' }); return true; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); req.setTimeout(0); res.setTimeout(0);
      const client = { session, res, timer: null }; clients.add(client);
      res.once('close', () => closeClient(client)); res.once('error', () => closeClient(client));
      if (send(client, 'ready', { serverTime: now() })) {
        client.timer = setInterval(() => {
          if (!accounts.touchKey(session.key) || res.destroyed || res.writableEnded || !res.write(': heartbeat\n\n')) closeClient(client, true);
        }, heartbeatMs); client.timer.unref?.();
      }
      return true;
    }
    if (url.pathname === PREFIX + '/alert') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); json(res, 405, { error: '请使用发送提醒按钮' }); return true; }
      if (session.value.role !== 'admin' || !accounts.sameOrigin(req)) { json(res, 403, { error: '仅管理员可从本站提醒所有手柄' }); return true; }
      let body;
      try { body = await readJson(req, bodyTimeoutMs); } catch (failure) { res.setHeader('Connection', 'close'); json(res, failure.status || 400, { error: failure.message }); req.resume(); return true; }
      if (!active(session)) { json(res, 401, { error: '登录会话已失效，请重新登录' }); return true; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) { json(res, 400, { error: '提醒使用已保存的强度，无需附加参数' }); return true; }
      const time = now();
      if (time - lastAlertAt < 1500) { res.setHeader('Retry-After', '2'); json(res, 429, { error: '提醒过于频繁，请稍后重试' }); return true; }
      lastAlertAt = time;
      const alert = { id: crypto.randomBytes(16).toString('hex'), createdAt: time, expiresAt: time + 5000, durationMs: 1000, intensityPercent: state.intensityPercent };
      let pages = 0; for (const client of [...clients]) if (send(client, 'safety-alert', alert)) pages++;
      json(res, 200, { id: alert.id, pages, durationMs: alert.durationMs, intensityPercent: alert.intensityPercent }); return true;
    }
    if (!['admin', 'driver'].includes(session.value.role)) { json(res, 403, { error: '仅管理员与驾驶员可读取震动配置' }); return true; }
    if (req.method === 'GET') { json(res, 200, snapshot()); return true; }
    if (req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); json(res, 405, { error: '不支持的震动设置操作' }); return true; }
    if (session.value.role !== 'admin' || !accounts.sameOrigin(req)) { json(res, 403, { error: '仅管理员可从本站修改震动配置' }); return true; }
    let input;
    try { input = await readJson(req, bodyTimeoutMs); } catch (failure) { res.setHeader('Connection', 'close'); json(res, failure.status || 400, { error: failure.message }); req.resume(); return true; }
    if (!active(session)) { json(res, 401, { error: '登录会话已失效，请重新登录' }); return true; }
    const settings = normalizeSettings(input);
    if (!settings || Object.keys(input).some(key => !['revision', 'enabled', 'attitudeThresholdDegrees', 'intensityPercent'].includes(key)) || !Number.isSafeInteger(input.revision) || input.revision < 0) {
      json(res, 400, { error: '开关须为布尔值，姿态阈值须为1—90°整数，强度须为1—100%整数' }); return true;
    }
    if (pending || input.revision !== state.revision) { json(res, 409, { error: '配置已被更新，请重新读取后保存' }); return true; }
    const next = { version: 1, revision: state.revision + 1, ...settings, updatedAt: new Date().toISOString() };
    pending = save(next, session, res);
    try { await pending; json(res, 200, snapshot()); }
    catch (failure) { json(res, failure.status || 503, { error: failure.status ? failure.message : '保存失败，配置未更改，请检查状态目录写入权限' }); }
    finally { pending = null; }
    return true;
  } };
}
module.exports = { createGamepadHapticsApi, resolveGamepadHapticsFile, PREFIX };
