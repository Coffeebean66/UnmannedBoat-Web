/* 启动页全局开关：公开读取供登录前使用，仅管理员可写，状态保存在源码目录外。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { resolveDriverLayoutFile } = require('./driver-layout-api');
const PREFIX = '/api/startup-settings', MAX_BYTES = 1024;
const fault = (status, message) => Object.assign(Error(message), { status });
function resolveStartupSettingsFile(env = process.env, file) {
  if (file !== undefined || env.BOAT_STARTUP_SETTINGS_FILE) return resolveDriverLayoutFile({}, file ?? env.BOAT_STARTUP_SETTINGS_FILE);
  return path.join(path.dirname(resolveDriverLayoutFile({ ...env, BOAT_DRIVER_LAYOUT_FILE: undefined })), 'startup-settings.json');
}
function readJson(req, timeoutMs) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return Promise.reject(fault(415, '请使用 JSON 配置'));
  if (Number(req.headers['content-length']) > MAX_BYTES) return Promise.reject(fault(413, '启动设置过大'));
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      for (const [event, handler] of [['data', data], ['end', end], ['error', aborted], ['aborted', aborted]]) req.removeListener(event, handler);
      error ? reject(error) : resolve(value);
    };
    const data = chunk => { size += chunk.length; if (size > MAX_BYTES) finish(fault(413, '启动设置过大')); else chunks.push(chunk); };
    const end = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { finish(fault(400, '启动设置格式不正确')); } };
    const aborted = () => finish(fault(400, '请求已取消'));
    const timer = setTimeout(() => finish(fault(408, '启动设置请求超时')), timeoutMs); timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
}
function createStartupSettingsApi({ env = process.env, accounts, file, defaultEnabled = true, bodyTimeoutMs = 5000 } = {}) {
  let configFile = '', error = '', pending = null, closed = false;
  let state = { version: 1, revision: 0, enabled: defaultEnabled === true, updatedAt: null };
  try {
    configFile = resolveStartupSettingsFile(env, file);
    try {
      const stat = fs.lstatSync(configFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error('Invalid file');
      const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (!stored || stored.version !== 1 || typeof stored.enabled !== 'boolean' || !Number.isSafeInteger(stored.revision) || stored.revision < 1 ||
          typeof stored.updatedAt !== 'string' || !Number.isFinite(Date.parse(stored.updatedAt))) throw Error('Invalid configuration');
      state = { version: 1, revision: stored.revision, enabled: stored.enabled, updatedAt: stored.updatedAt };
    } catch (failure) { if (failure.code !== 'ENOENT') error = '启动配置文件无法读取，请管理员重新保存'; }
  } catch (_) { error = '启动配置路径无效，请设置绝对路径 BOAT_STARTUP_SETTINGS_FILE'; }
  const snapshot = () => ({ ...state, persistent: !!configFile, error: error || null });
  const active = session => !closed && accounts?.isActive(session) && session.value.role === 'admin';
  const json = (res, status, body) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
  async function save(next, session, res) {
    if (!configFile) throw fault(503, '启动配置存储路径不可用');
    const temporary = path.join(path.dirname(configFile), '.startup-settings.' + crypto.randomBytes(12).toString('hex') + '.tmp');
    let handle;
    try {
      await fs.promises.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
      handle = await fs.promises.open(temporary, 'wx', 0o640); await handle.chmod(0o640);
      await handle.writeFile(JSON.stringify(next) + '\n', 'utf8'); await handle.sync(); await handle.close(); handle = null;
      // 保存期间撤销权限或退出的请求不能再写入全局配置。
      if (!active(session) || res.destroyed) throw fault(401, '登录会话已失效，请重新登录');
      fs.renameSync(temporary, configFile); state = next; error = '';
    } finally { if (handle) await handle.close().catch(() => {}); await fs.promises.unlink(temporary).catch(() => {}); }
  }
  return { snapshot, close() { closed = true; return pending?.catch(() => {}); }, async handle(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    if (url.pathname !== PREFIX) { json(res, 404, { error: '未知的启动设置接口' }); return true; }
    if (closed) { json(res, 503, { error: '服务正在关闭' }); return true; }
    // 这里只包含开关与配置版本，不包含账户、路径或其他敏感配置。
    if (req.method === 'GET') { json(res, 200, snapshot()); return true; }
    if (req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); json(res, 405, { error: '不支持的启动设置操作' }); return true; }
    if (!accounts?.enabled) { json(res, 503, { error: '修改启动配置需要启用平台账户' }); return true; }
    const session = accounts.sessionFor(req);
    if (!session) { json(res, 401, { error: '请先登录平台' }); return true; }
    if (session.value.role !== 'admin' || !accounts.sameOrigin(req)) { json(res, 403, { error: '仅管理员可从本站修改启动配置' }); return true; }
    let input;
    try { input = await readJson(req, bodyTimeoutMs); } catch (failure) { res.setHeader('Connection', 'close'); json(res, failure.status || 400, { error: failure.message }); req.resume(); return true; }
    if (!active(session)) { json(res, 401, { error: '登录会话已失效，请重新登录' }); return true; }
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean' ||
        !Number.isSafeInteger(input.revision) || input.revision < 0 || Object.keys(input).some(key => !['revision', 'enabled'].includes(key))) {
      json(res, 400, { error: '开关须为布尔值，并附上读取到的配置版本' }); return true;
    }
    if (pending || input.revision !== state.revision) { json(res, 409, { error: '配置已被更新，请重新读取后保存' }); return true; }
    const next = { version: 1, revision: state.revision + 1, enabled: input.enabled, updatedAt: new Date().toISOString() };
    pending = save(next, session, res);
    try { await pending; json(res, 200, snapshot()); }
    catch (failure) { json(res, failure.status || 503, { error: failure.status ? failure.message : '保存失败，配置未更改，请检查状态目录写入权限' }); }
    finally { pending = null; }
    return true;
  } };
}
module.exports = { createStartupSettingsApi, resolveStartupSettingsFile, PREFIX };
