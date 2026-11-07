'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createServer } = require('../server');
const { PREFIX, resolveGamepadHapticsFile } = require('../server/gamepad-haptics-api');
const ORIGIN = 'https://haptics.test';
function request(port, route, { method = 'GET', body, raw, cookie, origin = ORIGIN, headers = {} } = {}) {
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const raw = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, raw, data }); });
    }); req.on('error', reject); req.end(payload);
  });
}
async function fixture(t, { env: extra = {}, beforeBoot } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-haptics-')), file = path.join(directory, 'state/gamepad-haptics.json');
  const env = { BOAT_ACCOUNTS_ENABLED: '1', BOAT_ADMIN_USERNAME: 'admin', BOAT_ADMIN_PASSWORD: 'haptics-test-password', BOAT_GUEST_USERNAME: 'guest', BOAT_GUEST_PASSWORD: 'haptics-guest-test', BOAT_ACCOUNTS_ORIGIN: ORIGIN, BOAT_ACCOUNTS_FILE: path.join(directory, 'accounts.json'), ...extra };
  let server;
  const boot = async () => { server = createServer({ env, gamepadHapticsOptions: { file, bodyTimeoutMs: 100 }, mapOptions: { file: path.join(directory, 'map.json') }, driverLayoutOptions: { file: path.join(directory, 'layout.json') } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); };
  if (beforeBoot) beforeBoot({ directory, file }); await boot();
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir())); assert.match(path.basename(directory), /^boat-haptics-/); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (route, options) => request(server.address().port, route, options);
  return { file, directory, call, get server() { return server; }, async restart() { if (server.listening) await new Promise(resolve => server.close(resolve)); await boot(); },
    async login(username = 'admin', password = username === 'admin' ? 'haptics-test-password' : 'haptics-guest-test') { const result = await call('/api/auth/login', { method: 'POST', body: { username, password } }); assert.equal(result.status, 200, result.raw); return result.headers['set-cookie'][0].split(';')[0]; },
    save: (cookie, revision = 0, enabled = false, attitudeThresholdDegrees = 25) => call(PREFIX, { method: 'PUT', cookie, body: { revision, enabled, attitudeThresholdDegrees } }) };
}
test('震动设置登录、角色和同源限制：管理员可写，驾驶员可读，访客与匿名拒绝', async t => {
  const f = await fixture(t); assert.equal((await f.call(PREFIX)).status, 401);
  const admin = await f.login(), guest = await f.login('guest');
  assert.equal((await f.call('/api/auth/users', { method: 'POST', cookie: admin, body: { username: 'pilot', password: 'haptics-pilot-test', role: 'driver' } })).status, 201);
  const pilot = await f.login('pilot', 'haptics-pilot-test');
  assert.equal((await f.call(PREFIX, { cookie: pilot })).status, 200); assert.equal((await f.save(pilot)).status, 403);
  assert.equal((await f.call(PREFIX, { cookie: guest })).status, 403); assert.equal((await f.save(guest)).status, 403);
  for (const origin of [null, 'https://evil.test']) assert.equal((await f.call(PREFIX, { method: 'PUT', cookie: admin, origin, body: { revision: 0, enabled: true, attitudeThresholdDegrees: 10 } })).status, 403);
  const disabled = await fixture(t, { env: { BOAT_ACCOUNTS_ENABLED: '0' } }); assert.equal((await disabled.call(PREFIX)).status, 503);
});
test('默认开启和10度阈值；保存、重启持久化及并发版本冲突', async t => {
  const f = await fixture(t), admin = await f.login(), defaults = await f.call(PREFIX, { cookie: admin });
  assert.equal(defaults.data.enabled, true); assert.equal(defaults.data.attitudeThresholdDegrees, 10); assert.equal(defaults.headers['cache-control'], 'no-store');
  const saved = await f.save(admin); assert.equal(saved.status, 200, saved.raw); assert.equal(saved.data.enabled, false);
  const original = fs.readFileSync(f.file, 'utf8'); assert.equal((await f.save(admin)).status, 409); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  await f.restart(); const owner = await f.login(), current = await f.call(PREFIX, { cookie: owner }); assert.deepEqual(current.data, saved.data);
  assert.equal((await f.save(owner, 1, true, 8)).status, 200); assert.equal(f.server.boatGamepadHapticsApi.snapshot().attitudeThresholdDegrees, 8);
});
test('拒绝非法开关、阈值、额外字段、请求类型及大包，配置不会被污染', async t => {
  const f = await fixture(t), admin = await f.login();
  const valid = { revision: 0, enabled: true, attitudeThresholdDegrees: 10 };
  for (const body of [{ ...valid, enabled: 1 }, ...[0, 91, 2.5, '10', null].map(attitudeThresholdDegrees => ({ ...valid, attitudeThresholdDegrees })), { ...valid, leaseId: 'forbidden' }, { ...valid, revision: -1 }, null, []]) {
    assert.equal((await f.call(PREFIX, { method: 'PUT', cookie: admin, body })).status, 400);
  }
  assert.equal((await f.call(PREFIX, { method: 'PUT', cookie: admin, raw: '{' })).status, 400);
  assert.equal((await f.call(PREFIX, { method: 'PUT', cookie: admin, raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.call(PREFIX, { method: 'PUT', cookie: admin, raw: 'x'.repeat(3000) })).status, 413);
  assert.equal((await f.call(PREFIX, { method: 'DELETE', cookie: admin })).status, 405);
  assert.equal((await f.call(PREFIX + '/unknown', { cookie: admin })).status, 404); assert.equal(fs.existsSync(f.file), false);
});
test('写入失败保留旧配置；损坏文件不泄露内容并停用震动，管理员可恢复', async t => {
  const f = await fixture(t, { beforeBoot: ({ file }) => fs.writeFileSync(path.dirname(file), 'blocked') }), admin = await f.login();
  assert.equal((await f.save(admin)).status, 503); assert.equal(f.server.boatGamepadHapticsApi.snapshot().enabled, true);
  fs.unlinkSync(path.dirname(f.file)); assert.equal((await f.save(admin)).status, 200);
  await new Promise(resolve => f.server.close(resolve)); fs.writeFileSync(f.file, '{"secret":"not-for-browser"}'); await f.restart();
  const owner = await f.login(), broken = await f.call(PREFIX, { cookie: owner }); assert.equal(broken.data.enabled, false); assert.match(broken.data.error, /无法读取/); assert.doesNotMatch(broken.raw, /not-for-browser/);
  assert.equal((await f.save(owner, 0, true, 15)).status, 200); assert.equal(f.server.boatGamepadHapticsApi.snapshot().error, null);
});
test('落盘期间退出管理员会话不发布，清除临时文件', async t => {
  const f = await fixture(t), admin = await f.login(); let entered, release;
  const reached = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve), original = fs.promises.open;
  fs.promises.open = async function(file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (typeof file === 'string' && file.startsWith(path.join(path.dirname(f.file), '.gamepad-haptics.'))) { const sync = handle.sync.bind(handle); handle.sync = async () => { entered(); await gate; return sync(); }; }
    return handle;
  };
  try { const saving = f.save(admin); await reached; await f.call('/api/auth/session', { method: 'DELETE', cookie: admin }); release(); assert.equal((await saving).status, 401); }
  finally { release(); fs.promises.open = original; }
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual(fs.readdirSync(path.dirname(f.file)), []);
});
test('震动配置目录独立于源码，支持更新组件与systemd持久状态目录', () => {
  const state = path.resolve('haptic-state');
  assert.equal(resolveGamepadHapticsFile({ BOAT_UPDATE_ENABLED: '1', BOAT_UPDATE_STATE_DIR: state }), path.join(state, 'requests/gamepad-haptics.json'));
  assert.equal(resolveGamepadHapticsFile({ STATE_DIRECTORY: state }), path.join(state, 'gamepad-haptics.json'));
  assert.equal(resolveGamepadHapticsFile({ BOAT_GAMEPAD_HAPTICS_FILE: path.join(state, 'custom.json') }), path.join(state, 'custom.json'));
  assert.throws(() => resolveGamepadHapticsFile({}, 'relative.json'));
});
