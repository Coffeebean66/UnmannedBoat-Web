/* MP3 文件持久化、三角色权限、广播生命周期及与麦克风的互斥。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createCameraControlApi } = require('../server/camera-control-api');
const { createCameraAudioStore, MAX_BYTES } = require('../server/camera-audio-store');
const ORIGIN = 'https://audio.test', LIBRARY = '/api/video/camera/audio-files', BOAT = '/api/video/camera/boats/boat-01/audio';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await pause(5); assert.ok(predicate(), '异步清理应完成'); }
async function fixture(t, options = {}) {
  const output = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'camera-audio-api-')), calls = [], workers = [], listeners = new Set(), agent = new http.Agent({ keepAlive: true }); let time = 100000;
  const users = Object.fromEntries(['admin', 'driver', 'other', 'guest'].map(key => [key, { role: key === 'other' ? 'driver' : key }]));
  const accounts = { enabled: true, sessionFor(req) { const key = req.headers.cookie; return users[key] ? { key, value: users[key] } : null; }, isActive(owner) { return !!owner && users[owner.key] === owner.value; }, sameOrigin: req => req.headers.origin === ORIGIN, onInvalidate(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const bindings = new Map([['boat-01', { deviceId: 'cam-01', channelId: 'channel-01', revision: 1 }], ['boat-02', { deviceId: 'cam-01', channelId: 'channel-01', revision: 1 }], ['boat-03', { deviceId: 'cam-02', channelId: 'channel-02', revision: 1 }]]);
  const tools = { async available() { return options.available !== false; }, async probe(file) { if (options.probe) return options.probe(file); if (fs.readFileSync(file, 'utf8') !== 'MP3-fixture') throw Object.assign(Error('文件不是可解码的 MP3 音频'), { status: 400 }); return { duration: 12 }; },
    play(file, url, { signal, volume }) {
      assert.equal(fs.readFileSync(file, 'utf8'), 'MP3-fixture'); assert.match(url, /^rtsp:\/\/127\.0\.0\.1/);
      let resolveReady, rejectReady, resolveDone, stopped = false;
      const worker = { volume, setVolume(value) { worker.volume = value; calls.push(['volume', value]); }, ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }), done: new Promise(resolve => { resolveDone = resolve; }), begin: () => resolveReady(), finish(code = 0) { resolveDone({ code }); }, async stop() { if (!stopped) { stopped = true; rejectReady(Object.assign(Error('音频已取消'), { status: 409 })); resolveDone({ code: -1, stopped: true }); calls.push(['worker-stop']); } return worker.done; } };
      signal.addEventListener('abort', () => worker.stop(), { once: true }); workers.push(worker);
      if (options.short) { resolveReady(); resolveDone({ code: 0 }); } else if (!options.delayed) resolveReady(); return worker;
    } };
  const wvp = { async voiceAvailable() { return true; }, async talkStart(...args) { calls.push(['start', ...args]); await options.talkStart?.(...args); return { push: { app: 'broadcast', stream: 'fixture' } }; }, async broadcastPublishUrl() { return 'rtsp://127.0.0.1:10004/broadcast/fixture?sign=private'; }, async talkStop(...args) { calls.push(['stop', ...args]); }, close() {} };
  const api = createCameraControlApi({ env: { BOAT_VIDEO_MEDIA_ENABLED: '1', BOAT_VIDEO_WVP_ENABLED: '1', BOAT_VIDEO_WVP_USERNAME: 'test', BOAT_VIDEO_WVP_PASSWORD_MD5: 'a'.repeat(32) }, accounts, sources: { enabled: true, cameraBinding: id => bindings.get(id) }, wvp, now: () => time, sweepMs: 60000, audioOptions: { directory, tools, uploadTimeoutMs: options.uploadTimeoutMs } });
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, ORIGIN))); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  function request(route, { method = 'GET', user = 'driver', origin = ORIGIN, body, raw, name, headers = {}, hold = false } = {}) {
    let req;
    const result = new Promise((resolve, reject) => {
      req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method, agent, headers: { ...(user ? { Cookie: user } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : raw !== undefined ? { 'Content-Type': 'audio/mpeg', 'X-Audio-Name': encodeURIComponent(name || '提示.mp3') } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, data, text }); });
      }); req.on('error', reject); const content = body ? JSON.stringify(body) : raw; hold ? req.write(content || '') : req.end(content);
    });
    return Object.assign(result, { abort: () => req.destroy() });
  }
  const upload = (more = {}) => request(LIBRARY, { method: 'POST', user: 'admin', raw: 'MP3-fixture', ...more });
  const start = (id, route = BOAT, more = {}) => request(route, { method: 'POST', body: { fileId: id }, ...more });
  t.after(async () => { await api.close(); agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return { api, request, upload, start, calls, workers, directory, bindings, tools, advance(ms) { time += ms; }, revoke(key) { delete users[key]; for (const fn of listeners) fn(key); } };
}
test('MP3 音频库：仅管理员上传删除，驾驶员可读取，游客/未登录/跨站被拒绝', async t => {
  const f = await fixture(t);
  for (const [options, status] of [[{ user: '' }, 401], [{ user: 'guest' }, 403], [{ origin: 'https://other.test' }, 403]]) assert.equal((await f.request(LIBRARY, options)).status, status);
  assert.equal((await f.upload({ user: 'driver' })).status, 403);
  const uploaded = await f.upload(); assert.equal(uploaded.status, 201, uploaded.text); const file = uploaded.data.file;
  assert.match(file.id, /^[a-f0-9]{32}$/); assert.equal(file.name, '提示.mp3'); assert.equal(file.uploadedAt, 100000);
  const listed = await f.request(LIBRARY, { origin: null }); assert.equal(listed.status, 200); assert.equal(listed.data.canManage, false); assert.equal(listed.data.files.length, 1); assert.doesNotMatch(listed.text, /rtsp:|private|\.test-output/);
  assert.equal((await f.request(LIBRARY + '/' + file.id, { method: 'DELETE' })).status, 403);
  const reopened = createCameraAudioStore({ directory: f.directory, tools: f.tools }); assert.deepEqual(reopened.list(), [file]); const lease = reopened.acquire(file.id); assert.equal(fs.readFileSync(lease.file, 'utf8'), 'MP3-fixture'); lease.release(); await reopened.close();
  assert.equal((await f.request(LIBRARY + '/' + file.id, { method: 'DELETE', user: 'admin' })).status, 200);
  assert.deepEqual((await f.request(LIBRARY)).data.files, []); assert.deepEqual(fs.readdirSync(f.directory), ['index.json']);
});
test('上传校验真实格式、扩展名、内容类型、体积和路径，失败不留下文件或索引', async t => {
  const f = await fixture(t);
  for (const [options, status] of [[{ raw: 'not MP3' }, 400], [{ raw: '' }, 400], [{ name: '../a.mp3' }, 400], [{ name: 'a.wav' }, 400], [{ headers: { 'Content-Type': 'audio/wav' } }, 415]]) assert.equal((await f.upload(options)).status, status, JSON.stringify(options));
  const oversized = Buffer.alloc(MAX_BYTES + 1, 1); assert.equal((await f.upload({ raw: oversized, headers: { 'Content-Length': oversized.length } })).status, 413);
  assert.equal((await f.upload({ raw: oversized })).status, 413, '分块上传也受服务端体积限制');
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal((await f.request(LIBRARY + '/../secret')).status, 404);
  assert.equal((await f.start('../bad')).status, 400); assert.equal((await f.start('a'.repeat(32))).status, 404);
});
test('上传中断、超时与注销均回收临时文件；关闭后不会提交上传', async t => {
  const f = await fixture(t, { uploadTimeoutMs: 60 });
  const slow = f.upload({ hold: true }); const result = await slow; assert.equal(result.status, 408, result.text); slow.abort(); assert.deepEqual(fs.readdirSync(f.directory), []);
  const aborted = f.upload({ hold: true }); aborted.catch(() => {}); await until(() => fs.readdirSync(f.directory).length > 0); aborted.abort(); await until(() => fs.readdirSync(f.directory).length === 0);
  const interrupted = f.upload({ hold: true }); interrupted.catch(() => {}); await until(() => fs.readdirSync(f.directory).length > 0); await f.api.close(); interrupted.abort(); assert.deepEqual(fs.readdirSync(f.directory), []);
  let release; const g = await fixture(t, { probe: () => new Promise(resolve => { release = resolve; }) }); const pending = g.upload(); await until(() => !!release); g.revoke('admin'); release({ duration: 12 }); assert.equal((await pending).status, 401); assert.deepEqual(fs.readdirSync(g.directory), []);
});
test('播放一次并自动回收广播；播放期间不可删文件，无浏览器心跳仍继续', async t => {
  const f = await fixture(t), file = (await f.upload()).data.file;
  const started = await f.start(file.id); assert.equal(started.status, 201, started.text); assert.equal(started.data.playback.status, 'playing'); assert.doesNotMatch(started.text, /rtsp:|sign=|private/);
  f.advance(8000); f.api.sweep(); assert.equal((await f.request(BOAT)).data.playback.status, 'playing');
  assert.equal((await f.request(LIBRARY + '/' + file.id, { method: 'DELETE', user: 'admin' })).status, 409);
  f.workers[0].finish(); await until(() => f.calls.some(row => row[0] === 'stop'));
  const done = (await f.request(BOAT)).data; assert.equal(done.voiceBusy, false); assert.equal(done.playback.status, 'completed');
  assert.equal((await f.request(LIBRARY + '/' + file.id, { method: 'DELETE', user: 'admin' })).status, 200);
});
test('同一物理摄像头文件和麦克风互斥，另一摄像头可并行；仅本人或管理员可停止', async t => {
  const f = await fixture(t), file = (await f.upload()).data.file;
  await f.start(file.id);
  assert.equal((await f.start(file.id, '/api/video/camera/boats/boat-02/audio', { user: 'other' })).status, 409);
  assert.equal((await f.request('/api/video/camera/boats/boat-02/talk', { method: 'POST', body: { mode: 'broadcast' } })).status, 409);
  assert.equal((await f.start(file.id, '/api/video/camera/boats/boat-03/audio', { user: 'other' })).status, 201);
  assert.equal((await f.request(BOAT, { method: 'DELETE', user: 'other' })).status, 403);
  assert.equal((await f.request(BOAT, { method: 'DELETE', user: 'admin' })).data.playback.status, 'stopped');
  const talk = await f.request('/api/video/camera/boats/boat-01/talk', { method: 'POST', body: { mode: 'broadcast' } }); assert.equal(talk.status, 201);
  assert.equal((await f.start(file.id)).status, 409); assert.equal((await f.request(BOAT, { method: 'DELETE', user: 'admin' })).status, 409);
  assert.equal((await f.request('/api/video/camera/boats/boat-01/talk/' + talk.data.id, { method: 'DELETE' })).status, 200);
});
test('播放准备期间可停止；迟到的 WVP 响应被释放且不会启动 FFmpeg', async t => {
  let release; const f = await fixture(t, { talkStart: () => new Promise(resolve => { release = resolve; }) }), file = (await f.upload()).data.file;
  const pending = f.start(file.id); await until(() => !!release);
  assert.equal((await f.request(BOAT)).data.playback.status, 'preparing');
  const stopped = f.request(BOAT, { method: 'DELETE' }); await pause(10); release();
  assert.equal((await pending).status, 409); assert.equal((await stopped).data.playback.status, 'stopped'); assert.equal(f.workers.length, 0); assert.equal(f.calls.filter(row => row[0] === 'stop').length, 1);
});
test('准备期间取消 HTTP 请求会终止 FFmpeg；超短 MP3 正常结束仍返回成功', async t => {
  const f = await fixture(t, { delayed: true }), file = (await f.upload()).data.file;
  const pending = f.start(file.id); pending.catch(() => {}); await until(() => f.workers.length > 0); pending.abort(); await until(() => f.calls.some(row => row[0] === 'stop'));
  assert.equal((await f.request(BOAT)).data.voiceBusy, false);
  const g = await fixture(t, { short: true }), short = (await g.upload()).data.file;
  const started = await g.start(short.id); assert.equal(started.status, 201, started.text); await until(() => g.calls.some(row => row[0] === 'stop')); assert.equal((await g.request(BOAT)).data.playback.status, 'completed');
});
test('广播异常、会话失效、改绑、播放超时与服务关闭均停止并释放文件引用', async t => {
  for (const reason of ['failure', 'logout', 'binding', 'timeout', 'close']) {
    const f = await fixture(t), file = (await f.upload()).data.file; await f.start(file.id);
    if (reason === 'failure') f.workers[0].finish(1);
    if (reason === 'logout') f.revoke('driver');
    if (reason === 'binding') { f.bindings.get('boat-01').revision++; f.api.sweep(); }
    if (reason === 'timeout') { f.advance(43000); f.api.sweep(); }
    if (reason === 'close') await f.api.close();
    await until(() => f.calls.some(row => row[0] === 'stop'));
    if (reason !== 'close') assert.equal((await f.request(LIBRARY + '/' + file.id, { user: 'admin', method: 'DELETE' })).status, 200, reason);
  }
});
test('FFmpeg 缺失会显示安装提示，WVP 失败不留下占用，后续可重试', async t => {
  const f = await fixture(t, { available: false }); assert.equal((await f.request(LIBRARY)).data.available, false); assert.equal((await f.start('a'.repeat(32))).status, 503);
  let fail = true; const g = await fixture(t, { talkStart: () => { if (fail) throw Error('private server failure'); } }), file = (await g.upload()).data.file;
  const result = await g.start(file.id); assert.equal(result.status, 503); assert.doesNotMatch(result.text, /private server failure/); assert.equal((await g.request(BOAT)).data.voiceBusy, false);
  fail = false; assert.equal((await g.start(file.id)).status, 201);
});

test('播报使用初始音量，播放中可静音及恢复；音量边界与类型在服务器验证', async t => {
  const f = await fixture(t), file = (await f.upload()).data.file;
  for (const volume of [-1, 101, 0.5, '50', null]) assert.equal((await f.request(BOAT, { method: 'POST', body: { fileId: file.id, volume } })).status, 400);
  const created = await f.request(BOAT, { method: 'POST', body: { fileId: file.id, volume: 40 } });
  assert.equal(created.status, 201); assert.equal(created.data.playback.volume, 40); assert.equal(f.workers[0].volume, 40);
  const playbackId = created.data.playback.id;
  for (const volume of [0, 1, 100, 35]) {
    const changed = await f.request(BOAT, { method: 'PATCH', body: { playbackId, volume } }); assert.equal(changed.status, 200); assert.equal(changed.data.playback.volume, volume); assert.equal(f.workers[0].volume, volume);
  }
  for (const volume of [-1, 101, 0.1, '50', null]) assert.equal((await f.request(BOAT, { method: 'PATCH', body: { playbackId, volume } })).status, 400);
  assert.equal(f.workers[0].volume, 35); assert.equal(f.calls.filter(row => row[0] === 'start').length, 1, '调音量不重新广播');
});
test('仅播放发起者或管理员能改音量；迟到请求不能修改下一次播放或另一摄像头', async t => {
  const f = await fixture(t), file = (await f.upload()).data.file, playbackId = (await f.start(file.id)).data.playback.id;
  for (const [options, status] of [[{ user: 'other' }, 403], [{ user: 'guest' }, 403], [{ user: '' }, 401], [{ origin: 'https://other.test' }, 403]]) assert.equal((await f.request(BOAT, { method: 'PATCH', body: { playbackId, volume: 20 }, ...options })).status, status);
  assert.equal((await f.request(BOAT, { user: 'admin', method: 'PATCH', body: { playbackId, volume: 10 } })).status, 200);
  assert.equal((await f.request('/api/video/camera/boats/boat-03/audio', { method: 'PATCH', body: { playbackId, volume: 10 } })).status, 409);
  await f.request(BOAT, { method: 'DELETE' }); await f.start(file.id);
  assert.equal((await f.request(BOAT, { method: 'PATCH', body: { playbackId, volume: 10 } })).status, 409); assert.equal(f.workers[1].volume, 100);
});
test('准备期间调整音量会应用到迟到的播放器，取消后不能继续调整', async t => {
  let release; const f = await fixture(t, { talkStart: () => new Promise(resolve => { release = resolve; }) }), file = (await f.upload()).data.file;
  const pending = f.start(file.id); await until(() => !!release); const playbackId = (await f.request(BOAT)).data.playback.id;
  assert.equal((await f.request(BOAT, { method: 'PATCH', body: { playbackId, volume: 0 } })).status, 200); release();
  assert.equal((await pending).data.playback.volume, 0); assert.equal(f.workers[0].volume, 0);
  await f.request(BOAT, { method: 'DELETE' }); assert.equal((await f.request(BOAT, { method: 'PATCH', body: { playbackId, volume: 80 } })).status, 409);
});
