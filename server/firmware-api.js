/* 管理员同源二进制上传入口；固件只在有界内存中暂存，不把服务器密钥交给浏览器。 */
'use strict';
const protocol = require('./firmware-protocol');
const { FirmwareService, DEVICE } = require('./firmware-service');
const PREFIX = '/api/firmware';
const fault = (status, message) => Object.assign(Error(message), { status });
function readBytes(req, limit, timeoutMs) {
  if (Number(req.headers['content-length']) > limit) return Promise.reject(fault(413, '上传文件超过允许大小'));
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks = [];
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); req.removeListener('data', onData); req.removeListener('end', onEnd);
      req.removeListener('aborted', onError); req.removeListener('error', onError); error ? reject(error) : resolve(value); };
    const onData = chunk => { size += chunk.length; if (size > limit) finish(fault(413, '上传文件超过允许大小')); else chunks.push(chunk); };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = () => finish(fault(400, '固件上传已中断，未开始升级'));
    const timer = setTimeout(() => finish(fault(408, '固件上传超时，未开始升级')), timeoutMs); timer.unref?.();
    req.on('data', onData); req.once('end', onEnd); req.once('aborted', onError); req.once('error', onError);
  });
}
function firmwareName(value) {
  if (typeof value !== 'string' || value.length > 768) throw fault(400, '请提供固件.bin文件名');
  let name; try { name = decodeURIComponent(value); } catch (_) { throw fault(400, '固件文件名编码不正确'); }
  if (name.length < 5 || name.length > 180 || !/\.bin$/i.test(name) || /[\x00-\x1f\x7f/\\]/.test(name) || name.startsWith('.')) throw fault(400, '请选择普通.bin固件文件，不要包含目录或控制字符');
  return name;
}
function createFirmwareApi({ env = process.env, accounts, bridge, service, uploadTimeoutMs = 20000, maxUploads = 2, serviceOptions = {} } = {}) {
  const key = protocol.keyFrom(env.BOAT_OTA_KEY);
  const manager = service || new FirmwareService({ bridge, key, ...serviceOptions });
  let closed = false; const uploads = new Set();
  const enabled = () => !closed && accounts?.enabled === true && bridge?.enabled === true && !!key;
  const reason = () => accounts?.enabled !== true ? '固件升级需要启用平台管理员账户' : bridge?.enabled !== true ? '服务器尚未启用MQTT云端连接' : !key ? '服务器尚未配置OTA密钥；首次使用前需安装Bootloader和OTA应用' : closed ? '固件升级服务已停止' : null;
  const usable = () => { if (!enabled()) throw fault(503, reason()); };
  const authorize = (owner, req, res) => {
    if (closed || !accounts.isActive(owner) || req.aborted || res.destroyed) throw fault(401, '登录会话或上传连接已失效，请重新登录');
    if (owner.value.role !== 'admin') throw fault(403, '仅管理员可以升级单片机固件');
  };
  const json = (res, status, value) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  return {
    manager,
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PREFIX + '/')) return false;
      try {
        if (!accounts?.enabled || closed) throw fault(503, reason());
        const owner = accounts.sessionFor(req); if (!owner) throw fault(401, '请先登录平台管理员账户'); authorize(owner, req, res);
        const read = req.method === 'GET';
        const browserRead = read && !req.headers.origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
        if (!browserRead && !accounts.sameOrigin(req)) throw fault(403, '请从本站发起固件升级请求');
        if (url.search) throw fault(400, '固件接口不接受查询参数');
        if (url.pathname === PREFIX + '/config') {
          if (!read) throw fault(405, '固件配置只支持GET');
          json(res, 200, { enabled: enabled(), reason: reason(), maxSize: protocol.MAX_SIZE, chunkSize: protocol.CHUNK_SIZE,
            boardId: protocol.BOARD_ID, applicationAddress: protocol.APPLICATION_ADDRESS, forceSupported: true }); return true;
        }
        const match = /^\/api\/firmware\/boats\/([A-Za-z0-9_-]{1,64})(?:\/(cancel))?$/.exec(url.pathname);
        if (!match || !DEVICE.test(match[1])) throw fault(404, '固件接口不存在');
        const id = match[1];
        if (!bridge.get?.(id) && !manager.caps.has(id) && !manager.jobs.has(id)) throw fault(404, '尚未收到这艘船的数据');
        if (read && !match[2]) { json(res, 200, manager.snapshot(id)); return true; }
        if (req.method !== 'POST') throw fault(405, '固件接口不支持此方法');
        usable();
        if (match[2]) {
          if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw fault(415, '取消升级请使用JSON请求');
          const bytes = await readBytes(req, 128, uploadTimeoutMs); let body;
          try { body = JSON.parse(bytes.toString('utf8')); } catch (_) { throw fault(400, '取消升级只接受空JSON对象'); }
          if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) throw fault(400, '取消升级只接受空JSON对象');
          authorize(owner, req, res); json(res, 200, manager.cancel(id)); return true;
        }
        if (uploads.has(id)) throw fault(409, '这艘船正在上传固件');
        if (uploads.size >= maxUploads) throw fault(429, '同时上传的固件过多，请稍后再试');
        if (!/^application\/octet-stream(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw fault(415, '请以二进制格式上传.bin固件');
        const name = firmwareName(req.headers['x-firmware-name']);
        const forceHeader = req.headers['x-firmware-force'];
        if (forceHeader !== undefined && forceHeader !== '1') throw fault(400, '强制升级须明确使用X-Firmware-Force: 1');
        const force = forceHeader === '1';
        if (manager.isActive(id)) throw fault(409, '该船已有固件升级任务');
        uploads.add(id);
        try {
          const image = await readBytes(req, protocol.MAX_SIZE, uploadTimeoutMs);
          try { authorize(owner, req, res); usable(); json(res, 202, manager.start(id, name, image, { force })); }
          finally { image.fill(0); }
        } finally { uploads.delete(id); }
      } catch (error) { req.resume(); if (!res.headersSent) json(res, error.status || 503, { error: error.status ? error.message : '固件升级服务不可用，请检查服务器和设备状态' }); else res.destroy(); }
      return true;
    },
    close() { if (closed) return; closed = true; manager.close(); uploads.clear(); if (key) key.fill(0); }
  };
}
module.exports = { createFirmwareApi, firmwareName, readBytes, PREFIX };
