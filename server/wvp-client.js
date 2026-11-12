/* WVP 只由服务器访问：缓存登录令牌、分页读取国标设备、点播后交给本机 ZLM。 */
'use strict';
const http = require('node:http'), crypto = require('node:crypto');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const fault = (status, message) => Object.assign(Error(message), { status });
const port = (value, fallback) => {
  const n = Number(value || fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw Error('Invalid WVP/ZLM port');
  return n;
};
function readWvpConfig(env = process.env) {
  if (env.BOAT_VIDEO_WVP_ENABLED !== '1' || env.BOAT_VIDEO_MEDIA_ENABLED !== '1') return { enabled: false };
  const username = env.BOAT_VIDEO_WVP_USERNAME;
  const passwordMd5 = env.BOAT_VIDEO_WVP_PASSWORD_MD5 || (env.BOAT_VIDEO_WVP_PASSWORD ? crypto.createHash('md5').update(env.BOAT_VIDEO_WVP_PASSWORD).digest('hex') : '');
  if (!ID.test(username || '') || !/^[a-f0-9]{32}$/i.test(passwordMd5)) throw Error('WVP requires private login credentials');
  return { enabled: true, username, passwordMd5, port: port(env.BOAT_VIDEO_WVP_PORT, 18978),
    zlmPort: port(env.BOAT_VIDEO_ZLM_HTTP_PORT, 10080), rtspPort: port(env.BOAT_VIDEO_ZLM_RTSP_PORT, 10004),
    zlmSecret: env.BOAT_VIDEO_ZLM_SECRET || '' };
}
function createWvpTransport({ timeoutMs = 22000 } = {}) {
  return ({ port, path, headers = {}, method = 'GET', body, format = 'json', timeoutMs: deadlineMs = timeoutMs }) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    // 固定回环地址；不接受前端 URL，不跟随重定向，也不在错误中带出鉴权参数。
    const req = http.request({ host: '127.0.0.1', port, path, headers, method, agent: false }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { finish(fault(502, 'WVP 响应过大')); res.destroy(); } else chunks.push(chunk); });
      res.once('error', () => finish(fault(503, 'WVP 连接中断')));
      res.once('end', () => {
        const buffer = Buffer.concat(chunks);
        if (format === 'raw') { finish(null, { status: res.statusCode, headers: res.headers, body: buffer }); return; }
        let data; try { data = buffer.length ? JSON.parse(buffer.toString('utf8')) : { code: 0, data: null }; } catch (_) { finish(fault(502, 'WVP 响应格式不正确')); return; }
        finish(null, { status: res.statusCode, data, headers: res.headers });
      });
    });
    const timer = setTimeout(() => { finish(fault(504, 'WVP 点播或连接超时，请检查摄像头在线状态')); req.destroy(); }, deadlineMs); timer.unref?.();
    req.once('error', () => finish(fault(503, '无法连接 WVP / ZLMediaKit，请检查服务器视频服务')));
    req.end(body);
  });
}
function localRtsp(info, config) {
  if (!info || !ID.test(info.app || '') || !ID.test(info.stream || '')) throw fault(502, 'WVP 返回了无效的媒体流');
  const raw = typeof info.rtsp === 'string' ? info.rtsp : info.rtsp?.url;
  let params = '';
  if (raw) {
    let url; try { url = new URL(raw); } catch (_) { throw fault(502, 'WVP 返回了无效的 RTSP 地址'); }
    // 只使用已校验的 app/stream 和 callId/token，主机及端口永远来自服务器配置。
    if (url.protocol !== 'rtsp:' || url.username || url.password || url.hash || url.pathname !== '/' + info.app + '/' + info.stream || url.search.length > 1024) throw fault(502, 'WVP 返回了无效的 RTSP 路径');
    const query = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (!['callId', 'originTypeStr', 'videoCodec', 'audioCodec', 'token'].includes(key) || !/^[A-Za-z0-9_.@:-]{1,512}$/.test(value) || query.has(key)) throw fault(502, 'WVP 返回了无效的播放凭据');
      query.set(key, value);
    }
    if (query.size) params = '?' + query;
  }
  return 'rtsp://127.0.0.1:' + config.rtspPort + '/' + info.app + '/' + info.stream + params;
}
function createWvpClient({ env = process.env, config = readWvpConfig(env), transport = createWvpTransport() } = {}) {
  let token = '', loginPending = null, closed = false, pushKey = '', pushKeyAt = 0;
  const assertOpen = () => { if (closed || !config.enabled) throw fault(503, '服务器尚未启用 WVP 图传接入'); };
  async function login() {
    assertOpen();
    if (!loginPending) {
      const task = (async () => {
        const query = new URLSearchParams({ username: config.username, password: config.passwordMd5 });
        const response = await transport({ port: config.port, path: '/api/user/login?' + query });
        const next = response.data?.data?.accessToken;
        if (response.status !== 200 || response.data?.code !== 0 || typeof next !== 'string' || !/^[A-Za-z0-9_.-]{16,8192}$/.test(next)) throw fault(503, 'WVP 登录失败，请检查服务器的 WVP 账号配置');
        assertOpen(); token = next; return next;
      })();
      loginPending = task; task.finally(() => { if (loginPending === task) loginPending = null; }).catch(() => {});
    }
    return loginPending;
  }
  async function request(path, retry = true, options = {}) {
    assertOpen(); const used = token || await login();
    const { beforeSend, ...transportOptions } = options;
    if (beforeSend && !beforeSend()) throw fault(409, '云台操作已结束，请重新按住方向键');
    const response = await transport({ ...transportOptions, port: config.port, path, headers: { 'access-token': used, Accept: 'application/json' } });
    assertOpen();
    if (retry && ([401, 403].includes(response.status) || [401, 403].includes(response.data?.code))) {
      if (token === used) token = '';
      return request(path, false, options);
    }
    return response;
  }
  async function api(path, options = {}, failure) {
    const response = await request(path, true, options);
    if (response.status !== 200 || response.data?.code !== 0) throw fault(503, failure || (path.startsWith('/api/play/') ? 'WVP 点播失败，请检查设备、通道及媒体服务是否在线' : 'WVP 设备读取失败，请检查登录和服务状态'));
    return response.data.data;
  }
  const pair = (deviceId, channelId) => {
    if (!ID.test(deviceId || '') || !ID.test(channelId || '')) throw fault(400, 'WVP 设备或通道编号无效');
    return deviceId + '/' + channelId;
  };
  // WVP 返回的播放地址仅用于提取经过校验的流编号及凭据，不转发其中的服务器地址。
  function audioTarget(info, kind) {
    if (!info || !ID.test(info.app || '') || !ID.test(info.stream || '')) throw fault(502, 'WVP 返回了无效的语音流');
    const query = new URLSearchParams({ app: info.app, stream: info.stream });
    const raw = info.rtc?.url || info.rtc || info.rtcs?.url || info.rtcs;
    if (raw) {
      let url; try { url = new URL(raw); } catch (_) { throw fault(502, 'WVP 语音地址格式无效'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search.length > 2048 || !['/index/api/webrtc', '/index/api/whip', '/index/api/whep'].includes(url.pathname)) throw fault(502, 'WVP 语音地址无效');
      const seen = new Set();
      for (const [key, value] of url.searchParams) {
        if (seen.has(key) || !/^[A-Za-z0-9_.@:-]{1,512}$/.test(value)) throw fault(502, 'WVP 语音参数无效'); seen.add(key);
        if (key === 'app' || key === 'stream') { if (value !== info[key]) throw fault(502, 'WVP 语音流不匹配'); }
        else if (key === 'type') { if (value !== kind) throw fault(502, 'WVP 语音方向不匹配'); }
        else if (['vhost', 'callId', 'originTypeStr', 'audioCodec', 'videoCodec', 'token'].includes(key)) query.set(key, value);
        else throw fault(502, 'WVP 语音参数无效');
      }
    }
    return { app: info.app, stream: info.stream, query: query.toString() };
  }
  async function pages(path) {
    const all = []; let total = Infinity;
    for (let page = 1; page <= 10 && all.length < total; page++) {
      const data = await api(path + '?page=' + page + '&count=100');
      if (!data || !Array.isArray(data.list) || !Number.isSafeInteger(data.total) || data.total < 0) throw fault(502, 'WVP 设备列表格式不正确');
      total = data.total; all.push(...data.list); if (data.list.length < 100) break;
    }
    return { items: all.slice(0, 1000), truncated: total > all.length };
  }
  const label = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : '';
  const online = value => value === true || value === 1 || value === 'ON' || value === 'online';
  return { enabled: config.enabled,
    async devices() {
      const data = await pages('/api/device/query/devices');
      // WVP 3.x 使用 onLine；兼容 online 字段，用 ?? 保留明确的 false / 0 离线状态。
      return { devices: data.items.filter(item => ID.test(item.deviceId || '')).map(item => ({ deviceId: item.deviceId, name: label(item.name || item.deviceName) || item.deviceId, online: online(item.online ?? item.onLine), channelCount: Number.isSafeInteger(item.channelCount) ? item.channelCount : null })), truncated: data.truncated };
    },
    async channels(deviceId) {
      if (!ID.test(deviceId || '')) throw fault(400, 'WVP 设备编号无效');
      const data = await pages('/api/device/query/devices/' + deviceId + '/channels');
      return { channels: data.items.filter(item => ID.test(item.deviceId || item.channelId || '')).map(item => ({ channelId: item.deviceId || item.channelId, name: label(item.name) || item.deviceId || item.channelId, online: online(item.status ?? item.online ?? item.onLine) })), truncated: data.truncated };
    },
    async start(deviceId, channelId) {
      if (!ID.test(deviceId || '') || !ID.test(channelId || '')) throw fault(400, 'WVP 设备或通道编号无效');
      return { url: localRtsp(await api('/api/play/start/' + deviceId + '/' + channelId), config), deviceId, channelId };
    },
    async ptz(deviceId, channelId, command, speed = 100, zoomSpeed = 4, { beforeSend } = {}) {
      const target = pair(deviceId, channelId);
      if (!['left', 'right', 'up', 'down', 'upleft', 'upright', 'downleft', 'downright', 'zoomin', 'zoomout', 'stop'].includes(command) || !Number.isInteger(speed) || speed < 1 || speed > 255 || !Number.isInteger(zoomSpeed) || zoomSpeed < 1 || zoomSpeed > 15) throw fault(400, '云台指令或速度无效');
      const query = new URLSearchParams({ command, horizonSpeed: command === 'stop' ? 0 : speed, verticalSpeed: command === 'stop' ? 0 : speed, zoomSpeed: command === 'stop' ? 0 : zoomSpeed });
      await api('/api/front-end/ptz/' + target + '?' + query, { timeoutMs: 3000, beforeSend }, 'WVP 云台指令发送失败，请检查摄像头在线状态和云台能力');
    },
    async voiceAvailable() {
      assertOpen(); if (!config.zlmSecret) return false;
      const response = await transport({ port: config.zlmPort, path: '/index/api/getApiList?' + new URLSearchParams({ secret: config.zlmSecret }), timeoutMs: 5000 });
      return response.status === 200 && response.data?.code === 0 && ['/index/api/whip', '/index/api/whep', '/index/api/delete_webrtc'].every(route => response.data.data?.includes(route));
    },
    async talkStart(deviceId, channelId, mode) {
      if (!['talk', 'broadcast'].includes(mode)) throw fault(400, '语音模式无效');
      const data = await api('/api/play/broadcast/' + pair(deviceId, channelId) + '?broadcastMode=' + (mode === 'broadcast'), {}, 'WVP 无法创建语音通道，请检查摄像头语音能力');
      // 此 WVP 的双向对讲只在多端口 RTP 模式发送 SIP 请求，先检查实际运行节点，避免麦克风已连接却一直等回传。
      const mediaId = data?.streamInfo?.mediaServerId;
      if (mode === 'talk' && mediaId !== undefined) {
        if (!ID.test(mediaId || '')) throw fault(502, 'WVP 返回了无效的语音媒体节点');
        const media = await api('/api/server/media_server/one/' + mediaId, { timeoutMs: 3000 }, '无法读取 WVP 语音媒体节点配置');
        if (media?.rtpEnable !== true) throw fault(503, 'WVP 双向对讲需要启用媒体节点的多端口 RTP；请由管理员同时更新节点与重启配置，或尝试单向喊话');
      }
      const push = audioTarget(data?.streamInfo, 'push'), play = mode === 'talk' ? audioTarget(data?.playStreamInfo, 'play') : null;
      return { push, play };
    },
    async talkStop(deviceId, channelId) {
      await api('/api/play/broadcast/stop/' + pair(deviceId, channelId), { timeoutMs: 3000 }, 'WVP 语音通道释放失败');
    },
    async openAudio(target, kind, offer) {
      assertOpen();
      if (!['push', 'play'].includes(kind) || !target || !ID.test(target.app || '') || !ID.test(target.stream || '') || typeof offer !== 'string' || Buffer.byteLength(offer) > 65536) throw fault(400, '语音协商参数无效');
      const query = new URLSearchParams(target.query);
      if (query.get('app') !== target.app || query.get('stream') !== target.stream) throw fault(400, '语音流不匹配');
      if (kind === 'push') {
        if (!pushKey || Date.now() - pushKeyAt > 60000) {
          const user = await api('/api/user/userInfo', { method: 'POST' }, 'WVP 语音发布鉴权失败');
          if (typeof user?.pushKey !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(user.pushKey)) throw fault(503, 'WVP 尚未配置语音发布凭据');
          pushKey = user.pushKey; pushKeyAt = Date.now();
        }
        query.set('sign', pushKey);
      }
      const response = await transport({ port: config.zlmPort, path: '/index/api/' + (kind === 'push' ? 'whip' : 'whep') + '?' + query,
        method: 'POST', body: Buffer.from(offer), format: 'raw', headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' }, timeoutMs: 12000 });
      if (response.status !== 201) { pushKey = ''; throw fault(response.status === 404 ? 404 : 503, kind === 'play' ? '摄像头语音回传尚未就绪，请检查对讲能力或改用单向喊话' : '语音发布失败，请检查 ZLMediaKit WebRTC 和 WVP 推流鉴权'); }
      const origin = 'http://127.0.0.1:' + config.zlmPort;
      let resource; try { resource = new URL(response.headers?.location, origin); } catch (_) { throw fault(502, '语音服务返回无效会话'); }
      if (resource.origin !== origin || resource.pathname !== '/index/api/delete_webrtc' || resource.username || resource.password || resource.hash || resource.search.length > 1024 || [...resource.searchParams.keys()].sort().join(',') !== 'id,token' || ![...resource.searchParams.values()].every(value => /^[A-Za-z0-9_.+:/=-]{1,256}$/.test(value))) throw fault(502, '语音服务返回无效会话');
      const session = { resource: resource.pathname + resource.search, sdp: response.body?.toString('utf8') };
      if (!session.sdp?.startsWith('v=0') || session.sdp.length > 65536) {
        await transport({ port: config.zlmPort, path: session.resource, method: 'DELETE', format: 'raw', timeoutMs: 3000 }).catch(() => {});
        throw fault(502, '语音服务返回无效 SDP');
      }
      return session;
    },
    async closeAudio(resource) {
      if (typeof resource !== 'string' || !resource.startsWith('/index/api/delete_webrtc?') || resource.length > 1100) throw fault(400, '语音会话无效');
      const response = await transport({ port: config.zlmPort, path: resource, method: 'DELETE', format: 'raw', timeoutMs: 3000 });
      if (![200, 204, 404].includes(response.status)) throw fault(503, '语音媒体会话释放失败');
    },
    async media() {
      assertOpen();
      if (!config.zlmSecret) return { configured: false, streams: 0 };
      const response = await transport({ port: config.zlmPort, path: '/index/api/getMediaList?' + new URLSearchParams({ secret: config.zlmSecret }) });
      if (response.status !== 200 || response.data?.code !== 0) throw fault(503, 'ZLMediaKit 状态读取失败，请检查服务器密钥配置');
      return { configured: true, streams: (response.data.data || response.data.streams || []).length };
    },
    close() { closed = true; token = ''; pushKey = ''; }
  };
}
module.exports = { createWvpClient, createWvpTransport, readWvpConfig, localRtsp, ID };
