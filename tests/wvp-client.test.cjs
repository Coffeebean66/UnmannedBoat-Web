/* WVP 鉴权、设备分页、RTSP 主机隔离及点播。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { readWvpConfig, createWvpClient, createWvpTransport, localRtsp } = require('../server/wvp-client');
const env = { BOAT_VIDEO_WVP_ENABLED: '1', BOAT_VIDEO_WVP_USERNAME: 'admin', BOAT_VIDEO_WVP_PASSWORD: 'wvp-client-unit-test',
  BOAT_VIDEO_MEDIA_ENABLED: '1', BOAT_VIDEO_ZLM_RTSP_PORT: '10004', BOAT_VIDEO_WVP_PORT: '18978' };

test('配置要求已有媒体服务与服务器端凭据，并且密码不会成为公开字段', () => {
  assert.deepEqual(readWvpConfig({}), { enabled: false });
  assert.deepEqual(readWvpConfig({ ...env, BOAT_VIDEO_MEDIA_ENABLED: '0' }), { enabled: false });
  for (const changes of [{ BOAT_VIDEO_WVP_PASSWORD: '', BOAT_VIDEO_WVP_PASSWORD_MD5: '' }, { BOAT_VIDEO_WVP_PORT: '99999' }]) assert.throws(() => readWvpConfig({ ...env, ...changes }));
  const config = readWvpConfig(env); assert.equal(config.passwordMd5, crypto.createHash('md5').update(env.BOAT_VIDEO_WVP_PASSWORD).digest('hex'));
  assert.equal(Object.hasOwn(config, 'password'), false); assert.equal(config.rtspPort, 10004);
});

test('登录后分页读取设备与通道，RTSP 始终拉取本机ZLM地址并保留WVP流校验参数', async () => {
  const calls = [], hash = crypto.createHash('md5').update(env.BOAT_VIDEO_WVP_PASSWORD).digest('hex');
  const client = createWvpClient({ env, transport: async request => {
    calls.push(request);
    if (request.path.startsWith('/api/user/login?')) return { status: 200, data: { code: 0, data: { accessToken: 'unit.jwt.token.value' } } };
    assert.equal(request.headers['access-token'], 'unit.jwt.token.value');
    if (request.path.startsWith('/api/device/query/devices?')) {
      const page = new URL('http://wvp' + request.path).searchParams.get('page');
      return { status: 200, data: { code: 0, data: { total: 1, list: page === '1' ? [{ deviceId: 'camera-01', name: '测试摄像机', onLine: true }] : [] } } };
    }
    if (request.path.startsWith('/api/device/query/devices/camera-01/channels?')) return { status: 200, data: { code: 0, data: { total: 1, list: [{ deviceId: 'channel-01', name: '船载摄像头', status: 'ON' }] } } };
    if (request.path === '/api/play/start/camera-01/channel-01') return { status: 200, data: { code: 0, data: { app: 'rtp', stream: 'camera-01_channel-01', rtsp: { url: 'rtsp://public.example:10004/rtp/camera-01_channel-01?callId=abc-123&originTypeStr=gb28181&videoCodec=H264' } } } };
    throw Error('unexpected WVP route');
  } });
  const devices = await client.devices(); assert.equal(devices.devices[0].name, '测试摄像机'); assert.equal(devices.devices[0].online, true);
  const channels = await client.channels('camera-01'); assert.equal(channels.channels[0].online, true);
  const started = await client.start('camera-01', 'channel-01');
  assert.equal(started.url, 'rtsp://127.0.0.1:10004/rtp/camera-01_channel-01?callId=abc-123&originTypeStr=gb28181&videoCodec=H264');
  assert.equal(new URL(calls[0].path, 'http://wvp').searchParams.get('password'), hash);
  assert.equal(calls.filter(call => call.path.startsWith('/api/user/login?')).length, 1);
  assert.ok(!calls.some(call => call.path.startsWith('/api/play/stop/')), '不关闭其他WVP用户可能正在观看的摄像头');
  client.close();
});

test('兼容 WVP 的 onLine 与 online 字段，明确的离线状态不会被备用字段覆盖', async () => {
  const devices = [
    { deviceId: 'wvp-online', onLine: true },
    { deviceId: 'wvp-offline', onLine: false },
    { deviceId: 'legacy-online', online: 1 },
    { deviceId: 'legacy-offline', online: 0, onLine: true },
    { deviceId: 'explicit-offline', online: false, onLine: true },
    { deviceId: 'null-fallback', online: null, onLine: true },
    { deviceId: 'unknown' }
  ];
  const channels = [
    { deviceId: 'channel-online', status: 'ON' },
    { deviceId: 'channel-offline', status: 'OFF', online: true, onLine: true },
    { channelId: 'channel-fallback', onLine: true },
    { channelId: 'channel-false', online: false, onLine: true },
    { channelId: 'channel-zero', status: 0, online: true }
  ];
  const client = createWvpClient({ env, transport: async request => {
    if (request.path.startsWith('/api/user/login?')) return { status: 200, data: { code: 0, data: { accessToken: 'unit.jwt.token.value' } } };
    const list = request.path.includes('/channels?') ? channels : devices;
    return { status: 200, data: { code: 0, data: { total: list.length, list } } };
  } });
  try {
    assert.deepEqual((await client.devices()).devices.map(item => [item.deviceId, item.online]), [
      ['wvp-online', true], ['wvp-offline', false], ['legacy-online', true], ['legacy-offline', false],
      ['explicit-offline', false], ['null-fallback', true], ['unknown', false]
    ]);
    assert.deepEqual((await client.channels('wvp-online')).channels.map(item => [item.channelId, item.online]), [
      ['channel-online', true], ['channel-offline', false], ['channel-fallback', true], ['channel-false', false], ['channel-zero', false]
    ]);
  } finally { client.close(); }
});

test('无效媒体路径、外部地址携带凭据及未知RTSP查询参数一律拒绝', () => {
  const config = { rtspPort: 10004 };
  for (const info of [null, { app: 'bad/app', stream: 'ok' }, { app: 'rtp', stream: 's', rtsp: 'rtsp://user:pass@camera.example/rtp/s' },
    { app: 'rtp', stream: 's', rtsp: 'http://camera.example/rtp/s' }, { app: 'rtp', stream: 's', rtsp: 'rtsp://camera.example/other/s' },
    { app: 'rtp', stream: 's', rtsp: 'rtsp://camera.example/rtp/s?secret=private' }]) assert.throws(() => localRtsp(info, config));
});

test('会话凭据过期时只重新登录一次，随后不再无限重试', async () => {
  let logins = 0, protectedCalls = 0;
  const client = createWvpClient({ env, transport: async call => {
    if (call.path.startsWith('/api/user/login?')) return { status: 200, data: { code: 0, data: { accessToken: 'unit.jwt.token.' + ++logins } } };
    protectedCalls++; if (protectedCalls === 1) return { status: 401, data: { code: 401, msg: 'expired' } };
    return { status: 200, data: { code: 0, data: { total: 0, list: [] } } };
  } });
  assert.equal((await client.devices()).devices.length, 0); assert.equal(logins, 2); assert.equal(protectedCalls, 2); client.close();
});

test('WVP 登录等待期间已松键的云台移动不再发送', async () => {
  let release, held = true; const calls = [];
  const client = createWvpClient({ env, transport: async call => {
    if (call.path.startsWith('/api/user/login?')) { await new Promise(resolve => { release = resolve; }); return { status: 200, data: { code: 0, data: { accessToken: 'unit.jwt.token.value' } } }; }
    calls.push(call); return { status: 200, data: { code: 0 } };
  } });
  const moving = client.ptz('camera-01', 'channel-01', 'left', 100, 4, { beforeSend: () => held });
  held = false; release(); await assert.rejects(moving, error => error.status === 409);
  assert.equal(calls.length, 0); await client.ptz('camera-01', 'channel-01', 'stop'); assert.equal(calls.length, 1); client.close();
});

test('国标云台使用实际 front-end/ptz 接口，停止时所有速度为零并拒绝未知指令', async () => {
  const calls = [];
  const client = createWvpClient({ env, transport: async call => {
    if (call.path.startsWith('/api/user/login?')) return { status: 200, data: { code: 0, data: { accessToken: 'unit.jwt.token.value' } } };
    calls.push(call); return { status: 200, data: { code: 0, data: null } };
  } });
  await client.ptz('camera-01', 'channel-01', 'upleft', 130, 6);
  const moved = new URL(calls[0].path, 'http://wvp'); assert.equal(moved.pathname, '/api/front-end/ptz/camera-01/channel-01'); assert.equal(moved.searchParams.get('horizonSpeed'), '130');
  await client.ptz('camera-01', 'channel-01', 'stop'); const stopped = new URL(calls[1].path, 'http://wvp');
  for (const key of ['horizonSpeed', 'verticalSpeed', 'zoomSpeed']) assert.equal(stopped.searchParams.get(key), '0');
  await assert.rejects(client.ptz('camera-01', 'channel-01', 'invalid')); assert.equal(calls.length, 2); client.close();
});

test('语音由本机 WHIP / WHEP 协商，WVP 推流密钥留在服务器，删除会话使用私有凭据', async () => {
  const calls = [], password = 'unit-private-push-key', resources = [], rtcEnv = { ...env, BOAT_VIDEO_ZLM_SECRET: 'unit-private-zlm-key' };
  const info = (stream, type) => ({ app: 'talk', stream, rtc: 'https://external.example:443/index/api/webrtc?app=talk&stream=' + stream + '&type=' + type });
  const client = createWvpClient({ env: rtcEnv, transport: async call => {
    calls.push(call);
    if (call.path.startsWith('/api/user/login?')) return { status: 200, data: { code: 0, data: { accessToken: 'unit.jwt.token.value' } } };
    if (call.path.startsWith('/index/api/getApiList?')) return { status: 200, data: { code: 0, data: ['/index/api/whip', '/index/api/whep', '/index/api/delete_webrtc'] } };
    if (call.path.startsWith('/api/play/broadcast/camera-01/')) return { status: 200, data: { code: 0, data: { streamInfo: info('camera-channel', 'push'), playStreamInfo: info('camera-channel_talk', 'play') } } };
    if (call.path === '/api/user/userInfo') { assert.equal(call.method, 'POST'); return { status: 200, data: { code: 0, data: { pushKey: password } } }; }
    if (/^\/index\/api\/(whip|whep)\?/.test(call.path)) { assert.equal(call.port, 10080); assert.equal(call.method, 'POST'); assert.equal(call.format, 'raw'); const id = 'rtc-' + resources.length; resources.push(id); return { status: 201, headers: { location: 'http://127.0.0.1:10080/index/api/delete_webrtc?id=' + id + '&token=private-session-token' }, body: Buffer.from('v=0\r\nm=audio 9 RTP/AVP 8\r\n') }; }
    if (call.path.startsWith('/index/api/delete_webrtc?')) return { status: 200, body: Buffer.alloc(0) };
    if (call.path.startsWith('/api/play/broadcast/stop/')) return { status: 200, data: { code: 0 } };
    throw Error('unexpected route');
  } });
  assert.equal(await client.voiceAvailable(), true);
  const target = await client.talkStart('camera-01', 'channel-01', 'talk');
  for (const kind of ['push', 'play']) { const session = await client.openAudio(target[kind], kind, 'v=0\r\n'); await client.closeAudio(session.resource); }
  const publish = calls.find(call => call.path.startsWith('/index/api/whip?')), play = calls.find(call => call.path.startsWith('/index/api/whep?'));
  assert.equal(new URL(publish.path, 'http://zlm').searchParams.get('sign'), password);
  assert.equal(new URL(play.path, 'http://zlm').searchParams.has('sign'), false);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 2); await client.talkStop('camera-01', 'channel-01'); client.close();
});

test('双向对讲先检查实际媒体节点的多端口 RTP，单端口不进入麦克风推流，喊话仍独立', async () => {
  for (const enabled of [false, true]) {
    const calls = [];
    const info = stream => ({ app: 'talk', stream, mediaServerId: 'media-01' });
    const client = createWvpClient({ env, transport: async call => {
      calls.push(call.path);
      if (call.path.startsWith('/api/user/login?')) return { status: 200, data: { code: 0, data: { accessToken: 'unit.jwt.token.value' } } };
      if (call.path === '/api/server/media_server/one/media-01') return { status: 200, data: { code: 0, data: { id: 'media-01', rtpEnable: enabled } } };
      if (call.path.startsWith('/api/play/broadcast/camera-01/')) return { status: 200, data: { code: 0, data: { streamInfo: info('camera-channel'), playStreamInfo: info('camera-channel_talk') } } };
      throw Error('unexpected route');
    } });
    if (enabled) assert.equal((await client.talkStart('camera-01', 'channel-01', 'talk')).play.stream, 'camera-channel_talk');
    else await assert.rejects(client.talkStart('camera-01', 'channel-01', 'talk'), error => error.status === 503 && /多端口 RTP/.test(error.message));
    assert.ok(calls.includes('/api/server/media_server/one/media-01'));
    const checks = calls.length; assert.equal((await client.talkStart('camera-01', 'channel-01', 'broadcast')).play, null);
    assert.equal(calls.length, checks + 1); assert.equal(calls.some(path => path.includes('/index/api/whip')), false); client.close();
  }
});

test('语音地址不允许外部凭据、任意路由、重复参数和设备流不匹配', async () => {
  for (const rtc of ['https://user:pass@external/index/api/webrtc?app=talk&stream=s&type=push', 'https://external/other?app=talk&stream=s', 'https://external/index/api/webrtc?app=talk&app=talk&stream=s', 'https://external/index/api/webrtc?app=talk&stream=other']) {
    const client = createWvpClient({ env, transport: async call => call.path.startsWith('/api/user/login?') ? { status: 200, data: { code: 0, data: { accessToken: 'unit.jwt.token.value' } } } : { status: 200, data: { code: 0, data: { streamInfo: { app: 'talk', stream: 's', rtc } } } } });
    await assert.rejects(client.talkStart('camera-01', 'channel-01', 'broadcast')); client.close();
  }
});

test('本机传输支持 SDP POST 和私有 DELETE，空的云台响应仍可解析', async t => {
  const http = require('node:http'), calls = [];
  const server = http.createServer((req, res) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { calls.push({ method: req.method, body }); if (req.method === 'POST') { res.writeHead(201, { Location: '/index/api/delete_webrtc?id=x&token=y' }); res.end('v=0\r\n'); } else { res.writeHead(200); res.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = createWvpTransport(), port = server.address().port;
  const response = await transport({ port, path: '/index/api/whip', method: 'POST', format: 'raw', body: Buffer.from('v=0\r\n') });
  assert.equal(response.status, 201); assert.equal(response.body.toString(), 'v=0\r\n'); assert.ok(response.headers.location);
  assert.equal((await transport({ port, path: '/ptz' })).data.code, 0); assert.equal(calls[0].body, 'v=0\r\n');
});
