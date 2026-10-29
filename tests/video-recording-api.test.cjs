/* 录像权限、意图持久化、目录切换和真正的流式代理；不连接生产媒体服务器。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAccountApi } = require('../server/account-api');
const { createVideoRecordingApi, normalizeDirectory, resolveRecordingConfigFile, PREFIX } = require('../server/video-recording-api');
const ORIGIN = 'https://recording.test', ROOT = '/var/lib/unmanned-boat-video';
const ENV = { BOAT_ACCOUNTS_ENABLED: '1', BOAT_ACCOUNTS_ORIGIN: ORIGIN,
  BOAT_ADMIN_USERNAME: 'admin', BOAT_ADMIN_PASSWORD: 'record-admin-test', BOAT_GUEST_USERNAME: 'guest', BOAT_GUEST_PASSWORD: 'record-guest-test',
  BOAT_VIDEO_MEDIA_ENABLED: '1', BOAT_VIDEO_RECORDING_ENABLED: '1', BOAT_VIDEO_MEDIA_READER_PASSWORD: 'a'.repeat(64) };
const MP4 = Buffer.from('test-video-stream-with-bounded-memory');
function request(port, route, { method = 'GET', body, raw, cookie, origin = ORIGIN, headers = {} } = {}) {
  const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, agent: false, headers: {
      ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
      ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...headers
    } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
      const buffer = Buffer.concat(chunks), raw = buffer.toString(); let data; try { data = JSON.parse(raw); } catch (_) {}
      resolve({ status: res.statusCode, raw, buffer, data, headers: res.headers });
    }); }); req.once('error', reject); req.end(data);
  });
}
async function fixture(t, options = {}) {
  const directory = options.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'boat-recording-api-'));
  if (!options.directory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configs = new Map(), recordings = new Map(), ready = new Set(), sources = new Map(), calls = [], playbackCalls = [];
  let unavailable = false, deleteStatus = 200;
  const response = (status, body = {}) => ({ status, body: Buffer.from(JSON.stringify(body)) });
  const transport = async input => {
    calls.push({ method: input.method, path: input.path, input: input.body ? JSON.parse(input.body.toString()) : undefined });
    await options.beforeTransport?.(input);
    if (options.transport) return options.transport(input);
    if (unavailable) throw Error('private-media-credential-must-not-leak');
    assert.match(input.headers.Authorization, /^Basic /);
    if (input.path === '/v3/config/global/get') return response(200);
    const match = input.path.match(/^\/v3\/config\/paths\/(get|add|patch)\/(.+)$/);
    if (match) {
      if (match[1] === 'get') return configs.has(match[2]) ? response(200, configs.get(match[2])) : response(404);
      const value = JSON.parse(input.body.toString()); configs.set(match[2], { ...configs.get(match[2]), ...value }); return response(200);
    }
    const native = input.path.match(/^\/v3\/paths\/get\/(.+)$/);
    if (native) return sources.has(native[1]) ? response(200, sources.get(native[1])) : ready.has(native[1]) ? response(200, { online: true }) : response(404);
    const clips = input.path.match(/^\/v3\/recordings\/get\/(.+)$/);
    if (clips) { const conf = configs.get(clips[1]); return conf ? response(200, { name: clips[1], segments: recordings.get(conf.recordPath.replace('%path', clips[1])) || [] }) : response(404); }
    const deletion = new URL(input.path, 'http://native');
    if (deletion.pathname === '/v3/recordings/segments/delete') {
      assert.equal(input.method, 'DELETE'); assert.equal(input.body, undefined);
      if (![200, 204].includes(deleteStatus)) return response(deleteStatus, { error: 'private-media-credential-must-not-leak' });
      const id = deletion.searchParams.get('path'), conf = configs.get(id);
      const list = conf ? recordings.get(conf.recordPath.replace('%path', id)) || [] : [];
      const index = list.findIndex(item => item.start === deletion.searchParams.get('start'));
      if (index < 0) return response(400, { error: 'private-recording-path-does-not-exist' });
      list.splice(index, 1); return deleteStatus === 204 ? { status: 204, body: Buffer.alloc(0) } : response(200, { status: 'ok' });
    }
    throw Error('Unexpected media route ' + input.path);
  };
  const playback = http.createServer((req, res) => {
    playbackCalls.push({ path: req.url, headers: req.headers });
    if (options.playback) { options.playback(req, res); return; }
    if (req.headers.range) { res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': 4, 'Content-Range': 'bytes 0-3/' + MP4.length, 'Accept-Ranges': 'bytes' }); res.end(MP4.subarray(0, 4)); }
    else { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length }); res.end(MP4); }
  }); await new Promise(resolve => playback.listen(0, '127.0.0.1', resolve));
  const accounts = createAccountApi({ env: { ...ENV, ...options.env }, storeFile: path.join(directory, 'accounts.json') });
  const api = createVideoRecordingApi({ env: { ...ENV, ...options.env }, accounts,
    file: options.file === undefined ? path.join(directory, 'recording.json') : options.file,
    client: options.client || (async () => ({ devices: [{ deviceId: 'boat-01' }, { deviceId: 'boat-02' }] })), transport, playbackPort: playback.address().port,
    bodyTimeoutMs: 60, ...options.apiOptions });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    if (await accounts.handle(req, res, url)) return;
    if (await api.handle(req, res, url)) return;
    res.writeHead(404); res.end();
  }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await api.close(); accounts.close();
    server.closeAllConnections(); playback.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => playback.close(resolve))]); };
  t.after(close);
  const call = (route, options) => request(server.address().port, route, options);
  const login = async (username = 'admin') => { const result = await call('/api/auth/login', { method: 'POST', body: { username, password: username === 'admin' ? ENV.BOAT_ADMIN_PASSWORD : ENV.BOAT_GUEST_PASSWORD } }); assert.equal(result.status, 200, result.raw); return result.headers['set-cookie'][0].split(';')[0]; };
  const start = (cookie, id = 'boat-01') => call(PREFIX + '/boats/' + id + '/start', { cookie, method: 'POST', body: {} });
  const stop = (cookie, id = 'boat-01') => call(PREFIX + '/boats/' + id + '/stop', { cookie, method: 'POST', body: {} });
  const addClip = (id = 'boat-01', directory = ROOT + '/recordings', start = new Date(Date.now() - 120000).toISOString()) => {
    const conf = configs.get(id);
    assert.ok(conf && conf.recordPath.startsWith(directory + '/%path/'), 'recording path must exist');
    const actualPath = conf.recordPath.replace('%path', id), list = recordings.get(actualPath) || []; list.push({ start, duration: 60 }); recordings.set(actualPath, list); return start;
  };
  return { call, login, start, stop, addClip, close, configs, recordings, ready, sources, calls, playbackCalls, api, directory, server,
    setUnavailable: value => { unavailable = value; }, setDeleteStatus: value => { deleteStatus = value; } };
}

test('only normalized absolute subdirectories are accepted; private state paths follow configured precedence', () => {
  assert.equal(normalizeDirectory(ROOT + '/recordings/trip_01-2026'), ROOT + '/recordings/trip_01-2026');
  for (const value of ['/etc/recordings', '/var/lib/unmanned-boat-video-other', ROOT + '/a/../b', ROOT + '//x', ROOT + '/.', ROOT + '/a/', ROOT + '/%path', ROOT + '/x\ny', 'relative', ROOT + '/a\\b', ROOT + '/中文']) assert.equal(normalizeDirectory(value), null, value);
  assert.equal(resolveRecordingConfigFile({}, ''), '');
  assert.equal(resolveRecordingConfigFile({ STATE_DIRECTORY: '/tmp/state:/tmp/second' }), path.normalize('/tmp/state/video-recording.json'));
  assert.equal(resolveRecordingConfigFile({ BOAT_UPDATE_ENABLED: '1', BOAT_UPDATE_STATE_DIR: '/tmp/update' }), path.normalize('/tmp/update/requests/video-recording.json'));
  assert.throws(() => resolveRecordingConfigFile({ BOAT_VIDEO_RECORDING_CONFIG_FILE: 'relative' }));
});

test('recording requires login; paths and controls stay administrator-only, mutations reject cross-origin and unknown boats', async t => {
  const f = await fixture(t), admin = await f.login(), guest = await f.login('guest');
  assert.equal((await f.call(PREFIX + '/config')).status, 401);
  const config = await f.call(PREFIX + '/config', { cookie: admin }); assert.equal(config.status, 200); assert.equal(config.data.directory, ROOT + '/recordings'); assert.equal(config.data.activeCount, 0);
  const visible = await f.call(PREFIX + '/config', { cookie: guest }); assert.equal(visible.status, 200); assert.doesNotMatch(visible.raw, /allowedRoot|directory|var\/lib|password|Basic/);
  assert.equal((await f.start(guest)).status, 403);
  assert.equal((await f.call(PREFIX + '/config', { cookie: guest, method: 'PATCH', body: { directory: ROOT + '/trip' } })).status, 403);
  assert.equal((await f.call(PREFIX + '/boats/boat-01/start', { cookie: admin, method: 'POST', body: {}, origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call(PREFIX + '/boats/boat-01/start', { cookie: admin, method: 'POST', body: {}, origin: null })).status, 403);
  assert.equal((await f.start(admin, 'unknown')).status, 404);
  assert.equal((await f.start(admin, '__boatrec_' + 'a'.repeat(32))).status, 404);
  assert.equal(f.calls.length, 0);
});

test('native recorder arms without telemetry or viewers, and each boat has an independent source and index', async t => {
  const f = await fixture(t), admin = await f.login(), guest = await f.login('guest');
  const started = await f.start(admin); assert.equal(started.status, 200, started.raw); assert.equal(started.data.armed, true); assert.equal(started.data.receiving, false); assert.equal(started.data.recording, false);
  assert.equal(f.configs.get('boat-01').record, true); assert.equal(f.configs.get('boat-01').recordFormat, 'fmp4'); assert.equal(f.configs.get('boat-01').recordSegmentDuration, '60s'); assert.equal(f.configs.get('boat-01').recordDeleteAfter, '168h');
  assert.match(f.configs.get('boat-01').recordPath, /\/%path\//);
  f.ready.add('boat-01'); f.addClip();
  const status = await f.call(PREFIX + '/boats/boat-01', { cookie: guest }); assert.equal(status.data.recording, true); assert.equal(status.data.segments.length, 1);
  assert.match(status.data.segments[0].id, /^[a-f0-9]{64}$/); assert.doesNotMatch(status.raw, /__boatrec_|var\/lib|recordPath|Authorization/);
  const second = await f.call(PREFIX + '/boats/boat-02', { cookie: guest }); assert.equal(second.data.armed, false); assert.deepEqual(second.data.segments, []);
  assert.equal((await f.call(status.data.segments[0].playbackUrl.replace('boat-01', 'boat-02'), { cookie: guest })).status, 404);
});

test('directory updates refuse active recorders, preserve old files separately, and validate every path component', async t => {
  const f = await fixture(t), admin = await f.login(); await f.start(admin); f.addClip();
  const patch = directory => f.call(PREFIX + '/config', { cookie: admin, method: 'PATCH', body: { directory } });
  assert.equal((await patch(ROOT + '/trip-02')).status, 409);
  await f.stop(admin); assert.equal((await patch(ROOT + '/trip-02')).status, 200);
  await f.start(admin); f.addClip('boat-01', ROOT + '/trip-02', new Date(Date.now() - 60000).toISOString());
  const result = await f.call(PREFIX + '/boats/boat-01', { cookie: admin }); assert.equal(result.data.segments.length, 1);
  assert.equal(f.configs.get('boat-01').recordPath.startsWith(ROOT + '/trip-02/%path/'), true);
  assert.equal(f.recordings.size, 2, 'old files must not be deleted or moved');
  await f.stop(admin);
  assert.equal((await patch(ROOT + '/recordings')).status, 200);
  assert.equal((await f.call(PREFIX + '/boats/boat-01', { cookie: admin })).data.segments.length, 1, 'switching back can browse the old directory');
  for (const value of ['/etc', ROOT + '/a/../../escape', ROOT + '/x%Y', ROOT + '//x', ROOT + '/x\u0000']) assert.equal((await patch(value)).status, 400, value);
});

test('stored intent survives process restart and reconciliation recovers a restarted MediaMTX without repeated patches', async t => {
  const f = await fixture(t), admin = await f.login(); await f.start(admin); await f.close();
  const g = await fixture(t, { directory: f.directory }), cookie = await g.login();
  await g.api.reconcile();
  // 初始化恢复可能仍在执行；等待已保存船的原生配置重新出现。
  for (let count = 0; count < 100 && !g.configs.has('boat-01'); count++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(g.configs.get('boat-01').record, true);
  let snapshot = await g.call(PREFIX + '/boats/boat-01', { cookie }); assert.equal(snapshot.data.armed, true);
  const changes = () => g.calls.filter(item => item.method !== 'GET').length;
  const before = changes(); await g.api.reconcile(); assert.equal(changes(), before, 'unchanged configuration must not restart recorder');
  g.configs.clear(); await g.api.reconcile(); assert.equal(g.configs.get('boat-01').record, true); assert.ok(changes() > before);
});

test('recording stop intent is persisted during a media outage and applied when service returns', async t => {
  const f = await fixture(t), admin = await f.login(); await f.start(admin); f.setUnavailable(true);
  const stop = await f.stop(admin); assert.equal(stop.status, 200, stop.raw); assert.equal(stop.data.armed, false); assert.match(stop.data.error, /重试|确认/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'recording.json'), 'utf8')).boats['boat-01'].armed, false);
  assert.doesNotMatch(stop.raw, /private-media-credential/);
  f.setUnavailable(false); await f.api.reconcile(); assert.equal(f.configs.get('boat-01').record, false);
});

test('an armed request is not presented as recording until the native recorder confirms the requested path', async t => {
  const f = await fixture(t), cookie = await f.login(); await f.start(cookie); f.ready.add('boat-01');
  f.configs.get('boat-01').record = false;
  const pending = await f.call(PREFIX + '/boats/boat-01', { cookie });
  assert.equal(pending.data.armed, true); assert.equal(pending.data.receiving, true); assert.equal(pending.data.recording, false); assert.match(pending.data.error, /确认/);
  await f.api.reconcile();
  const restored = await f.call(PREFIX + '/boats/boat-01', { cookie }); assert.equal(restored.data.recording, true); assert.equal(restored.data.error, null);
});

test('static UDP input needs recent byte progress and recovers after stalls, source restarts and deprecated counters', async t => {
  let time = Date.now();
  const f = await fixture(t, { apiOptions: { now: () => time } }), cookie = await f.login();
  const source = { online: true, onlineTime: '2026-10-28T10:00:00Z', inboundBytes: 0 };
  f.sources.set('boat-01', source);
  const started = await f.start(cookie); assert.equal(started.data.armed, true); assert.equal(started.data.receiving, false); assert.equal(started.data.recording, false);
  const status = async () => (await f.call(PREFIX + '/boats/boat-01', { cookie })).data;
  time += 20000; assert.equal((await status()).receiving, false, 'online source with no packets must remain waiting');
  source.inboundBytes = 1000;
  let current = await status(); assert.equal(current.receiving, true); assert.equal(current.recording, true);
  time += 8000; assert.equal((await status()).receiving, true, 'one normal polling gap is allowed');
  time += 4001; current = await status(); assert.equal(current.receiving, false); assert.equal(current.recording, false);
  source.inboundBytes = 1100; assert.equal((await status()).receiving, true, 'new packets recover receiving without rearming');
  source.online = false; assert.equal((await status()).receiving, false);
  source.online = true; source.inboundBytes = 0; source.onlineTime = '2026-10-28T10:01:00Z'; assert.equal((await status()).receiving, false, 'restart with no packets resets the cached progress');
  source.inboundBytes = 100; assert.equal((await status()).receiving, true);
  source.inboundBytes = 5; assert.equal((await status()).receiving, true, 'a reset counter with new nonzero input starts a new observation');
  delete source.inboundBytes; source.bytesReceived = 0; assert.equal((await status()).receiving, false);
  source.bytesReceived = 200; assert.equal((await status()).receiving, true, 'older MediaMTX counters are supported');
  time += 12001; assert.equal((await status()).receiving, false);
  source.inboundBytes = 0; source.bytesReceived = 300; assert.equal((await status()).receiving, false, 'the current counter takes precedence over deprecated values');
  source.inboundBytes = null; source.bytesReceived = null; assert.equal((await status()).receiving, false, 'invalid reported counters fail closed');
  delete source.inboundBytes; delete source.bytesReceived; assert.equal((await status()).receiving, true, 'no-counter old media servers retain compatible online detection');
});

test('per-boat recording changes preserve static UDP source URL, SDP and source transport configuration', async t => {
  const f = await fixture(t), cookie = await f.login();
  const sourceSettings = { source: 'udp+rtp://0.0.0.0:8000', rtspTransport: 'udp', sourceOnDemand: false,
    rtspAnyPort: false, sdp: 'v=0\r\nm=video 8000 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n' };
  f.configs.set('boat-01', { ...sourceSettings, record: false });
  assert.equal((await f.start(cookie)).status, 200);
  for (const [key, value] of Object.entries(sourceSettings)) assert.equal(f.configs.get('boat-01')[key], value);
  assert.equal((await f.stop(cookie)).status, 200);
  for (const [key, value] of Object.entries(sourceSettings)) assert.equal(f.configs.get('boat-01')[key], value);
  const changes = f.calls.filter(item => item.method === 'PATCH'); assert.ok(changes.length >= 2);
  for (const change of changes) assert.equal(Object.keys(change.input).some(key => Object.hasOwn(sourceSettings, key)), false, 'only recording fields may be patched');
});

test('MP4 proxy streams only catalogued clips, preserves ranges, supports HEAD and requires a current login', async t => {
  const f = await fixture(t), admin = await f.login(), guest = await f.login('guest'); await f.start(admin); f.addClip();
  const status = await f.call(PREFIX + '/boats/boat-01', { cookie: guest }), clip = status.data.segments[0];
  assert.equal((await f.call(clip.playbackUrl)).status, 401);
  assert.equal((await f.call(PREFIX + '/boats/boat-01/clips/' + 'a'.repeat(64), { cookie: guest })).status, 404);
  let result = await f.call(clip.downloadUrl, { cookie: guest, origin: null }); assert.equal(result.status, 200, result.raw); assert.deepEqual(result.buffer, MP4); assert.match(result.headers['content-disposition'], /^attachment; filename="boat-01-/);
  const upstream = new URL(f.playbackCalls.at(-1).path, 'http://local'); assert.equal(upstream.searchParams.get('path'), 'boat-01'); assert.equal(upstream.searchParams.get('format'), 'mp4'); assert.equal(upstream.searchParams.get('duration'), '60'); assert.match(f.playbackCalls.at(-1).headers.authorization, /^Basic /);
  result = await f.call(clip.playbackUrl, { cookie: guest, headers: { Range: 'bytes=0-3' } }); assert.equal(result.status, 206); assert.equal(result.buffer.length, 4); assert.equal(result.headers['accept-ranges'], 'bytes');
  result = await f.call(clip.playbackUrl, { cookie: guest, method: 'HEAD' }); assert.equal(result.status, 200); assert.equal(result.buffer.length, 0); assert.equal(Number(result.headers['content-length']), MP4.length);
  assert.equal((await f.call(clip.playbackUrl, { cookie: guest, headers: { Range: 'bytes=0-3,8-9' } })).status, 416);
  assert.equal((await f.call(clip.playbackUrl + '?path=another-boat', { cookie: guest })).status, 400);
  assert.equal((await f.call(clip.playbackUrl, { cookie: guest, origin: 'https://evil.test' })).status, 403);
});

test('logout aborts an active upstream video response rather than leaking it to an invalid session', async t => {
  let upstreamClosed; const upstreamDone = new Promise(resolve => { upstreamClosed = resolve; });
  const f = await fixture(t, { playback: (req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.write('first-video-part'); res.once('close', upstreamClosed); } });
  const cookie = await f.login(); await f.start(cookie); f.addClip(); const status = await f.call(PREFIX + '/boats/boat-01', { cookie }), clip = status.data.segments[0];
  const started = new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: f.server.address().port, path: clip.playbackUrl, headers: { Cookie: cookie } }, response => { response.once('data', resolve); response.on('error', () => {}); }); request.on('error', reject);
  }); await started;
  const logout = await f.call('/api/auth/session', { cookie, method: 'DELETE' }); assert.equal(logout.status, 200);
  await Promise.race([upstreamDone, new Promise((_, reject) => setTimeout(() => reject(Error('upstream was not aborted')), 1000))]);
});

test('only administrators may delete catalogued clips and deletion rejects cross-origin, bodies, queries and another boat', async t => {
  const f = await fixture(t), admin = await f.login(), guest = await f.login('guest');
  await f.start(admin); f.addClip(); await f.stop(admin);
  const clip = (await f.call(PREFIX + '/boats/boat-01', { cookie: admin })).data.segments[0];
  const remove = options => f.call(clip.playbackUrl, { cookie: admin, method: 'DELETE', ...options });
  assert.equal((await remove({ cookie: null })).status, 401);
  assert.equal((await remove({ cookie: guest })).status, 403);
  assert.equal((await remove({ origin: 'https://evil.test' })).status, 403);
  assert.equal((await remove({ origin: null })).status, 403);
  assert.equal((await remove({ body: { start: clip.start } })).status, 400);
  assert.equal((await f.call(clip.playbackUrl + '?download=1', { cookie: admin, method: 'DELETE' })).status, 400);
  assert.equal((await f.call(clip.playbackUrl.replace('boat-01', 'boat-02'), { cookie: admin, method: 'DELETE' })).status, 404);
  assert.equal((await f.call(clip.playbackUrl.replace('boat-01', 'unknown'), { cookie: admin, method: 'DELETE' })).status, 404);
  assert.equal((await f.call(clip.playbackUrl.replace(clip.id, 'a'.repeat(64)), { cookie: admin, method: 'DELETE' })).status, 404);
  assert.equal((await f.call(PREFIX + '/boats/boat-01/clips/%2e%2e%2fvideo.mp4', { cookie: admin, method: 'DELETE' })).status, 404);
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 0);
  assert.equal((await f.call(PREFIX + '/boats/boat-01', { cookie: admin })).data.segments.length, 1);
});

test('deleting a finished clip uses only its trusted boat and exact start, preserving other boats and saved recorder intent', async t => {
  const f = await fixture(t), cookie = await f.login();
  const start = '2026-01-01T08:01:02.123456+08:00';
  for (const id of ['boat-01', 'boat-02']) { await f.start(cookie, id); f.addClip(id, ROOT + '/recordings', start); await f.stop(cookie, id); }
  const before = f.api.getState(), clips = (await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments;
  const result = await f.call(clips[0].playbackUrl, { cookie, method: 'DELETE' });
  assert.equal(result.status, 200, result.raw);
  assert.deepEqual(result.data, { deviceId: 'boat-01', deletedId: clips[0].id, deleted: true });
  assert.deepEqual(f.api.getState(), before);
  const deletion = new URL(f.calls.find(item => item.method === 'DELETE').path, 'http://native');
  assert.equal(deletion.pathname, '/v3/recordings/segments/delete');
  assert.deepEqual([...deletion.searchParams], [['path', 'boat-01'], ['start', start]]);
  assert.equal((await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments.length, 0);
  assert.equal((await f.call(PREFIX + '/boats/boat-02', { cookie })).data.segments.length, 1);
  assert.equal((await f.call(clips[0].playbackUrl, { cookie })).status, 404);
  assert.equal((await f.call(clips[0].playbackUrl, { cookie, method: 'DELETE' })).status, 404);
});

test('recording can continue while older clips are deleted, but the latest potentially open segment is protected', async t => {
  const f = await fixture(t), cookie = await f.login(); await f.start(cookie);
  f.addClip('boat-01', ROOT + '/recordings', new Date(Date.now() - 180000).toISOString());
  f.addClip('boat-01', ROOT + '/recordings', new Date(Date.now() - 120000).toISOString());
  const [latest, older] = (await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments;
  assert.equal((await f.call(latest.playbackUrl, { cookie, method: 'DELETE' })).status, 409);
  assert.equal((await f.call(older.playbackUrl, { cookie, method: 'DELETE' })).status, 200);
  assert.equal(f.configs.get('boat-01').record, true);
  assert.equal(f.api.getState().boats['boat-01'].armed, true);
  await f.stop(cookie); f.setDeleteStatus(204);
  assert.equal((await f.call(latest.playbackUrl, { cookie, method: 'DELETE' })).status, 200, 'empty upstream success responses are supported');
});

test('stale clips and unsynchronized media paths cannot delete files in another recording directory', async t => {
  const f = await fixture(t), cookie = await f.login(); await f.start(cookie); f.addClip(); await f.stop(cookie);
  const clip = (await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments[0];
  assert.equal((await f.call(PREFIX + '/config', { cookie, method: 'PATCH', body: { directory: ROOT + '/trip' } })).status, 200);
  f.addClip('boat-01', ROOT + '/trip', clip.start);
  assert.equal((await f.call(clip.playbackUrl, { cookie, method: 'DELETE' })).status, 404);
  const current = (await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments[0];
  assert.notEqual(current.id, clip.id);
  f.configs.get('boat-01').recordPath = f.configs.get('boat-01').recordPath.replace('/trip/', '/elsewhere/');
  f.recordings.set(f.configs.get('boat-01').recordPath.replace('%path', 'boat-01'), [{ start: clip.start, duration: 60 }]);
  assert.equal((await f.call(current.playbackUrl, { cookie, method: 'DELETE' })).status, 409);
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 0);
});

test('failed native deletion leaves the clip in the catalog and never reports success or private error details', async t => {
  const f = await fixture(t), cookie = await f.login(); await f.start(cookie); f.addClip(); await f.stop(cookie);
  const clip = (await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments[0];
  for (const code of [400, 403, 404, 500]) {
    f.setDeleteStatus(code);
    const result = await f.call(clip.playbackUrl, { cookie, method: 'DELETE' });
    assert.equal(result.status, 503); assert.equal(result.data.deleted, undefined);
    assert.doesNotMatch(result.raw, /private-media|var\/lib|Basic|password/);
    assert.equal((await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments.length, 1);
  }
});

test('deletion rechecks an expired session after catalog lookup and does not issue a native delete', async t => {
  let release, entered; const waiting = new Promise(resolve => { entered = resolve; });
  let hold = false;
  const f = await fixture(t, { beforeTransport: async input => {
    if (hold && input.path === '/v3/recordings/get/boat-01') { hold = false; entered(); await new Promise(resolve => { release = resolve; }); }
  } }), cookie = await f.login();
  await f.start(cookie); f.addClip(); await f.stop(cookie);
  const clip = (await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments[0];
  hold = true; const deletion = f.call(clip.playbackUrl, { cookie, method: 'DELETE' });
  await waiting; assert.equal((await f.call('/api/auth/session', { cookie, method: 'DELETE' })).status, 200); release();
  assert.equal((await deletion).status, 401); assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 0);
});

test('deletion serializes with directory changes and repeated removal while catalog resolution is pending', async t => {
  let release, entered; const waiting = new Promise(resolve => { entered = resolve; }); let hold = false;
  const f = await fixture(t, { beforeTransport: async input => {
    if (hold && input.path === '/v3/recordings/get/boat-01') { hold = false; entered(); await new Promise(resolve => { release = resolve; }); }
  } }), cookie = await f.login();
  await f.start(cookie); f.addClip(); await f.stop(cookie);
  const clip = (await f.call(PREFIX + '/boats/boat-01', { cookie })).data.segments[0];
  hold = true; const deletion = f.call(clip.playbackUrl, { cookie, method: 'DELETE' }); await waiting;
  assert.equal((await f.call(PREFIX + '/config', { cookie, method: 'PATCH', body: { directory: ROOT + '/new' } })).status, 409);
  assert.equal((await f.call(clip.playbackUrl, { cookie, method: 'DELETE' })).status, 409);
  release(); assert.equal((await deletion).status, 200);
  assert.equal(f.api.getState().directory, ROOT + '/recordings');
});

test('disabled, memory-only, corrupt state, unsupported methods and malformed mutations report explicit errors', async t => {
  const f = await fixture(t, { env: { BOAT_VIDEO_RECORDING_ENABLED: '0' } }), cookie = await f.login();
  const disabled = await f.call(PREFIX + '/config', { cookie }); assert.equal(disabled.data.enabled, false); assert.equal((await f.start(cookie)).status, 503);
  const g = await fixture(t, { file: '' }), admin = await g.login(); assert.equal((await g.call(PREFIX + '/config', { cookie: admin })).data.persistent, false);
  assert.equal((await g.call(PREFIX + '/config', { cookie: admin, method: 'POST', body: {} })).status, 405);
  assert.equal((await g.call(PREFIX + '/config', { cookie: admin, method: 'PATCH', body: { directory: ROOT + '/new', extra: true } })).status, 400);
  assert.equal((await g.call(PREFIX + '/boats/boat-01/start', { cookie: admin, method: 'POST', raw: 'broken' })).status, 400);
  assert.equal((await g.call(PREFIX + '/boats/boat-01/start', { cookie: admin, method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await g.call(PREFIX + '/boats/boat-01/start', { cookie: admin, method: 'POST', body: { extra: true } })).status, 400);
  await f.close(); fs.writeFileSync(path.join(f.directory, 'recording.json'), '{broken');
  const h = await fixture(t, { directory: f.directory }), user = await h.login();
  assert.match((await h.call(PREFIX + '/config', { cookie: user })).data.error, /损坏/); assert.equal((await h.start(user)).status, 503);
  assert.equal(fs.readFileSync(path.join(f.directory, 'recording.json'), 'utf8'), '{broken');
});
