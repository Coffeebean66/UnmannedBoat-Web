/* 管理员设备账号入口。网页进程只通过本机 Unix socket 调用受信任管理组件。 */
'use strict';
const http = require('node:http');

const SOCKET_PATH = '/run/unmanned-boat-mqtt-admin/control.sock';
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REVISION = /^[a-f0-9]{64}$/;
const PASSWORD = /^[\x21-\x39\x3b-\x7e]{8,64}$/;
const VIDEO_PASSWORD = /^[\x21-\x39\x3b-\x7e]{6,64}$/;
const unavailable = error => ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES'].includes(error.code);
const fault = (status, message) => Object.assign(Error(message), { status });

// 固定地址和路径，禁止把浏览器输入转成命令、配置路径或任意网络请求。
function createMqttDeviceClient({ socketPath = SOCKET_PATH, timeoutMs = 30000 } = {}) {
  return (method, route, body) => new Promise((resolve, reject) => {
    const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let settled = false, request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(fault(504, '设备账号请求超时，修改结果未确认，请重新读取后再操作'));
      request?.destroy();
    }, timeoutMs);
    timer.unref?.();
    request = http.request({ socketPath, method, path: route, agent: false,
      headers: { Accept: 'application/json', ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}) }
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 32768) { finish(fault(503, '设备管理组件响应异常，请重新读取')); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('error', () => finish(fault(503, '设备管理组件连接中断，修改结果未确认，请重新读取')));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          // 子进程或组件错误详情可能包含配置内容，不直接转发给浏览器。
          const videoRoute = /\/video$/.test(route);
          const messages = { 400: videoRoute ? '视频账号格式不正确' : '设备账号格式不正确', 404: '设备不存在，请重新读取',
            405: videoRoute ? 'MQTT 管理组件版本较旧或未安装视频账号管理能力，请按 README 运行 maintenance/install-mqtt-device-admin.sh 后重试' : 'MQTT 管理组件版本较旧，请按 README 重新安装管理组件以支持此操作',
            409: videoRoute ? '视频账号配置已变化、用户名重名或管理组件正在处理请求，请重新读取后再操作；如提示版本较旧，请按 README 运行 maintenance/install-mqtt-device-admin.sh 后重试' : '配置已变化、账号重名或组件正在处理请求，请重新读取后再操作' };
          return finish(fault(messages[response.statusCode] ? response.statusCode : 503,
            messages[response.statusCode] || '设备账号保存未确认，请重新读取；如持续失败请检查管理组件日志'));
        }
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { finish(fault(503, '设备管理组件响应异常，请重新读取')); }
      });
    });
    request.on('error', error => finish(unavailable(error)
      ? Object.assign(fault(503, '服务器尚未启用 MQTT 设备账号管理组件，请按 README 完成一次安装'), { unavailable: true })
      : fault(503, '设备管理组件连接失败，修改结果未确认，请重新读取')));
    request.end(raw);
  });
}

function snapshot(data) {
  if (!data || typeof data.revision !== 'string' || !REVISION.test(data.revision) || !Array.isArray(data.devices) || data.devices.length > 64) {
    throw fault(503, '设备管理组件响应格式异常，请重新读取');
  }
  const ids = new Set(), names = new Set();
  const devices = data.devices.map(device => {
    if (!device || typeof device.deviceId !== 'string' || typeof device.username !== 'string' || !NAME.test(device.deviceId) || !NAME.test(device.username) ||
      ids.has(device.deviceId) || names.has(device.username)) throw fault(503, '设备管理组件返回了无效设备，请检查服务器配置');
    ids.add(device.deviceId); names.add(device.username);
    return { deviceId: device.deviceId, username: device.username };
  });
  const result = { devices, revision: data.revision, ...(data.canCreate === true ? { canCreate: true } : {}) };
  // 新版管理组件公开视频账号时只保留设备 ID 和用户名；任何密码、哈希或其它字段都不会进入网页响应。
  if (Object.hasOwn(data, 'canManageVideo')) {
    if (typeof data.canManageVideo !== 'boolean') throw fault(503, '设备管理组件返回了无效视频管理能力');
    result.canManageVideo = data.canManageVideo;
  }
  if (Object.hasOwn(data, 'videos')) {
    if (!Array.isArray(data.videos) || data.videos.length > devices.length) throw fault(503, '设备管理组件返回了无效视频账号');
    const videoIds = new Set(), videoNames = new Set();
    result.videos = data.videos.map(video => {
      if (!video || typeof video !== 'object' || Array.isArray(video) ||
        typeof video.deviceId !== 'string' || !NAME.test(video.deviceId) ||
        typeof video.username !== 'string' || !NAME.test(video.username) ||
        !ids.has(video.deviceId) || videoIds.has(video.deviceId) || videoNames.has(video.username) || names.has(video.username)) {
        throw fault(503, '设备管理组件返回了无效视频账号');
      }
      videoIds.add(video.deviceId); videoNames.add(video.username);
      return { deviceId: video.deviceId, username: video.username };
    });
  } else if (data.canManageVideo === true) {
    // 能力已声明时必须同时提供完整的公开列表，避免网页把未知状态误当成未配置。
    throw fault(503, '设备管理组件返回的视频账号列表缺失，请重新安装管理组件');
  }
  return result;
}

function validateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['username', 'password', 'revision'].includes(key)) ||
    typeof value.username !== 'string' || !NAME.test(value.username) ||
    typeof value.revision !== 'string' || !REVISION.test(value.revision) ||
    Object.hasOwn(value, 'password') && (typeof value.password !== 'string' || !PASSWORD.test(value.password))) {
    throw fault(400, '账号需为1～64位字母、数字或下划线、短横线；新密码需8～64位非空白 ASCII 字符，不能包含冒号；请重新读取后操作');
  }
  return { username: value.username, revision: value.revision,
    ...(Object.hasOwn(value, 'password') ? { password: value.password } : {}) };
}

function validateCreateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.deviceId !== 'string' || !NAME.test(value.deviceId)) throw fault(400, '新设备 ID 需为1～64位字母、数字、下划线或短横线');
  const { deviceId, ...credentials } = value, input = validateInput(credentials);
  if (!Object.hasOwn(input, 'password')) throw fault(400, '新增无人船必须设置 MQTT 接入密码');
  return { deviceId, ...input };
}

function validateVideoInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['deviceId', 'username', 'password', 'revision'].includes(key)) ||
    typeof value.deviceId !== 'string' || !NAME.test(value.deviceId) ||
    typeof value.username !== 'string' || !NAME.test(value.username) ||
    typeof value.revision !== 'string' || !REVISION.test(value.revision) ||
    Object.hasOwn(value, 'password') && (typeof value.password !== 'string' || !VIDEO_PASSWORD.test(value.password))) {
    throw fault(400, '视频账号需为有效设备 ID、1～64 位用户名、6～64 位不含冒号或空白的 ASCII 密码；请重新读取后操作');
  }
  return { deviceId: value.deviceId, username: value.username, revision: value.revision,
    ...(Object.hasOwn(value, 'password') ? { password: value.password } : {}) };
}

function validateVideoPatchInput(value, deviceId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['username', 'password', 'revision'].includes(key))) {
    throw fault(400, '视频账号格式不正确，请重新读取后操作');
  }
  return validateVideoInput({ deviceId, ...value });
}

function readBody(req, timeoutMs) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return Promise.reject(fault(415, '请使用 JSON 格式提交设备账号'));
  if (Number(req.headers['content-length']) > 4096) return Promise.reject(fault(413, '设备账号请求过大'));
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', aborted); req.removeListener('aborted', aborted);
      if (error) reject(error); else resolve(value);
    };
    const data = chunk => { size += chunk.length; if (size > 4096) finish(fault(413, '设备账号请求过大')); else chunks.push(chunk); };
    const end = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { finish(fault(400, '设备账号请求格式不正确')); } };
    const aborted = () => finish(fault(400, '设备账号请求已中断'));
    const timer = setTimeout(() => finish(fault(408, '设备账号请求超时')), timeoutMs); timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
}

