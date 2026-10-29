/* 云端调参前端：只信原协议设备确认，能力、角色及异步取消分别验证。 */
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const P = require('../public/utils/uart4Protocol'), root = path.resolve(__dirname, '..');
const configContext = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(root, 'public/parameter-data.js'), 'utf8'), configContext);
const config = configContext.window.BoatParameters;
const values = Object.fromEntries(Object.entries(config.ranges).map(([key, range]) => [key, range[0]])); values.kpX2PerMps = 42;
function frame(status = 0, parameters = values) {
  const bytes = P.encodeParameterWriteRequest(987, parameters); bytes[3] = 0x90; bytes[5] = status;
  new DataView(bytes.buffer).setUint16(54, P.crc16CcittFalse(bytes, 2, 52), true);
  return Buffer.from(bytes).toString('base64');
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function setup() {
  let parametersReady = true, block, responseStatus = 200, result = { frame: frame(), serverTime: 1000000 };
  const calls = [], timers = new Map(); let timerId = 0;
  class Auth extends EventTarget {
    constructor() { super(); this.enabled = true; this.ready = true; this.user = { username: 'operator', role: 'admin' }; this.generation = 1; }
    get canManage() { return this.ready && this.user?.role === 'admin'; }
    get canMonitor() { return !!this.user; }
    async whenReady() {} assertMonitor() { if (!this.canMonitor) throw Error('请登录'); }
    assertManage() { if (!this.canManage) throw Error('访客只读'); }
    async verifyManage() { this.assertManage(); }
    change(role) { this.user = role ? { username: role, role } : null; this.generation++; this.dispatchEvent(new CustomEvent('change')); }
    expire() { this.change(null); }
  }
  const auth = new Auth();
  class Stream extends EventTarget { close() { this.closed = true; } }
  const fetch = async (url, options = {}) => {
    calls.push({ url, ...options }); let body, status = 200;
    if (url.endsWith('/config')) body = { enabled: true, requiresLogin: true };
    else if (url.endsWith('/devices')) body = { devices: [{ id: 'boat-1', online: true, parametersReady }], brokerConnected: true };
    else if (url.endsWith('/parameters')) { if (block) await block(); body = result; status = responseStatus; }
    else throw Error('Unexpected URL ' + url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const context = { window: { BoatAuth: auth }, fetch, BoatModules: { uart4Protocol: P }, EventTarget, CustomEvent,
    Date, performance, Uint8Array, atob, AbortController, document: { hidden: false }, EventSource: Stream,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 1, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/cloud-transport.js'), 'utf8'), context);
  const cloud = new context.window.CloudBoatLink(); await cloud.initialize(); await cloud.connect('boat-1'); cloud.live = true;
  return { cloud, context, auth, calls, timers, frame,
    cap: value => { parametersReady = value; }, block: fn => { block = fn; },
    respond: (body, status = 200) => { result = body; responseStatus = status; },
    pendingPost: () => calls.filter(call => call.url.endsWith('/parameters')) };
}

test('管理员+明确新鲜固件能力才可远程调参，未知配置/旧固件/guest/legacy不下发', async () => {
  const h = await setup(); assert.equal(h.cloud.readOnly, false);
  h.cloud.configurationKnown = false; await assert.rejects(h.cloud.request('read'), /配置/); h.cloud.configurationKnown = true;
  h.cap(false); await h.cloud.refreshDevices(); assert.equal(h.cloud.readOnly, true); await assert.rejects(h.cloud.request('read'), /固件|就绪/);
  h.auth.change('guest'); await assert.rejects(h.cloud.request('read'), /访客/);
  h.auth.enabled = false; await assert.rejects(h.cloud.request('read'), /只读/);
  assert.equal(h.pendingPost().length, 0);
});

test('read/write/flash发送固定JSON，解析56字节设备响应并保留服务器分配序号及拒绝status', async () => {
  const h = await setup();
  for (const kind of ['read', 'write', 'flash']) {
    h.respond({ frame: frame(kind === 'flash' ? 3 : 0) });
    const response = await h.cloud.request(kind, values);
    assert.equal(response.requestSequence, 987); assert.equal(response.parameters.kpX2PerMps, 42);
    assert.equal(response.status, kind === 'flash' ? 3 : 0);
    const call = h.pendingPost().at(-1); assert.equal(call.method, 'POST');
    assert.deepEqual(JSON.parse(call.body), { deviceId: 'boat-1', kind, ...(kind === 'read' ? {} : { values }) });
  }
});

test('单在途禁并发，publish/HTTP等待本身不能结束事务或显示成功', async () => {
  const h = await setup(); let release; h.block(() => new Promise(resolve => { release = resolve; }));
  const request = h.cloud.request('write', values); await flush();
  assert.equal(h.cloud.busy, true); await assert.rejects(h.cloud.request('read'), /等待/);
  assert.equal(h.pendingPost().length, 1); assert.ok(h.cloud.pending);
  release(); await request; assert.equal(h.cloud.pending, null);
});

test('read/write7秒和flash22秒前端超时不重发；迟到成功被忽略并提醒读取确认', async () => {
  for (const kind of ['read', 'write', 'flash']) {
    const h = await setup(); let release; h.block(() => new Promise(resolve => { release = resolve; }));
    const request = h.cloud.request(kind, values); await flush();
    const timer = [...h.timers.values()].find(timer => timer.delay === (kind === 'flash' ? 22000 : 7000)); assert.ok(timer);
    const rejection = assert.rejects(request, error => error.uncertain && /读取/.test(error.message)); timer.fn(); await rejection;
    assert.equal(h.cloud.pending, null); assert.equal(h.pendingPost().length, 1);
    release(); await flush(); assert.equal(h.cloud.pending, null); assert.equal(h.pendingPost().length, 1);
  }
});

test('断连/遥测失效/换身份/切换设备立即取消，迟到结果不恢复旧会话', async () => {
  for (const cancel of [h => h.cloud.disconnect(), h => h.cloud.invalidate('设备失联'), h => h.auth.change('guest'),
    h => { h.cloud.selectedId = 'other-device'; h.cloud.disconnect(); }]) {
    const h = await setup(); let release; h.block(() => new Promise(resolve => { release = resolve; }));
    const request = h.cloud.request('write', values); await flush(); const rejection = assert.rejects(request, /写入可能已生效.*读取/);
    cancel(h); await rejection; release(); await flush(); assert.equal(h.cloud.pending, null);
  }
});

test('能力在点击时失效则阻止下发，界面权限变化通知不会使用旧缓存', async () => {
  const h = await setup(); const changes = []; h.cloud.addEventListener('permissionchange', event => changes.push(event.detail.readOnly));
  h.cap(false); await assert.rejects(h.cloud.request('flash', values), /连接、设备或账户已变化/);
  assert.equal(h.pendingPost().length, 0); assert.ok(changes.includes(true));
});

test('命令消费单次能力后暂时只读，当前真实响应仍可完成，不能误取消或改连接generation', async () => {
  const h = await setup(), link = h.cloud;
  let release; h.block(() => new Promise(resolve => { release=resolve; }));
  const generation=link.generation,request=link.request('read'); await flush();
  h.cap(false); await h.cloud.refreshDevices();
  assert.equal(h.cloud.readOnly,true); assert.ok(h.cloud.pending); assert.equal(link.generation,generation);
  release(); const result=await request; assert.equal(result.status,0); assert.equal(h.pendingPost().length,1);
});

test('HTTP504/网络失败及错误base64/CRC均不假成功，也不自动重试', async () => {
  for (const [body, status] of [[{ error: '设备确认超时' }, 504], [{ error:'参数发送失败，结果未知' },503], [{ ok: true }, 200], [{ frame: 'bad' }, 200],
    [{ frame: Buffer.alloc(56).toString('base64') }, 200]]) {
    const h = await setup(); h.respond(body, status);
    await assert.rejects(h.cloud.request('write', values), error => error.uncertain && /写入可能已生效/.test(error.message));
    assert.equal(h.pendingPost().length, 1); assert.equal(h.cloud.pending, null);
  }
});

function panel() {
  const inputs = Object.entries(values).map(([key, value]) => ({ dataset: { key }, value: String(value) })), ids = {};
  const context = { window: { BoatParameters: config, BoatAuth: { assertManage() {}, canManage:true } },
    document: { getElementById: id => ids[id] || (ids[id] = { dataset: {} }), querySelectorAll: selector => selector.startsWith('#parameterFields') ? inputs : [] },
    BoatModules: { parameterExport: { formatParameterExport: () => '' } }, Date };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/parameter-panel.js'), 'utf8'), context);
  const instance = Object.create(context.window.ParameterPanel.prototype);
  Object.assign(instance, { link: { source: 'cloud', readOnly: false, connected: true, generation: 1, request: async () => P.decodeParameterFrame(Buffer.from(frame(), 'base64')) },
    confirmed: { ...values }, localDraft: null, busy: false, keys: Object.keys(values), config, slots: [null, null, null] });
  return { panel: instance, ids, inputs };
}

test('云端参数面板可读取/写入/保存Flash，只有设备status0才显示成功', async () => {
  const h = panel(); for (const kind of ['read', 'write', 'flash']) { await h.panel.command(kind); assert.equal(h.ids.parameterStatus.dataset.tone, 'success'); }
  h.panel.link.request = async () => P.decodeParameterFrame(Buffer.from(frame(3), 'base64'));
  await assert.rejects(h.panel.command('flash'), /CH6/); assert.equal(h.ids.parameterStatus.dataset.tone, 'warning');
});

test('未知写入结果清设备确认值并保留草稿，禁止再写/Flash直至重新读取', async () => {
  const h = panel(); h.panel.link.request = async () => { throw Object.assign(Error('写入可能已生效，请先读取确认后再重试'), { uncertain: true }); };
  await assert.rejects(h.panel.command('write'), /读取确认/);
  assert.equal(h.panel.confirmed, null); assert.equal(h.panel.localDraft.kpX2PerMps, 42);
  assert.equal(h.ids.writeParameters.disabled, true); assert.equal(h.ids.saveFlash.disabled, true);
  await assert.rejects(h.panel.command('flash'), /请先读取/);
});

test('云端响应返回时下一次操作尚未就绪，不丢弃本次设备已确认的结果', async () => {
  const h=panel(); h.panel.link.request=async()=>{h.panel.link.readOnly=true;return P.decodeParameterFrame(Buffer.from(frame(),'base64'));};
  await h.panel.command('read'); assert.equal(h.ids.parameterStatus.dataset.tone,'success');
  assert.equal(h.panel.confirmed.kpX2PerMps,42); assert.equal(h.ids.writeParameters.disabled,true);
});

test('切船后旧请求的迟到取消结果不会恢复草稿或覆盖新船参数', async () => {
  const h=panel();let rejectRequest;
  h.panel.link.request=()=>new Promise((resolve,reject)=>{rejectRequest=reject;});
  const pending=h.panel.command('write');
  h.panel.link.generation++;h.panel.reset(false);
  const next={...values,kpX2PerMps:222};
  h.panel.confirmed={...next};h.panel.fill(next);
  rejectRequest(Object.assign(Error('已切换无人船，旧写入结果未知'),{uncertain:true}));
  await assert.rejects(pending,/已切换无人船/);
  assert.equal(h.panel.localDraft,null);
  assert.equal(h.panel.confirmed.kpX2PerMps,222);
  assert.equal(h.inputs.find(input=>input.dataset.key==='kpX2PerMps').value,'222');
});
