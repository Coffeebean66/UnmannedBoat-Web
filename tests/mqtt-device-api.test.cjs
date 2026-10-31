/* 真实账户鉴权/HTTP 与受限 socket 客户端；不连接实船或生产 Broker。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createServer } = require('../server');
const { createMqttDeviceApi, createMqttDeviceClient, validateInput, validateVideoInput, snapshot } = require('../server/mqtt-device-api');
const ORIGIN = 'https://mqtt-admin.test', revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64);
const credentials = { admin: 'admin-only-test', guest: 'guest-only-test' };

function request(port, route, { method = 'GET', body, raw, cookie, origin = ORIGIN, headers = {} } = {}) {
  const data = raw === undefined ? body === undefined ? undefined : JSON.stringify(body) : raw;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: {
      ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
      ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...headers
    } }, res => {
      let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => {
        let data; try { data = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, data, raw, headers: res.headers });
      });
    }); req.on('error', reject); req.end(data);
  });
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-mqtt-admin-api-'));
  let time = 10000; const calls = [];
  const env = { BOAT_ACCOUNTS_ENABLED: '1', BOAT_ACCOUNTS_ORIGIN: ORIGIN, BOAT_CLOUD_PASSWORD: 'legacy-viewer-test-only',
    BOAT_ADMIN_USERNAME: 'admin', BOAT_ADMIN_PASSWORD: credentials.admin,
    BOAT_GUEST_USERNAME: 'guest', BOAT_GUEST_PASSWORD: credentials.guest, ...options.env };
  const client = options.client || (async (method, route, body) => {
    calls.push({ method, route, body: body && { ...body } });
    return { ...(method === 'PUT' ? { ok: true, requiresReconnect: true } : {}),
      devices: [{ deviceId: 'boat-01', username: body?.username || 'boat-01', password: 'must-not-leak' }],
      revision: method === 'PUT' ? nextRevision : revision, secret: 'must-not-leak' };
  });
  const cloud = new EventEmitter(); Object.assign(cloud, { enabled: true, start() {}, stop() {}, list: () => ({ brokerConnected: true, devices: [] }) });
  const server = createServer({ env, cloud, accountOptions: { storeFile: path.join(directory, 'accounts.json'), now: () => time },
    mapOptions: { file: path.join(directory, 'map.json') }, mqttAdminOptions: { client, bodyTimeoutMs: 100, ...options.mqttAdminOptions } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (route, input) => request(server.address().port, route, input);
  const login = async (username = 'admin') => {
    const result = await call('/api/auth/login', { method: 'POST', body: { username, password: credentials[username] } });
    assert.equal(result.status, 200, result.raw); return result.headers['set-cookie'][0].split(';')[0];
  };
  return { server, call, login, calls, advance: ms => time += ms };
}
const input = (values = {}) => ({ username: 'new-boat', password: 'NewPassword!123', revision, ...values });
// 等待两个请求走完当前轮的异步路由派发，再放行模拟组件。
// request 事件本身早于多层 await 的延续，不能在该事件的微任务里提前结束共享读取。
function collectionReadsArrive(server, count = 2) {
  return new Promise(resolve => {
    let received = 0;
    const observe = req => {
      if (req.url === '/api/mqtt/devices' && req.method === 'GET' && ++received === count) {
        server.removeListener('request', observe); setImmediate(resolve);
      }
    };
    server.on('request', observe);
  });
}

test('MQTT account list and mutation require a currently logged-in platform administrator', async t => {
  const f = await fixture(t), admin = await f.login(), guest = await f.login('guest');
  for (const [cookie, status] of [[undefined, 401], [guest, 403]]) {
    assert.equal((await f.call('/api/mqtt/devices', { cookie })).status, status);
    assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', body: input() })).status, status);
  }
  assert.equal(f.calls.length, 0);
  const listed = await f.call('/api/mqtt/devices', { cookie: admin, origin: null });
  assert.equal(listed.status, 200); assert.equal(listed.headers['cache-control'], 'no-store');
  assert.deepEqual(listed.data, { enabled: true, devices: [{ deviceId: 'boat-01', username: 'boat-01' }], revision, canManageVideo: false, videos: [] });
  assert.doesNotMatch(listed.raw, /password|secret|must-not-leak/);
  const changed = await f.call('/api/mqtt/devices/boat-01', { cookie: admin, method: 'PATCH', body: input() });
  assert.equal(changed.status, 200); assert.equal(changed.data.revision, nextRevision);
  assert.equal(changed.data.requiresReconnect, true); assert.doesNotMatch(changed.raw, /password|secret|must-not-leak|NewPassword/);
  assert.deepEqual(f.calls[1], { method: 'PUT', route: '/devices/boat-01', body: input() });
  const preserved = input(); delete preserved.password;
  assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie: admin, method: 'PATCH', body: preserved })).status, 200);
  assert.equal(Object.hasOwn(f.calls[2].body, 'password'), false);
});

test('MQTT management rejects cross-site access, missing write Origin, disabled accounts and methods', async t => {
  const f = await fixture(t), cookie = await f.login();
  for (const options of [{ origin: 'https://evil.test' }, { origin: null, headers: { 'sec-fetch-site': 'cross-site' } }]) {
    assert.equal((await f.call('/api/mqtt/devices', { cookie, ...options })).status, 403);
  }
  for (const origin of [null, 'https://evil.test']) assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, origin, method: 'PATCH', body: input() })).status, 403);
  assert.equal((await f.call('/api/mqtt/devices', { cookie, method: 'DELETE', body: input() })).status, 405);
  assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie })).status, 405);
  assert.equal((await f.call('/api/mqtt/devices/boat+01', { cookie, method: 'PATCH', body: input() })).status, 404);
  assert.equal(f.calls.length, 0);
  const disabled = await fixture(t, { env: { BOAT_ACCOUNTS_ENABLED: '0' } });
  assert.equal((await disabled.call('/api/mqtt/devices')).status, 503);
});

test('invalid credentials, extra fields, bad revisions and oversized/non-JSON requests never reach the worker', async t => {
  const f = await fixture(t), cookie = await f.login();
  const invalid = [{ username: 'bad user' }, { username: 'x'.repeat(65) }, { username: 'x\nuser bridge' },
    { password: 'short' }, { password: '' }, { password: 'has space' }, { password: 'has:colon' }, { password: '中文密码123456' },
    { password: 'x'.repeat(65) }, { revision: 'abc' }, { deviceId: 'new-id' }, { username: ['boat'] }];
  for (const value of invalid) assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', body: input(value) })).status, 400, JSON.stringify(value));
  assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', raw: '{' })).status, 400);
  assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', raw: 'x'.repeat(4097) })).status, 413);
  assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', body: input(), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('missing helper disables the read panel and mutations return an actionable error without local fallback', async t => {
  const f = await fixture(t, { client: async () => { throw Object.assign(Error('unavailable'), { status: 503, unavailable: true }); } }), cookie = await f.login();
  const result = await f.call('/api/mqtt/devices', { cookie }); assert.equal(result.status, 200); assert.equal(result.data.enabled, false);
  assert.match(result.data.reason, /README/);
  assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', body: input() })).status, 503);
});

for (const videoCapable of [false, true]) test('parallel account panels share one in-flight read with ' + (videoCapable ? 'video-capable' : 'legacy') + ' helper', { timeout: 10000 }, async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => release = resolve);
  const f = await fixture(t, { client: async (method, route) => {
    assert.equal(method, 'GET'); assert.equal(route, '/devices');
    if (++calls > 1) throw Object.assign(Error('helper rejects simultaneous operations'), { status: 409 });
    await gate;
    return { devices: [{ deviceId: 'boat-01', username: 'boat-01', password: 'private-secret' }], revision,
      ...(videoCapable ? { canManageVideo: true, videos: [{ deviceId: 'boat-01', username: 'boat-camera' }] } : {}) };
  } }), cookie = await f.login();
  t.after(() => release());
  const arrived = collectionReadsArrive(f.server);
  const pending = [f.call('/api/mqtt/devices', { cookie }), f.call('/api/mqtt/devices', { cookie, origin: null })];
  await arrived; assert.equal(calls, 1); release();
  const results = await Promise.all(pending);
  for (const result of results) {
    assert.equal(result.status, 200, result.raw);
    assert.equal(result.data.canManageVideo, videoCapable);
    assert.deepEqual(result.data.videos, videoCapable ? [{ deviceId: 'boat-01', username: 'boat-camera' }] : []);
    assert.doesNotMatch(result.raw, /password|private-secret/);
  }
  assert.deepEqual(results[0].data, results[1].data); assert.equal(calls, 1);
});

test('failed shared reads preserve the helper error status and the next explicit read retries without cached metadata', { timeout: 10000 }, async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => release = resolve);
  const f = await fixture(t, { client: async () => {
    if (++calls === 1) { await gate; throw Object.assign(Error('PRIVATE backend configuration detail'), { status: 503 }); }
    return { devices: [{ deviceId: 'boat-01', username: 'fresh-account' }], revision: nextRevision };
  } }), cookie = await f.login();
  t.after(() => release());
  const arrived = collectionReadsArrive(f.server);
  const pending = [f.call('/api/mqtt/devices', { cookie }), f.call('/api/mqtt/devices', { cookie })];
  await arrived; release();
  for (const result of await Promise.all(pending)) { assert.equal(result.status, 503); assert.doesNotMatch(result.raw, /PRIVATE|fresh-account/); }
  assert.equal(calls, 1);
  const recovered = await f.call('/api/mqtt/devices', { cookie });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.devices[0].username, 'fresh-account');
  assert.equal(recovered.data.revision, nextRevision); assert.equal(calls, 2);
  assert.equal((await f.call('/api/mqtt/devices', { cookie })).status, 200); assert.equal(calls, 3, 'Successful snapshots are not cached either');
});

test('a shared read still authenticates each waiting session and does not disclose metadata after one administrator logs out', { timeout: 10000 }, async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => release = resolve);
  const f = await fixture(t, { client: async () => {
    calls++; await gate;
    return { devices: [{ deviceId: 'boat-01', username: 'confidential-account' }], revision };
  } }), first = await f.login(), second = await f.login(), guest = await f.login('guest');
  t.after(() => release());
  const arrived = collectionReadsArrive(f.server);
  const pending = [f.call('/api/mqtt/devices', { cookie: first }), f.call('/api/mqtt/devices', { cookie: second })];
  await arrived;
  assert.equal((await f.call('/api/mqtt/devices', { cookie: second, origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call('/api/mqtt/devices', { cookie: guest })).status, 403);
  assert.equal((await f.call('/api/mqtt/devices')).status, 401);
  await f.call('/api/auth/session', { cookie: first, method: 'DELETE' }); release();
  const [revoked, active] = await Promise.all(pending);
  assert.equal(revoked.status, 401); assert.doesNotMatch(revoked.raw, /confidential-account|boat-01|revision/);
  assert.equal(active.status, 200); assert.equal(active.data.devices[0].username, 'confidential-account'); assert.equal(calls, 1);
});

test('closing the MQTT API while a shared read waits prevents every late metadata response', { timeout: 10000 }, async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => release = resolve), session = { value: { role: 'admin' } };
  const api = createMqttDeviceApi({ accounts: { enabled: true, sessionFor: () => session, isActive: () => true, sameOrigin: () => true },
    client: async () => { calls++; await gate; return { devices: [{ deviceId: 'boat-01', username: 'private-account' }], revision }; } });
  const responses = [0, 1].map(() => ({ destroyed: false, writableEnded: false, writeHead(status) { this.status = status; }, end(raw) { this.raw = raw; this.writableEnded = true; } }));
  const req = { method: 'GET', headers: {} }, url = new URL('/api/mqtt/devices', ORIGIN);
  const pending = responses.map(res => api.handle(req, res, url));
  await Promise.resolve(); assert.equal(calls, 1); api.close(); release(); await Promise.all(pending);
  for (const res of responses) { assert.equal(res.status, 401); assert.doesNotMatch(res.raw, /private-account|boat-01|revision/); }
});

test('serialized mutations do not retry and late replies after logout cannot disclose account metadata', async t => {
  let release, started, count = 0; const began = new Promise(resolve => started = resolve);
  const f = await fixture(t, { client: async () => { count++; started(); await new Promise(resolve => release = resolve); return { ok: true, requiresReconnect: true, devices: [{ deviceId: 'boat-01', username: 'changed' }], revision: nextRevision }; } });
  const cookie = await f.login();
  const pending = f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', body: input() }); await began;
  assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', body: input() })).status, 409);
  await f.call('/api/auth/session', { cookie, method: 'DELETE' }); release();
  const result = await pending; assert.equal(result.status, 401); assert.doesNotMatch(result.raw, /changed|NewPassword/); assert.equal(count, 1);
});

test('partial HTTP body rechecks authorization before dispatching or times out without changing credentials', async t => {
  const f = await fixture(t), cookie = await f.login(), raw = JSON.stringify(input());
  async function slow(logout) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.server.address().port, path: '/api/mqtt/devices/boat-01', method: 'PATCH', agent: false,
        headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }); req.on('error', reject); req.write(raw.slice(0, 10));
      if (logout) setTimeout(async () => { await f.call('/api/auth/session', { cookie, method: 'DELETE' }); req.end(raw.slice(10)); }, 10);
    });
  }
  assert.equal(await slow(false), 408); assert.equal(await slow(true), 401); assert.equal(f.calls.length, 0);
});

test('strict snapshots strip secrets and reject ambiguous or invalid worker lists', () => {
  const record = { devices: [{ deviceId: 'boat-01', username: 'device-01', password: 'not public' }], revision };
  assert.deepEqual(snapshot(record).devices, [{ deviceId: 'boat-01', username: 'device-01' }]);
  for (const bad of [{}, { ...record, revision: '' }, { ...record, devices: [...record.devices, ...record.devices] }, { ...record, devices: [{ deviceId: 'bad/id', username: 'device' }] }]) assert.throws(() => snapshot(bad));
  assert.deepEqual(validateInput({ username: 'boat', revision }), { username: 'boat', revision });
});

test('socket client uses bounded fixed HTTP paths, masks helper errors, and never retries timed-out changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-mqtt-socket-'));
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\boat-mqtt-test-' + crypto.randomUUID() : path.join(directory, 'helper.sock');
  let mode = 'success', received, requests = 0;
  const server = http.createServer((req, res) => {
    requests++; const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      received = { method: req.method, path: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined };
      if (mode === 'timeout') return;
      if (mode === 'secret-error') { res.writeHead(503); return res.end(JSON.stringify({ error: 'PRIVATE-PASSWORD-IN-DETAIL' })); }
      if (mode === 'invalid') return res.end('{');
      if (mode === 'oversized') return res.end('x'.repeat(32769));
      res.end(JSON.stringify({ devices: [], revision }));
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const client = createMqttDeviceClient({ socketPath, timeoutMs: 100 });
  assert.equal((await client('GET', '/devices')).revision, revision);
  await client('PUT', '/devices/boat-01', input()); assert.deepEqual(received, { method: 'PUT', path: '/devices/boat-01', body: input() });
  for (const value of ['secret-error', 'invalid', 'oversized']) { mode = value; await assert.rejects(client('GET', '/devices'), error => error.status === 503 && !error.message.includes('PRIVATE')); }
  mode = 'timeout'; const before = requests;
  await assert.rejects(client('PUT', '/devices/boat-01', input()), error => error.status === 504); assert.equal(requests, before + 1);
  const missing = createMqttDeviceClient({ socketPath: process.platform === 'win32' ? socketPath + '-missing' : path.join(directory, 'missing.sock'), timeoutMs: 100 });
  await assert.rejects(missing('GET', '/devices'), error => error.unavailable === true && !error.message.includes(socketPath));
});

test('administrator HTTP API traverses the actual local socket worker, persists a rename and provisions an isolated new boat', async t => {
  const { createMqttDeviceWorker } = require('../maintenance/mqtt-device-worker.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-mqtt-admin-chain-')), file = name => path.join(directory, name);
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\boat-mqtt-chain-' + crypto.randomUUID() : file('worker.sock');
  const bridgeHash = '$7$101$bridge$unchanged', deviceHash = '$7$101$device$preserved';
  fs.writeFileSync(file('.boat-cloud-deployment'), 'unmanned-boat-cloud-v1\n');
  fs.writeFileSync(file('broker.service'), '# Owned by unmanned-boat-cloud-v1\n');
  fs.writeFileSync(file('runtime.env'), 'BOAT_MQTT_USERNAME=boat-web-bridge\nBOAT_MQTT_TOPIC_PREFIX=boats\n');
  fs.writeFileSync(file('passwd'), 'boat-01:' + deviceHash + '\nboat-web-bridge:' + bridgeHash + '\n', { mode: 0o640 });
  fs.writeFileSync(file('acl'), 'user boat-01\ntopic write boats/boat-01/telemetry\ntopic write boats/boat-01/status\ntopic read boats/boat-01/parameter-command\n\nuser boat-web-bridge\ntopic read boats/+/telemetry\n', { mode: 0o640 });
  fs.writeFileSync(file('access.txt'), 'Device password: obsolete-test-password\n', { mode: 0o600 });
  fs.writeFileSync(file('mosquitto.conf'), 'allow_anonymous false\npassword_file ' + file('passwd') + '\nacl_file ' + file('acl') + '\n');
  let restarts = 0;
  const worker = createMqttDeviceWorker({ configDir: directory, brokerUnit: file('broker.service'), checkOwnership: false, service: async () => { restarts++; },
    execute: async (executable,args) => { assert.equal(args[0],'-U'); const raw=fs.readFileSync(args[1],'utf8'),split=raw.indexOf(':'),username=raw.slice(0,split); fs.writeFileSync(args[1],username+':$7$101$isolated-test$'+crypto.createHash('sha512').update(raw.slice(split+1)).digest('base64')+'\n'); } });
  await new Promise(resolve => worker.listen(socketPath, resolve));
  const f = await fixture(t, { client: createMqttDeviceClient({ socketPath }) }), cookie = await f.login();
  t.after(async () => { worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const before = await f.call('/api/mqtt/devices', { cookie }); assert.equal(before.status, 200, before.raw);
  const changed = await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', body: { username: 'vessel-account', revision: before.data.revision } });
  assert.equal(changed.status, 200, changed.raw); assert.equal(changed.data.requiresReconnect, true);
  assert.deepEqual(changed.data.devices, [{ deviceId: 'boat-01', username: 'vessel-account' }]); assert.equal(restarts, 1);
  assert.equal(fs.readFileSync(file('passwd'), 'utf8'), 'vessel-account:' + deviceHash + '\nboat-web-bridge:' + bridgeHash + '\n');
  const acl = fs.readFileSync(file('acl'), 'utf8'); assert.match(acl, /user vessel-account/); assert.match(acl, /boats\/boat-01\/telemetry/); assert.doesNotMatch(acl, /boats\/vessel-account/);
  assert.equal((await f.call('/api/mqtt/devices/boat-01', { cookie, method: 'PATCH', body: { username: 'second-account', revision: before.data.revision } })).status, 409);
  const after = await f.call('/api/mqtt/devices', { cookie }); assert.equal(after.data.revision, changed.data.revision);
  assert.doesNotMatch(after.raw, /\$7\$|password|obsolete/); assert.equal(restarts, 1);
  assert.equal(after.data.canCreate,true);
  const created=await f.call('/api/mqtt/devices',{cookie,method:'POST',body:{deviceId:'boat-02',username:'vessel-two',password:'new-boat-test-only',revision:after.data.revision}});
  assert.equal(created.status,200,created.raw);assert.deepEqual(created.data.devices,[{deviceId:'boat-01',username:'vessel-account'},{deviceId:'boat-02',username:'vessel-two'}]);assert.equal(restarts,2);
  const persisted=fs.readFileSync(file('passwd'),'utf8');assert.ok(persisted.startsWith('vessel-account:'+deviceHash+'\nboat-web-bridge:'+bridgeHash+'\n'));assert.doesNotMatch(persisted,/new-boat-test-only/);
  assert.match(fs.readFileSync(file('acl'),'utf8'),/topic write boats\/boat-02\/telemetry/);assert.doesNotMatch(created.raw,/password|new-boat-test-only|\$7\$/);
});

test('provisioning a new boat requires administrator, same origin and valid mandatory fields before reaching the helper',async t=>{
  const f=await fixture(t),cookie=await f.login(),guest=await f.login('guest'),body={...input(),deviceId:'boat-02'};
  for(const [current,status]of [[undefined,401],[guest,403]])assert.equal((await f.call('/api/mqtt/devices',{cookie:current,method:'POST',body})).status,status);
  for(const origin of [null,'https://evil.test'])assert.equal((await f.call('/api/mqtt/devices',{cookie,origin,method:'POST',body})).status,403);
  for(const extra of [{deviceId:'boats/+'},{deviceId:''},{deviceId:3},{password:''},{deviceId:'boat-02',unexpected:true}])assert.equal((await f.call('/api/mqtt/devices',{cookie,method:'POST',body:{...body,...extra}})).status,400);
  const missing={...body};delete missing.password;assert.equal((await f.call('/api/mqtt/devices',{cookie,method:'POST',body:missing})).status,400);assert.equal(f.calls.length,0);
});

test('provisioning passes a fixed POST request only after confirming helper capability and returns no secrets',async t=>{
  const calls=[],records=[{deviceId:'boat-01',username:'boat-01'}];
  const f=await fixture(t,{client:async(method,route,body)=>{
    calls.push({method,route,body:body&&{...body}});
    if(method==='POST')records.push({deviceId:body.deviceId,username:body.username,password:'must-not-leak'});
    return {devices:records,revision:method==='POST'?nextRevision:revision,canCreate:true,...(method==='POST'?{ok:true,requiresReconnect:true}:{})};
  }}),cookie=await f.login(),body={...input(),deviceId:'boat-02'};
  const result=await f.call('/api/mqtt/devices',{cookie,method:'POST',body});assert.equal(result.status,200,result.raw);assert.equal(result.data.devices.length,2);assert.equal(result.data.canCreate,true);
  assert.deepEqual(calls,[{method:'GET',route:'/devices',body:undefined},{method:'POST',route:'/devices',body}]);assert.doesNotMatch(result.raw,/password|NewPassword|must-not-leak/);
});

test('old helper clearly requires one-time component upgrade before provisioning and cannot be silently bypassed',async t=>{
  const f=await fixture(t),cookie=await f.login();
  const result=await f.call('/api/mqtt/devices',{cookie,method:'POST',body:{...input(),deviceId:'boat-02'}});
  assert.equal(result.status,503);assert.match(result.data.error,/组件版本较旧.*install-mqtt-device-admin/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
});

test('account revoked while checking helper capability cannot dispatch a new device creation',async t=>{
  let release,started;const began=new Promise(resolve=>started=resolve),calls=[];
  const f=await fixture(t,{client:async(method,route)=>{calls.push({method,route});started();await new Promise(resolve=>release=resolve);return {devices:[{deviceId:'boat-01',username:'boat-01'}],revision,canCreate:true};}}),cookie=await f.login();
  const pending=f.call('/api/mqtt/devices',{cookie,method:'POST',body:{...input(),deviceId:'boat-02'}});await began;
  await f.call('/api/auth/session',{cookie,method:'DELETE'});release();const result=await pending;assert.equal(result.status,401);assert.equal(calls.length,1);
});

test('video capability and public metadata are exposed per boat while secrets remain stripped', async t => {
  const videos = [{ deviceId: 'boat-01', username: 'boat-video' }], calls = []; let currentRevision = revision;
  const client = async (method, route, body) => {
    calls.push({ method, route, body: body && { ...body } });
    if (route === '/devices') return { devices: [{ deviceId: 'boat-01', username: 'boat-01' }], revision: currentRevision, canManageVideo: true, videos, password: 'private', secret: 'private' };
    currentRevision = nextRevision;
    return { ok: true, requiresReconnect: false, devices: [{ deviceId: 'boat-01', username: 'boat-01' }], revision: currentRevision,
      canManageVideo: true, videos: [{ deviceId: 'boat-01', username: body.username }], password: 'private', hash: '$7$private' };
  };
  const f = await fixture(t, { client }), cookie = await f.login();
  const listed = await f.call('/api/mqtt/devices', { cookie });
  assert.equal(listed.status, 200); assert.equal(listed.data.canManageVideo, true);
  assert.deepEqual(listed.data.videos, videos); assert.doesNotMatch(listed.raw, /password|secret|private|\$7\$/i);
  const changed = await f.call('/api/mqtt/devices/boat-01/video', { cookie, method: 'PATCH', body: { username: 'boat-camera', password: 'six6!!', revision } });
  assert.equal(changed.status, 200, changed.raw); assert.equal(changed.data.requiresReconnect, false);
  assert.deepEqual(calls.slice(-2), [
    { method: 'GET', route: '/devices', body: undefined },
    { method: 'PUT', route: '/devices/boat-01/video', body: { username: 'boat-camera', password: 'six6!!', revision } }
  ]);
  assert.doesNotMatch(changed.raw, /six6|password|private|\$7\$/i);
  const preserved = await f.call('/api/mqtt/devices/boat-01/video', { cookie, method: 'PATCH', body: { username: 'boat-camera', revision: nextRevision } });
  assert.equal(preserved.status, 200); assert.equal(Object.hasOwn(calls.at(-1).body, 'password'), false);
});

test('video account mutation requires the new helper capability, admin session and same origin', async t => {
  const f = await fixture(t), admin = await f.login(), guest = await f.login('guest'), body = { username: 'boat-video', password: 'six6!!', revision };
  assert.equal((await f.call('/api/mqtt/devices/boat-01/video', { cookie: guest, method: 'PATCH', body })).status, 403);
  assert.equal((await f.call('/api/mqtt/devices/boat-01/video', { cookie: admin, origin: 'https://evil.test', method: 'PATCH', body })).status, 403);
  assert.equal((await f.call('/api/mqtt/devices/boat-01/video', { cookie: admin, method: 'PATCH', body })).status, 503);
  assert.equal(f.calls.length, 1, 'Old helper is queried for capability but never receives PUT');
  assert.equal((await f.call('/api/mqtt/devices/boat-01/video', { cookie: admin, method: 'PATCH', body: { ...body, password: 'short' } })).status, 400);
  assert.equal((await f.call('/api/mqtt/devices/boat-01/video', { cookie: admin, method: 'PATCH', body: { ...body, password: 'has space' } })).status, 400);
});

test('video snapshots reject missing boats, duplicate assignments and usernames colliding with device accounts', () => {
  const base = { devices: [{ deviceId: 'boat-01', username: 'boat-01' }], revision, canManageVideo: true };
  assert.deepEqual(snapshot({ ...base, videos: [] }).videos, []);
  for (const videos of [
    [{ deviceId: 'boat-02', username: 'camera' }],
    [{ deviceId: 'boat-01', username: 'camera' }, { deviceId: 'boat-01', username: 'other' }],
    [{ deviceId: 'boat-01', username: 'boat-01' }],
    [{ deviceId: 'boat-01', username: 'bad user', password: 'must-not-leak' }]
  ]) assert.throws(() => snapshot({ ...base, videos }), /视频账号/);
  assert.deepEqual(validateVideoInput({ deviceId: 'boat-01', username: 'camera', password: 'six6!!', revision }), { deviceId: 'boat-01', username: 'camera', password: 'six6!!', revision });
  assert.throws(() => validateVideoInput({ deviceId: 'boat-01', username: 'camera', password: 'short', revision }));
});