function createMqttDeviceApi({ accounts, client = createMqttDeviceClient(), bodyTimeoutMs = 5000 } = {}) {
  let closed = false, writing = false, reading = null;
  // 设备/视频两个面板会同时读取。共享本次在途快照，避免 root 组件将第二次读取误判为并发配置操作。
  // 完成后立即丢弃快照；重新读取始终访问组件，每个 HTTP 请求仍单独核验自己的管理员会话。
  const readSnapshot = () => {
    if (!reading) {
      const pending = Promise.resolve().then(() => client('GET', '/devices')).then(snapshot);
      reading = pending;
      const clear = () => { if (reading === pending) reading = null; };
      pending.then(clear, clear);
    }
    return reading;
  };
  const active = session => !closed && accounts.isActive(session) && session.value.role === 'admin';
  const json = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  return { close() { closed = true; reading = null; }, async handle(req, res, url) {
    if (url.pathname !== '/api/mqtt/devices' && !url.pathname.startsWith('/api/mqtt/devices/')) return false;
    if (!accounts?.enabled || closed) { json(res, 503, { error: '请先启用平台账户登录，再由管理员管理 MQTT 设备账号' }); return true; }
    const session = accounts.sessionFor(req);
    if (!session) { json(res, 401, { error: '请先登录管理员账户' }); return true; }
    if (session.value.role !== 'admin') { json(res, 403, { error: '仅管理员可以管理 MQTT 设备账号' }); return true; }
    const collection = url.pathname === '/api/mqtt/devices';
    const videoMatch = url.pathname.match(/^\/api\/mqtt\/devices\/([A-Za-z0-9_-]{1,64})\/video$/);
    const match = url.pathname.match(/^\/api\/mqtt\/devices\/([A-Za-z0-9_-]{1,64})$/);
    if (!collection && !match && !videoMatch) { json(res, 404, { error: '设备不存在' }); return true; }
    const creating = collection && req.method === 'POST';
    const videoMutation = !!videoMatch && req.method === 'PATCH';
    if (!(collection && req.method === 'GET' || creating || match && req.method === 'PATCH' || videoMutation)) {
      res.setHeader('Allow', collection ? 'GET, POST' : videoMatch ? 'PATCH' : 'PATCH'); json(res, 405, { error: '不支持此设备账号管理方法' }); return true;
    }
    const browserRead = collection && req.method === 'GET' && !req.headers.origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
    if (!browserRead && !accounts.sameOrigin(req)) { json(res, 403, { error: '请从本站发起设备账号操作' }); return true; }
    if (collection && req.method === 'GET') {
      try {
        const data = await readSnapshot();
        if (active(session)) json(res, 200, { enabled: true, ...data, canManageVideo: data.canManageVideo === true, videos: Array.isArray(data.videos) ? data.videos : [] });
        else json(res, 401, { error: '账户会话已失效，请重新登录' });
      } catch (error) {
        if (!active(session)) json(res, 401, { error: '账户会话已失效，请重新登录' });
        else if (error.unavailable) json(res, 200, { enabled: false, reason: '服务器尚未启用 MQTT 设备账号管理组件，请按 README 完成一次安装。' });
        else json(res, error.status || 503, { error: '读取 MQTT 设备账号失败，请检查设备管理组件后重试' });
      }
      return true;
    }
    if (writing) { json(res, 409, { error: '正在保存 MQTT 设备账号，请等待完成后重新读取' }); return true; }
    writing = true; let input, video = false;
    try {
      try {
        const body = await readBody(req, bodyTimeoutMs);
        if (videoMutation) { input = validateVideoPatchInput(body, videoMatch[1]); video = true; }
        else input = (creating ? validateCreateInput : validateInput)(body);
      }
      catch (error) { res.setHeader('Connection', 'close'); req.resume(); throw error; }
      // 请求体接收可能耗时，向特权组件派发前再次核验管理员会话。
      if (!active(session) || req.aborted || res.destroyed) throw fault(401, '账户会话已失效，请重新登录');
      if (creating) {
        const current = snapshot(await client('GET', '/devices'));
        if (!current.canCreate) throw fault(503, 'MQTT 管理组件版本较旧，请按 README 重新运行 maintenance/install-mqtt-device-admin.sh 后添加无人船');
        if (!active(session) || req.aborted || res.destroyed) throw fault(401, '账户会话已失效，请重新登录');
      }
      if (video) {
        // 视频账号必须由新版管理组件处理；旧组件不能静默退化为网页本地配置。
        const current = snapshot(await client('GET', '/devices'));
        if (current.canManageVideo !== true) throw fault(503, 'MQTT 管理组件尚未启用视频账号管理，请按 README 运行 maintenance/install-mqtt-device-admin.sh 后重试');
        if (!current.devices.some(device => device.deviceId === input.deviceId)) throw fault(404, '设备不存在，请重新读取');
        if (input.revision !== current.revision) throw fault(409, '配置已变化，请重新读取后再操作');
        if (!active(session) || req.aborted || res.destroyed) throw fault(401, '账户会话已失效，请重新登录');
      }
      const route = video ? '/devices/' + input.deviceId + '/video' : creating ? '/devices' : '/devices/' + match[1];
      const requestBody = video ? (() => { const { deviceId, ...credentials } = input; return credentials; })() : input;
      const result = await client(creating ? 'POST' : 'PUT', route, requestBody);
      delete input.password;
      const data = snapshot(result);
      if (result.ok !== true || typeof result.requiresReconnect !== 'boolean') throw fault(503, '设备管理组件响应异常，修改结果未确认，请重新读取');
      if (!active(session)) throw fault(401, '账户会话已失效；已派发的设备账号修改可能已生效，请重新登录后读取确认');
      json(res, 200, { ok: true, ...data, requiresReconnect: result.requiresReconnect });
    } catch (error) {
      // 只使用本入口/本机客户端产生的固定错误，底层错误详情不暴露。
      json(res, [400, 401, 404, 408, 409, 413, 415, 503, 504].includes(error.status) ? error.status : 503,
        { error: error.status && typeof error.message === 'string' ? error.message : '设备账号保存未确认，请重新读取后再操作' });
    } finally { if (input) delete input.password; writing = false; }
    return true;
  } };
}

module.exports = { createMqttDeviceApi, createMqttDeviceClient, snapshot, validateInput, validateCreateInput, validateVideoInput, SOCKET_PATH };
