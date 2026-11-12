/* 三角色权限、云台松键竞态、租约与语音资源清理。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { createCameraControlApi, validateAudioOffer } = require('../server/camera-control-api');
const ORIGIN = 'https://camera.test', BASE = '/api/video/camera/boats/';
const SDP = direction => 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=rtpmap:8 PCMA/8000\r\na=' + (direction === 'push' ? 'sendonly' : 'recvonly') + '\r\n';
const env = { BOAT_VIDEO_MEDIA_ENABLED: '1', BOAT_VIDEO_WVP_ENABLED: '1', BOAT_VIDEO_WVP_USERNAME: 'admin', BOAT_VIDEO_WVP_PASSWORD_MD5: 'a'.repeat(32) };
const motion = (command = 'left', sequence = 1, leaseId = 'a'.repeat(32)) => ({ command, sequence, leaseId, speed: 100, zoomSpeed: 4 });
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 3)); assert.ok(predicate(), '异步操作应完成'); }
async function fixture(t, options = {}) {
  let time = 100000, next = 0;
  const credentials = { admin: { role: 'admin' }, driver: { role: 'driver' }, other: { role: 'driver' }, guest: { role: 'guest' } }, listeners = new Set();
  const accounts = { enabled: true, sessionFor(req) { const key = req.headers.cookie; return credentials[key] ? { key, value: credentials[key] } : null; }, isActive(owner) { return !!owner && credentials[owner.key] === owner.value; }, sameOrigin: req => req.headers.origin === ORIGIN, onInvalidate(callback) { listeners.add(callback); return () => listeners.delete(callback); } };
  const bindings = new Map([['boat-01', { deviceId: 'cam-01', channelId: 'channel-01', revision: 1 }], ['boat-02', { deviceId: 'cam-01', channelId: 'channel-01', revision: 1 }], ['boat-03', { deviceId: 'cam-02', channelId: 'channel-02', revision: 2 }]]);
  const calls = [];
  const wvp = { async voiceAvailable() { return options.voice !== false; },
    async ptz(...args) { calls.push(['ptz', ...args]); if (options.ptz) await options.ptz(...args); },
    async talkStart(...args) { calls.push(['start', ...args]); return { push: { app: args[2], stream: 'camera-stream' }, play: args[2] === 'talk' ? { app: 'talk', stream: 'camera-stream_talk' } : null }; },
    async openAudio(...args) { calls.push(['open', args[1]]); if (options.openAudio) await options.openAudio(...args); return { resource: '/private/' + args[1] + '/' + ++next, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\n' }; },
    async closeAudio(resource) { calls.push(['close', resource]); }, async talkStop(...args) { calls.push(['stop', ...args]); }, close() {} };
  const api = createCameraControlApi({ env, accounts, sources: { enabled: true, cameraBinding: id => bindings.get(id) || null }, wvp, now: () => time, sweepMs: 60000 });
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, ORIGIN)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = (boat, route = '', { method = 'GET', user = 'driver', origin = ORIGIN, body, sdp, type } = {}) => new Promise((resolve, reject) => {
    const content = body === undefined ? sdp : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: BASE + boat + route, method, headers: { ...(user ? { Cookie: user } : {}), ...(origin ? { Origin: origin } : {}), ...(content === undefined ? {} : { 'Content-Type': type || (sdp === undefined ? 'application/json' : 'application/sdp') }) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, data, text, headers: res.headers }); });
    }); req.on('error', reject); req.end(content);
  });
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { api, call, calls, bindings, advance(ms) { time += ms; }, revoke(user) { delete credentials[user]; for (const listener of listeners) listener(user); } };
}
test('管理员与驾驶员可操作摄像头，访客、未登录及跨站请求被拒绝，不要求单片机在线', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('boat-01', '', { user: '' })).status, 401);
  assert.equal((await f.call('boat-01', '', { user: 'guest' })).status, 403);
  assert.equal((await f.call('boat-01', '', { origin: 'https://other.test' })).status, 403);
  for (const user of ['admin', 'driver']) { const value = await f.call('boat-01', '', { user }); assert.equal(value.status, 200); assert.equal(value.data.voice, true); }
  assert.equal((await f.call('direct-boat')).data.enabled, false);
  assert.equal((await f.call('boat-01', '/ptz', { method: 'POST', body: motion(), type: 'application/json-bad' })).status, 415);
  assert.deepEqual(f.calls, []);
});
test('云台共享摄像头互斥，松键停止并拒绝晚到的旧指令，另一摄像头独立控制', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('boat-01', '/ptz', { method: 'POST', body: motion() })).status, 200);
  assert.equal((await f.call('boat-02', '/ptz', { method: 'POST', user: 'other', body: motion('right', 1, 'b'.repeat(32)) })).status, 409);
  assert.equal((await f.call('boat-03', '/ptz', { method: 'POST', user: 'other', body: motion('up', 1, 'c'.repeat(32)) })).status, 200);
  const stop = await f.call('boat-01', '/ptz', { method: 'POST', body: motion('stop', 2) }); assert.equal(stop.data.stopped, true);
  assert.equal((await f.call('boat-01', '/ptz', { method: 'POST', body: motion('left', 3) })).status, 409);
  assert.deepEqual(f.calls.filter(call => call[1] === 'cam-01').map(call => call[3]), ['left', 'stop']);
  for (const changes of [{ command: 'unsafe' }, { speed: 256 }, { speed: '100' }, { zoomSpeed: 16 }, { sequence: 0 }]) assert.equal((await f.call('boat-01', '/ptz', { method: 'POST', body: { ...motion(), ...changes } })).status, 400);
});
test('停止先到时不执行后到的移动；停止与正在发送的移动按顺序落到设备', async t => {
  let release; const f = await fixture(t, { ptz: async (_device, _channel, command) => { if (command === 'left') await new Promise(resolve => { release = resolve; }); } });
  assert.equal((await f.call('boat-01', '/ptz', { method: 'POST', body: motion('stop', 2) })).status, 200);
  assert.equal((await f.call('boat-01', '/ptz', { method: 'POST', body: motion() })).status, 409); assert.deepEqual(f.calls, []);
  const start = f.call('boat-01', '/ptz', { method: 'POST', body: motion('left', 1, 'b'.repeat(32)) }); await until(() => !!release);
  const stop = f.call('boat-01', '/ptz', { method: 'POST', body: motion('stop', 2, 'b'.repeat(32)) }); await new Promise(resolve => setTimeout(resolve, 10));
  release(); await Promise.all([start, stop]); assert.deepEqual(f.calls.map(call => call[3]), ['left', 'stop']);
});
test('按键失联、改绑摄像头与注销均停止云台；停止失败持续重试', async t => {
  let fail = true; const f = await fixture(t, { ptz: async (_d, _c, command) => { if (command === 'stop' && fail) { fail = false; throw Error('network'); } } });
  await f.call('boat-01', '/ptz', { method: 'POST', body: motion() });
  f.advance(1500); f.api.sweep(); await until(() => !fail);
  f.advance(1100); f.api.sweep(); await until(() => f.calls.filter(call => call[3] === 'stop').length === 2);
  await f.call('boat-01', '/ptz', { method: 'POST', body: motion('up', 1, 'b'.repeat(32)) }); f.bindings.set('boat-01', { deviceId: 'new-cam', channelId: 'new-channel', revision: 2 }); f.api.sweep();
  await until(() => f.calls.filter(call => call[3] === 'stop').length === 3); assert.equal(f.calls.at(-1)[1], 'cam-01');
  await f.call('boat-03', '/ptz', { method: 'POST', body: motion('right', 1, 'c'.repeat(32)) }); f.revoke('driver'); await until(() => f.calls.filter(call => call[3] === 'stop').length === 4);
});
test('语音双向 SDP、跨窗口互斥、心跳和租约到期清理两个媒体会话', async t => {
  const f = await fixture(t), created = await f.call('boat-01', '/talk', { method: 'POST', body: { mode: 'talk' } });
  assert.equal(created.status, 201); const route = '/talk/' + created.data.id;
  assert.doesNotMatch(created.text, /private|secret|rtsp:|camera-stream|cam-01/);
  assert.equal((await f.call('boat-02', '/talk', { method: 'POST', user: 'other', body: { mode: 'talk' } })).status, 409);
  assert.equal((await f.call('boat-01', route + '/heartbeat', { method: 'POST', user: 'other' })).status, 404);
  for (const direction of ['push', 'play']) { const response = await f.call('boat-01', route + '/' + direction, { method: 'POST', sdp: SDP(direction) }); assert.equal(response.status, 201, response.text); assert.equal(response.headers['content-type'], 'application/sdp'); }
  f.advance(6000); assert.equal((await f.call('boat-01', route + '/heartbeat', { method: 'POST' })).status, 200); f.advance(2000); f.api.sweep(); assert.equal(f.calls.filter(call => call[0] === 'close').length, 0);
  f.advance(5100); f.api.sweep(); await until(() => f.calls.some(call => call[0] === 'stop'));
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 2); assert.equal((await f.call('boat-01', route, { method: 'DELETE' })).status, 200);
});
test('对讲协商返回较晚时，注销仍关闭刚创建的媒体会话；改绑后不继续向旧摄像头发送', async t => {
  let release; const f = await fixture(t, { openAudio: async () => new Promise(resolve => { release = resolve; }) });
  const created = await f.call('boat-01', '/talk', { method: 'POST', body: { mode: 'talk' } });
  const response = f.call('boat-01', '/talk/' + created.data.id + '/push', { method: 'POST', sdp: SDP('push') }); await until(() => !!release);
  f.revoke('driver'); release(); assert.equal((await response).status, 409); await until(() => f.calls.some(call => call[0] === 'close')); assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
});
test('单向喊话只发布麦克风；未启用 WebRTC 时云台仍可用，异常 SDP 不会到达媒体服务', async t => {
  const f = await fixture(t), created = await f.call('boat-01', '/talk', { method: 'POST', body: { mode: 'broadcast' } }); const route = '/talk/' + created.data.id;
  assert.equal(created.data.canListen, false);
  assert.equal((await f.call('boat-01', route + '/play', { method: 'POST', sdp: SDP('play') })).status, 409);
  await f.call('boat-01', route, { method: 'DELETE' });
  for (const sdp of [SDP('push') + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', SDP('push').replace('PCMA/8000', 'opus/48000/2'), SDP('play')]) {
    const fresh = await f.call('boat-01', '/talk', { method: 'POST', body: { mode: 'broadcast' } });
    assert.equal((await f.call('boat-01', '/talk/' + fresh.data.id + '/push', { method: 'POST', sdp })).status, 400);
  }
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 0);
  const disabled = await fixture(t, { voice: false }); assert.equal((await disabled.call('boat-01')).data.voice, false);
  assert.equal((await disabled.call('boat-01', '/talk', { method: 'POST', body: { mode: 'talk' } })).status, 503);
  assert.equal((await disabled.call('boat-01', '/ptz', { method: 'POST', body: motion() })).status, 200);
});
test('语音 SDP 拒绝数据通道、重复音轨和错误方向', () => {
  assert.equal(validateAudioOffer(SDP('push'), 'push'), SDP('push'));
  for (const value of [SDP('push') + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n', SDP('push') + SDP('push'), 'not sdp']) assert.throws(() => validateAudioOffer(value, 'push'));
});
