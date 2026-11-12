/* 每船通道权限、UDP/SDP恢复、离线状态持久化及WVP切换。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createVideoSourceApi } = require('../server/video-source-api');
const ORIGIN = 'https://sources.test', SDP = 'v=0\r\nm=video 8000 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n';
const env = { BOAT_ACCOUNTS_ENABLED: '1', BOAT_ACCOUNTS_ORIGIN: ORIGIN, BOAT_VIDEO_MEDIA_ENABLED: '1', BOAT_VIDEO_MEDIA_READER_PASSWORD: 'b'.repeat(64),
  BOAT_VIDEO_WVP_ENABLED: '1', BOAT_VIDEO_WVP_USERNAME: 'admin', BOAT_VIDEO_WVP_PASSWORD_MD5: 'c'.repeat(32), BOAT_VIDEO_SOURCE_FILE: '/tmp/wvp-source-test.json' };
function response(status, value) { return { status, body: Buffer.from(value === undefined ? '' : JSON.stringify(value)) }; }
function request(port, route, { method = 'GET', cookie = '', body, origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
    } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const raw = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, data, raw }); }); });
    req.on('error', reject); req.end(data);
  });
}
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-video-source-')), file = path.join(directory, 'video-sources.json');
  const credentials = { admin: { role: 'admin' }, guest: { role: 'guest' } };
  const accounts = { enabled: true, sessionFor(req) { const id = String(req.headers.cookie || '').replace('session=', ''); const value = credentials[id]; return value ? { key: id, value } : null; },
    isActive(session) { return !!session && !!credentials[session.key]; }, sameOrigin(req) { return req.headers.origin === ORIGIN; } };
  const configs = new Map([['boat-01', { source: 'udp+rtp://0.0.0.0:8000', sourceOnDemand: false, rtspTransport: 'automatic', rtpSDP: SDP, record: true, recordPath: '/var/lib/recordings/%path/%f' }]]);
  const paths = new Map([['boat-01', { ready: true, online: true }]]), calls = [], started = [], stopped = [];
  let time = Date.now();
  const transport = async input => {
    calls.push(input); const route = input.path;
    let match = route.match(/^\/v3\/config\/paths\/get\/(.+)$/);
    if (match) return configs.has(match[1]) ? response(200, configs.get(match[1])) : response(404);
    match = route.match(/^\/v3\/config\/paths\/(add|patch)\/(.+)$/);
    if (match) { const prior = configs.get(match[2]) || {}; Object.assign(prior, JSON.parse(input.body.toString())); configs.set(match[2], prior); return response(200, { status: 'ok' }); }
    match = route.match(/^\/v3\/paths\/get\/(.+)$/);
    if (match) return paths.has(match[1]) ? response(200, paths.get(match[1])) : response(404);
    throw Error('unexpected media request ' + route);
  };
  const wvp = options.wvp || { enabled: true, async devices() { return { devices: [{ deviceId: 'camera-01', name: 'Deck Camera', online: true }] }; },
    async channels() { return { channels: [{ channelId: 'channel-01', online: true }] }; },
    async start(deviceId, channelId) { started.push([deviceId, channelId]); if (options.offline) throw Object.assign(Error('offline'), { status: 503, message: 'WVP 点播失败，请检查设备、通道及媒体服务是否在线' }); return { url: 'rtsp://127.0.0.1:10004/rtp/camera-01_channel-01?callId=abc', deviceId, channelId }; },
    async stop(deviceId, channelId) { stopped.push([deviceId, channelId]); }, close() {} };
  const settings = { env: { ...env, ...options.env }, accounts, file, client: async () => ({ devices: [{ deviceId: 'boat-01' }, { deviceId: 'boat-02' }] }), transport, wvp, now: () => time, reconcileMs: 60000 };
  let api = createVideoSourceApi(settings);
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, ORIGIN)).then(handled => { if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = (route, options) => request(server.address().port, route, options);
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get api() { return api; }, call, configs, paths, calls, started, stopped, file, credentials, time: () => time, advance(ms) { time += ms; }, async restart() { await api.close(); api = createVideoSourceApi(settings); } };
}

test('只有管理员可以读取/切换来源，WVP使用同一船路径且切回UDP恢复封装和录像配置', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/video/sources', { cookie: 'session=guest' })).status, 403);
  assert.equal((await f.call('/api/video/sources', { cookie: 'session=admin', origin: 'https://attacker.test' })).status, 403);
  let state = await f.call('/api/video/sources', { cookie: 'session=admin' }); assert.equal(state.data.boats[0].provider, 'direct');
  const selection = { revision: 0, provider: 'wvp', deviceId: 'camera-01', channelId: 'channel-01' };
  const changed = await f.call('/api/video/sources/boats/boat-01', { cookie: 'session=admin', method: 'PUT', body: selection });
  assert.equal(changed.status, 200, changed.raw); assert.equal(changed.data.selected.provider, 'wvp'); assert.equal(changed.data.selected.applied, true);
  assert.equal(f.started.length, 1); assert.equal(f.configs.get('boat-01').source, 'rtsp://127.0.0.1:10004/rtp/camera-01_channel-01?callId=abc');
  assert.equal(f.configs.get('boat-01').rtpSDP, SDP); assert.equal(f.configs.get('boat-01').record, true);
  const restored = await f.call('/api/video/sources/boats/boat-01', { cookie: 'session=admin', method: 'PUT', body: { revision: 1, provider: 'direct' } });
  assert.equal(restored.status, 200, restored.raw); assert.deepEqual(f.stopped, [], '切换只释放本平台拉流，不停止共享WVP点播');
  assert.deepEqual({ source: f.configs.get('boat-01').source, sourceOnDemand: f.configs.get('boat-01').sourceOnDemand, rtspTransport: f.configs.get('boat-01').rtspTransport },
    { source: 'udp+rtp://0.0.0.0:8000', sourceOnDemand: false, rtspTransport: 'automatic' });
  assert.equal(f.configs.get('boat-01').rtpSDP, SDP); assert.equal(f.configs.get('boat-01').recordPath, '/var/lib/recordings/%path/%f');
});

test('离线设备的选择安全持久保存并显示待接收状态，服务重启后继续尝试', async t => {
  const f = await fixture(t, { offline: true });
  const result = await f.call('/api/video/sources/boats/boat-01', { cookie: 'session=admin', method: 'PUT', body: { revision: 0, provider: 'wvp', deviceId: 'camera-01', channelId: 'channel-01' } });
  assert.equal(result.status, 200, result.raw); assert.equal(result.data.selected.applied, false); assert.match(result.data.selected.error, /WVP 点播失败/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).boats['boat-01'].provider, 'wvp');
  assert.equal((await f.call('/api/video/sources', { cookie: 'session=admin' })).data.boats[0].error !== null, true);
});

test('缺少WVP服务器配置时不暴露接口能力，媒体服务保持可用', async t => {
  const f = await fixture(t, { env: { BOAT_VIDEO_WVP_ENABLED: '0' } });
  assert.deepEqual((await f.call('/api/video/sources', { cookie: 'session=admin' })).data, { enabled: false, error: '服务器尚未配置 WVP，请参考 WVP_SETUP.md' });
});

test('重启后恢复所选来源，原UDP备份不被运行时RTSP覆盖，另一艘船独立使用SRT', async t => {
  const f = await fixture(t), cookie = 'session=admin', route = '/api/video/sources/boats/boat-01';
  assert.equal((await f.call(route, { cookie, method: 'PUT', body: { revision: 0, provider: 'wvp', deviceId: 'camera-01', channelId: 'channel-01' } })).status, 200);
  await f.restart(); f.paths.delete('boat-01'); await f.api.prepare('boat-01');
  assert.equal(f.api.source('boat-01').provider, 'wvp'); assert.equal(f.started.length, 2);
  const saved = JSON.parse(fs.readFileSync(f.file)); assert.equal(saved.boats['boat-01'].original.source, 'udp+rtp://0.0.0.0:8000');
  assert.equal((await f.call(route, { cookie, method: 'PUT', body: { revision: 1, provider: 'direct' } })).status, 200);
  assert.equal(f.configs.get('boat-01').source, 'udp+rtp://0.0.0.0:8000'); assert.equal(f.configs.get('boat-01').rtpSDP, SDP);
  assert.equal(f.api.source('boat-02').provider, 'direct'); assert.equal(f.configs.has('boat-02'), false);
});

test('拒绝过期版本、未知设备与通道，公开响应不包含原地址、密钥和点播凭据', async t => {
  const f = await fixture(t), cookie = 'session=admin';
  const input = { revision: 0, provider: 'wvp', deviceId: 'camera-01', channelId: 'channel-01' };
  assert.equal((await f.call('/api/video/sources/boats/unknown', { cookie, method: 'PUT', body: input })).status, 404);
  assert.equal((await f.call('/api/video/sources/boats/boat-01', { cookie, method: 'PUT', body: { ...input, channelId: 'unknown' } })).status, 400);
  const changed = await f.call('/api/video/sources/boats/boat-01', { cookie, method: 'PUT', body: input }); assert.equal(changed.status, 200);
  assert.doesNotMatch(changed.raw, /127\.0\.0\.1|rtsp:|callId|password|original|udp\+rtp|cccc/);
  assert.doesNotMatch(JSON.stringify(f.api.summaries()), /camera-01|channel-01|rtsp:|callId/);
  assert.equal((await f.call('/api/video/sources/boats/boat-01', { cookie, method: 'PUT', body: input })).status, 409);
});
