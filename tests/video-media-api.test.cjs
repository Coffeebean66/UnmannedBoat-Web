/* SRT 鉴权、真实平台登录和 WHEP 会话生命周期；不连接实船或公网服务。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { EventEmitter } = require('node:events');
const { createServer } = require('../server');
const { readMediaConfig, upstreamLocation, createMediaTransport, READER } = require('../server/video-media-api');
const ORIGIN = 'https://media.test', BASE = '/api/video/media', OFFER = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', ANSWER = Buffer.from(OFFER);
const env = { BOAT_ACCOUNTS_ENABLED: '1', BOAT_ACCOUNTS_ORIGIN: ORIGIN,
  BOAT_ADMIN_USERNAME: 'admin', BOAT_ADMIN_PASSWORD: 'media-admin-test', BOAT_GUEST_USERNAME: 'guest', BOAT_GUEST_PASSWORD: 'media-guest-test',
  BOAT_VIDEO_MEDIA_ENABLED: '1', BOAT_VIDEO_MEDIA_AUTH_TOKEN: 'a'.repeat(64), BOAT_VIDEO_MEDIA_READER_PASSWORD: 'b'.repeat(64), BOAT_VIDEO_MEDIA_PUBLIC_HOST: 'boat.example.test' };
const credentials = { admin: 'media-admin-test', guest: 'media-guest-test' };
function request(port, route, { method = 'GET', raw, body, cookie, origin = ORIGIN, headers = {} } = {}) {
  const data = raw === undefined && body !== undefined ? JSON.stringify(body) : raw;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: {
      ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
      ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...headers
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let data; try { data = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, data, raw, headers: res.headers });
      });
    }); req.on('error', reject); req.end(data);
  });
}
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-media-api-')), calls = [], transportCalls = [];
  let time = Date.now(), mediaCounter = 0;
  const client = options.client || (async (method, route, body) => {
    calls.push({ method, route, body: body && { ...body } });
    return method === 'GET' ? { canAuthenticateVideo: true, devices: [{ deviceId: 'boat-01', username: 'boat-01' }] } : { authorized: body.username === 'camera-one' && body.password === 'camera-only-test' };
  });
  const transport = options.transport || (async input => {
    transportCalls.push(input);
    return input.method === 'POST' ? { status: 201, headers: { location: '/boat-01/whep/private-' + ++mediaCounter, 'content-type': 'application/sdp' }, body: ANSWER } : { status: 204, headers: {}, body: Buffer.alloc(0) };
  });
  const cloud = new EventEmitter(); Object.assign(cloud, { enabled: true, start() {}, stop() {}, list: () => ({ brokerConnected: true, devices: [] }) });
  const server = createServer({ env: { ...env, ...options.env }, cloud,
    accountOptions: { storeFile: path.join(directory, 'accounts.json'), now: () => time }, mapOptions: { file: path.join(directory, 'map.json') },
    videoMediaOptions: { client, transport, now: () => time, bodyTimeoutMs: 75, ...options.videoMediaOptions } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  t.after(async () => { await close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (route, input) => request(server.address().port, route, input);
  const login = async (username = 'admin') => {
    const result = await call('/api/auth/login', { method: 'POST', body: { username, password: credentials[username] } });
    assert.equal(result.status, 200, result.raw); return result.headers['set-cookie'][0].split(';')[0];
  };
  const play = (cookie, changes = {}) => call(BASE + '/boats/boat-01/whep', { cookie, method: 'POST', raw: OFFER, headers: { 'Content-Type': 'application/sdp' }, ...changes });
  return { server, call, login, play, calls, transportCalls, close, advance: ms => time += ms };
}
const callback = (changes = {}) => ({ user: 'camera-one', password: 'camera-only-test', ip: '192.0.2.3', action: 'publish', protocol: 'srt', path: 'boat-01', ...changes });

test('low-latency media is opt-in and validates secrets, host and port before starting', () => {
  assert.deepEqual(readMediaConfig({}), { enabled: false });
  const config = readMediaConfig(env); assert.equal(config.port, 8890); assert.equal(config.webRtcPort, 8189);
  for (const changes of [{ BOAT_VIDEO_MEDIA_AUTH_TOKEN: 'short' }, { BOAT_VIDEO_MEDIA_READER_PASSWORD: '' }, { BOAT_VIDEO_MEDIA_PUBLIC_HOST: 'https://host/' },
    { BOAT_VIDEO_MEDIA_PUBLIC_HOST: 'a..b' }, { BOAT_VIDEO_SRT_PORT: '80' }, { BOAT_VIDEO_SRT_PORT: '8189' }, { BOAT_VIDEO_WEBRTC_PORT: '90000' }]) {
    assert.throws(() => readMediaConfig({ ...env, ...changes }), /configuration is invalid/);
  }
});

test('media configuration requires monitor login, returns public ingress only and supports disabled installations', async t => {
  const f = await fixture(t), guest = await f.login('guest');
  assert.equal((await f.call(BASE + '/config')).status, 401);
  const result = await f.call(BASE + '/config', { cookie: guest, origin: null });
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.data, { enabled: true, format: 'webrtc', playbackBase: BASE + '/boats/', ingest: { protocol: 'srt', host: 'boat.example.test', port: 8890 } });
  assert.doesNotMatch(result.raw, /reader|password|authToken|127\.0\.0\.1|bbbb|aaaa/);
  const g = await fixture(t, { env: { BOAT_VIDEO_MEDIA_ENABLED: '0' } }), cookie = await g.login();
  assert.deepEqual((await g.call(BASE + '/config', { cookie })).data, { enabled: false }); assert.equal((await g.play(cookie)).status, 503);
});

test('legacy cloud-password installations can detect disabled media without weakening enabled-media or account authentication', async t => {
  const f = await fixture(t, { env: { BOAT_ACCOUNTS_ENABLED: '0', BOAT_VIDEO_MEDIA_ENABLED: '0', BOAT_CLOUD_PASSWORD: 'legacy-viewer-test-only' } });
  const result = await f.call(BASE + '/config', { origin: null, headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(result.status, 200); assert.deepEqual(result.data, { enabled: false }); assert.equal(result.headers['cache-control'], 'no-store');
  assert.doesNotMatch(result.raw, /password|reader|host|aaaa|bbbb/);
  assert.equal((await f.call(BASE + '/config', { origin: 'http://media.test', headers: { Host: 'media.test' } })).status, 200);
  assert.equal((await f.call(BASE + '/config', { origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call(BASE + '/config', { origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.play()).status, 503); assert.equal(f.calls.length, 0);
  const enabled = await fixture(t, { env: { BOAT_ACCOUNTS_ENABLED: '0', BOAT_CLOUD_PASSWORD: 'legacy-viewer-test-only' } });
  assert.equal((await enabled.call(BASE + '/config', { origin: null })).status, 503); assert.equal((await enabled.play()).status, 503);
  const accounts = await fixture(t, { env: { BOAT_VIDEO_MEDIA_ENABLED: '0' } });
  assert.equal((await accounts.call(BASE + '/config', { origin: null })).status, 401);
});

test('WHEP creates an opaque owned session for a known boat without requiring an MQTT video descriptor', async t => {
  const f = await fixture(t), guest = await f.login('guest'), result = await f.play(guest);
  assert.equal(result.status, 201, result.raw); assert.equal(result.raw, OFFER);
  assert.match(result.headers.location, /^\/api\/video\/media\/boats\/boat-01\/whep\/[a-f0-9]{32}$/);
  assert.doesNotMatch(result.headers.location, /private|127\.0\.0\.1/);
  assert.equal(f.transportCalls[0].path, '/boat-01/whep'); assert.equal(f.transportCalls[0].body.toString(), OFFER);
  assert.equal(f.transportCalls[0].headers.Authorization, 'Basic ' + Buffer.from(READER + ':' + env.BOAT_VIDEO_MEDIA_READER_PASSWORD).toString('base64'));
  assert.equal((await f.call(result.headers.location, { cookie: guest, method: 'DELETE' })).status, 204);
  assert.deepEqual(f.transportCalls.map(item => [item.method, item.path]), [['POST', '/boat-01/whep'], ['DELETE', '/boat-01/whep/private-1']]);
  assert.equal((await f.call(result.headers.location, { cookie: guest, method: 'DELETE' })).status, 404);
});

test('cross-origin requests, unsupported methods, malformed boats and invalid SDP never reach MediaMTX', async t => {
  const f = await fixture(t), cookie = await f.login();
  for (const origin of [null, 'https://evil.test']) assert.equal((await f.play(cookie, { origin })).status, 403);
  assert.equal((await f.call(BASE + '/config', { cookie, origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.call(BASE + '/boats/boat-01/whep', { cookie, method: 'PATCH' })).status, 405);
  assert.equal((await f.call(BASE + '/boats/bad%2Fboat/whep', { cookie, method: 'POST' })).status, 404);
  assert.equal((await f.play(cookie, { raw: 'v=0\r\nm=audio 9 test\r\n' })).status, 400);
  assert.equal((await f.play(cookie, { raw: OFFER + '\0' })).status, 400);
  assert.equal((await f.play(cookie, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.play(cookie, { raw: OFFER + 'x'.repeat(65536) })).status, 413);
  assert.equal(f.calls.length, 0); assert.equal(f.transportCalls.length, 0);
});

test('unregistered boats, old helpers and helper failures fail closed without leaking details', async t => {
  for (const [reply, status] of [[{ devices: [{ deviceId: 'boat-01' }] }, 503], [{ devices: [], canAuthenticateVideo: true }, 404], [Error('private-helper-password'), 503]]) {
    const f = await fixture(t, { client: async () => { if (reply instanceof Error) throw reply; return reply; } }), cookie = await f.login();
    const result = await f.play(cookie); assert.equal(result.status, status, result.raw); assert.doesNotMatch(result.raw, /private-helper-password/); assert.equal(f.transportCalls.length, 0);
  }
});

test('upstream sessions cannot be used by another platform login or boat and logout deletes their real resource', async t => {
  const f = await fixture(t), first = await f.login(), second = await f.login('guest'), result = await f.play(first);
  assert.equal(result.status, 201);
  assert.equal((await f.call(result.headers.location, { cookie: second, method: 'DELETE' })).status, 404);
  assert.equal((await f.call(result.headers.location.replace('boat-01', 'boat-02'), { cookie: first, method: 'DELETE' })).status, 404);
  assert.equal(f.transportCalls.length, 1);
  await f.call('/api/auth/session', { cookie: first, method: 'DELETE' });
  assert.equal(f.transportCalls.filter(item => item.method === 'DELETE').length, 1);
  assert.equal((await f.call(result.headers.location, { cookie: first, method: 'DELETE' })).status, 401);
});

test('logout during upstream creation deletes the eventual session instead of exposing an orphaned stream', async t => {
  let started, release; const began = new Promise(resolve => started = resolve), calls = [];
  const f = await fixture(t, { transport: async input => { calls.push(input); if (input.method === 'DELETE') return { status: 204 };
    started(); await new Promise(resolve => release = resolve); return { status: 201, headers: { location: '/boat-01/whep/created-after-logout', 'content-type': 'application/sdp' }, body: ANSWER };
  } }), cookie = await f.login();
  const pending = f.play(cookie); await began; await f.call('/api/auth/session', { cookie, method: 'DELETE' }); release();
  assert.equal((await pending).status, 401); assert.deepEqual(calls.map(item => item.method), ['POST', 'DELETE']);
});

test('aborting a browser POST during upstream creation still deletes the eventual MediaMTX session', async t => {
  let started, release, deleted; const began = new Promise(resolve => started = resolve), removed = new Promise(resolve => deleted = resolve), calls = [];
  const f = await fixture(t, { transport: async input => { calls.push(input); if (input.method === 'DELETE') { deleted(); return { status: 204 }; }
    started(); await new Promise(resolve => release = resolve); return { status: 201, headers: { location: '/boat-01/whep/abandoned', 'content-type': 'application/sdp' }, body: ANSWER };
  } }), cookie = await f.login();
  const req = http.request({ host: '127.0.0.1', port: f.server.address().port, path: BASE + '/boats/boat-01/whep', method: 'POST',
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/sdp', 'Content-Length': Buffer.byteLength(OFFER) } });
  const interrupted = new Promise(resolve => req.once('error', resolve)); req.end(OFFER); await began;
  const closed = new Promise(resolve => f.server.once('request', () => resolve()));
  req.destroy(); await interrupted;
  // A same-server request provides a turn for the server-side connection close to arrive before resolving MediaMTX.
  await f.call('/healthz'); await closed; release(); await removed;
  assert.deepEqual(calls.map(item => item.method), ['POST', 'DELETE']);
});

test('slow partial SDP bodies time out before helper access and expired platform sessions stop existing streams', async t => {
  const f = await fixture(t), cookie = await f.login();
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.server.address().port, path: BASE + '/boats/boat-01/whep', method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/sdp', 'Content-Length': Buffer.byteLength(OFFER) } }, res => { res.resume(); res.on('end', () => { req.end(); resolve(res.statusCode); }); });
    req.once('error', reject); req.write(OFFER.slice(0, 4));
  });
  assert.equal(status, 408); assert.equal(f.calls.length, 0); assert.equal(f.transportCalls.length, 0);
  assert.equal((await f.play(cookie)).status, 201); f.advance(13 * 60 * 60 * 1000);
  assert.equal((await f.call(BASE + '/config', { cookie })).status, 401);
  assert.deepEqual(f.transportCalls.map(item => item.method), ['POST', 'DELETE']);
});

test('media session limits are enforced before creating more streams and closing the server deletes active sessions', async t => {
  const f = await fixture(t, { videoMediaOptions: { maxPerSession: 1 } }), cookie = await f.login();
  assert.equal((await f.play(cookie)).status, 201); assert.equal((await f.play(cookie)).status, 429);
  await f.close(); assert.deepEqual(f.transportCalls.map(item => item.method), ['POST', 'DELETE']);
});

test('invalid upstream replies and unreachable publishers never expose upstream details or arbitrary proxy paths', async t => {
  for (const [response, status] of [
    [{ status: 404, body: Buffer.from('private-RTSP-credentials') }, 404],
    [{ status: 500, body: Buffer.from('private-RTSP-credentials') }, 503],
    [{ status: 201, headers: { location: 'http://evil.test/boat-01/whep/session', 'content-type': 'application/sdp' }, body: ANSWER }, 502],
    [{ status: 201, headers: { location: '/boat-01/whep/session', 'content-type': 'text/plain' }, body: ANSWER }, 502]
  ]) {
    const calls = [], f = await fixture(t, { transport: async input => { calls.push(input); return response; } }), cookie = await f.login();
    const result = await f.play(cookie); assert.equal(result.status, status, result.raw); assert.doesNotMatch(result.raw, /private-RTSP|evil\.test/);
    if (response.headers?.['content-type'] === 'text/plain') assert.deepEqual(calls.map(item => item.method), ['POST', 'DELETE']);
  }
  for (const value of ['http://evil.test/boat-01/whep/x', '//evil.test/boat-01/whep/x', '/boat-02/whep/x', '/boat-01/whep/x?token=secret', '/boat-01/whep/x#fragment', '/boat-01/whep/../../admin', 'http://user:secret@127.0.0.1:8889/boat-01/whep/x']) assert.throws(() => upstreamLocation(value, 'boat-01'));
  assert.equal(upstreamLocation('/boat-01/whep/uuid_1-a', 'boat-01'), '/boat-01/whep/uuid_1-a');
});

test('MediaMTX publish callbacks require loopback shared token, strict protocol and device-bound dedicated credentials', async t => {
  const f = await fixture(t), route = BASE + '/auth?token=' + env.BOAT_VIDEO_MEDIA_AUTH_TOKEN;
  const auth = (body, changes = {}) => f.call(route, { method: 'POST', origin: null, body, ...changes });
  assert.equal((await auth(callback())).status, 204);
  assert.deepEqual(f.calls[0], { method: 'POST', route: '/video-auth/boat-01', body: { username: 'camera-one', password: 'camera-only-test' } });
  assert.equal((await auth(callback({ password: 'wrong-password' }))).status, 403);
  const count = f.calls.length;
  for (const changes of [{ protocol: 'rtsp' }, { action: 'playback' }, { path: 'boats/+' }, { user: 'bad user' }, { password: 'short' }, { ip: 'hostname.test' }]) assert.equal((await auth(callback(changes))).status, 403);
  for (const changed of [route.replace('a'.repeat(64), 'c'.repeat(64)), route + '&token=' + env.BOAT_VIDEO_MEDIA_AUTH_TOKEN, route + '&next=bad']) assert.equal((await f.call(changed, { method: 'POST', origin: null, body: callback() })).status, 403);
  assert.equal((await auth(callback(), { origin: ORIGIN })).status, 403); assert.equal((await f.call(route, { origin: null })).status, 403);
  assert.equal(f.calls.length, count);
});

test('MediaMTX read callbacks only authorize the loopback internal reader and never accept a public publisher password', async t => {
  const f = await fixture(t), route = BASE + '/auth?token=' + env.BOAT_VIDEO_MEDIA_AUTH_TOKEN;
  const body = callback({ action: 'read', protocol: 'webrtc', user: READER, password: env.BOAT_VIDEO_MEDIA_READER_PASSWORD, ip: '127.0.0.1' });
  const auth = changes => f.call(route, { method: 'POST', origin: null, body: { ...body, ...changes } });
  assert.equal((await auth({})).status, 204);
  for (const changes of [{ ip: '192.0.2.3' }, { user: 'camera-one', password: 'camera-only-test' }, { password: 'wrong-internal' }, { action: 'publish' }]) assert.equal((await auth(changes)).status, 403);
  assert.equal(f.calls.length, 0);
});

test('recording control and playback callbacks require opt-in and loopback internal credentials', async t => {
  const f = await fixture(t, { env: { BOAT_VIDEO_RECORDING_ENABLED: '1' }, videoRecordingOptions: {} });
  const route = BASE + '/auth?token=' + env.BOAT_VIDEO_MEDIA_AUTH_TOKEN;
  const body = { user: READER, password: env.BOAT_VIDEO_MEDIA_READER_PASSWORD, ip: '127.0.0.1', action: 'api', protocol: '', path: '' };
  const auth = changes => f.call(route, { method: 'POST', origin: null, body: { ...body, ...changes } });
  assert.equal((await auth({})).status, 204);
  assert.equal((await auth({ action: 'playback', path: '__boatrec_' + 'c'.repeat(32) })).status, 204);
  assert.equal((await auth({ action: 'playback', path: 'boat-01' })).status, 204);
  for (const changes of [{ ip: '192.0.2.3' }, { password: 'wrong-internal' }, { user: 'camera-one', password: 'camera-only-test' },
    { path: 'boat-01' }, { action: 'metrics' }, { action: 'playback', path: '../secret' }, { action: 'playback', path: 'boat-01', protocol: 'srt' }]) {
    assert.equal((await auth(changes)).status, 403);
  }
  const disabled = await fixture(t);
  assert.equal((await disabled.call(route, { method: 'POST', origin: null, body })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('MediaMTX publish callback throttling bounds root helper password work per sender and concurrent requests', async t => {
  const f = await fixture(t), route = BASE + '/auth?token=' + env.BOAT_VIDEO_MEDIA_AUTH_TOKEN;
  for (let index = 0; index < 30; index++) assert.equal((await f.call(route, { method: 'POST', origin: null, body: callback() })).status, 204);
  assert.equal((await f.call(route, { method: 'POST', origin: null, body: callback() })).status, 403); assert.equal(f.calls.length, 30);
  f.advance(60001); assert.equal((await f.call(route, { method: 'POST', origin: null, body: callback() })).status, 204);
  let release, started, received = 0; const began = new Promise(resolve => started = resolve), held = new Promise(resolve => release = resolve);
  const g = await fixture(t, { client: async () => { if (++received === 8) started(); await held; return { authorized: true }; } });
  const pending = Array.from({ length: 8 }, () => g.call(route, { method: 'POST', origin: null, body: callback() }));
  await began;
  assert.equal((await g.call(route, { method: 'POST', origin: null, body: callback() })).status, 403); release();
  assert.deepEqual((await Promise.all(pending)).map(item => item.status), Array(8).fill(204));
});

test('loopback media transport bounds response size and masks connection failures', async t => {
  let mode = 'success'; const server = http.createServer((req, res) => {
    req.resume(); if (mode === 'timeout') return;
    res.writeHead(201, { 'Content-Type': 'application/sdp' }); res.end(mode === 'large' ? 'x'.repeat(65537) : OFFER);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const transport = createMediaTransport({ port: server.address().port, timeoutMs: 75 });
  assert.equal((await transport({ method: 'POST', path: '/boat-01/whep', body: Buffer.from(OFFER) })).status, 201);
  mode = 'large'; await assert.rejects(transport({ method: 'GET', path: '/boat-01/whep' }), fault => fault.status === 502);
  mode = 'timeout'; await assert.rejects(transport({ method: 'GET', path: '/boat-01/whep' }), fault => fault.status === 504);
});
