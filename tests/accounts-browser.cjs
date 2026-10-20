/* 真浏览器+真实账户API验证，仅使用本地临时测试账号和蓝牙替身。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { EventEmitter } = require('node:events');
const { createServer } = require('../server');
const output = path.resolve(__dirname, '../.test-output'), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bluetoothMock = '(' + function () {
  const tx = new EventTarget(); tx.uuid = '49535343-1e4d-4bd9-ba61-23c647249616'; tx.properties = { notify: true }; tx.startNotifications = async () => tx;
  let pending = []; window.accountTestWrites = 0;
  const rx = { uuid: '49535343-8841-43f4-a8d4-ecbe34729bb3', properties: { write: true }, async writeValueWithResponse(bytes) {
    window.accountTestWrites++; pending.push(...bytes); if (pending.length < 56) return;
    const response = new Uint8Array(pending.splice(0, 56)), view = new DataView(response.buffer);
    response[3] = 0x90; response[5] = 0;
    const values = { ...BoatParameters.tuning, turnAtFullSpeedPercent: 50, motor1Reversed: 0, motor2Reversed: 1,
      headingKpX100: 200, headingKiX100: 0, headingKdX100: 0, headingIntegralLimitX2: 30,
      headingOutputLimitX2: 60, headingDeadbandCdeg: 200, headingReversed: 0 };
    Object.keys(BoatParameters.ranges).forEach((key, index) => view.setUint16(14 + index * 2, values[key], true));
    view.setUint16(54, BoatModules.uart4Protocol.crc16CcittFalse(response, 2, 52), true);
    setTimeout(() => { tx.value = new DataView(response.buffer); tx.dispatchEvent(new Event('characteristicvaluechanged')); }, 10);
  } };
  const service = { uuid: '49535343-fe7d-4ae5-8fa9-9fafd205e455', getCharacteristics: async () => [tx, rx] };
  const device = new EventTarget(); device.id = 'account-test-ble'; device.name = 'T10 ACCOUNT TEST';
  device.gatt = { connected: false, async connect() { this.connected = true; return { getPrimaryServices: async () => [service] }; },
    disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); } };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => device } });
}.toString() + ')();';

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const bridge = new EventEmitter(); Object.assign(bridge, { enabled: true, start() {}, stop() {},
    list: () => ({ brokerConnected: true, devices: [{ id: 'boat-test', online: true }] }), state: device => ({ brokerConnected: true, device: { id: device, online: true } }) });
  const env = { BOAT_ACCOUNTS_ENABLED: '1', BOAT_ADMIN_USERNAME: 'operator', BOAT_ADMIN_PASSWORD: 'browser-admin-test-only',
    BOAT_GUEST_USERNAME: 'observer', BOAT_GUEST_PASSWORD: 'browser-guest-test-only' };
  const server = createServer({ env, cloud: bridge }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(output, 'chrome-accounts-')), errors = [];
  const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0', '--user-data-dir=' + profile
  ], { windowsHide: true, stdio: 'ignore' }); browser.on('error', error => errors.push(error.message)); let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile) && !errors.length; i++) await wait(100);
    if (!fs.existsSync(portFile)) throw Error(errors.join('; ') || 'Chrome did not start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0], pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let serial = 0; const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => reject(Error('CDP timeout: ' + method)), 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
    const until = async expression => { for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await wait(75); } throw Error('Condition timed out: ' + expression + '\n' + errors.join('\n')); };
    const shot = async name => { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64')); };
    const login = async (username, password) => {
      await evaluate('document.getElementById("accountUsername").value=' + JSON.stringify(username) + ';document.getElementById("accountPassword").value=' + JSON.stringify(password) + ';document.getElementById("accountLoginForm").requestSubmit()');
      await until('!!window.BoatAuth.user && !document.getElementById("accountLoginDialog").open && !window.BoatAuth.busy');
    };
    const visible = id => evaluate('getComputedStyle(document.getElementById(' + JSON.stringify(id) + ')).display!=="none"');
    await send('Runtime.enable'); await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument', { source: bluetoothMock });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    await until('!!window.boatMonitor && window.BoatAuth.ready && document.getElementById("accountLoginDialog").open');
    assert.equal(await evaluate('window.BoatAuth.canManage'), false); assert.equal(await visible('updateToggle'), false);
    assert.equal(await evaluate('document.getElementById("connectButton").disabled'), true); await shot('accounts-desktop-login');
    await login('observer', 'browser-guest-test-only');
    assert.equal(await evaluate('document.getElementById("accountName").textContent'), 'observer · 访客');
    for (const id of ['updateToggle', 'settingsToggle', 'sidebarSettings', 'settingsEntry']) assert.equal(await visible(id), false);
    assert.equal(await evaluate('document.getElementById("cloudLoginOpen").hidden'), true);
    await evaluate('document.getElementById("connectButton").click()'); await until('boatMonitor.link.connected');
    for (const expression of ['boatMonitor.link.request("read")', 'boatMonitor.link.bluetooth.request("write",{})', 'boatMonitor.params.command("flash")']) {
      const result = await evaluate(expression + '.then(()=>"unexpected",error=>error.message)'); assert.match(result, /访客|只读/);
    }
    assert.equal(await evaluate('window.accountTestWrites'), 0);
    await evaluate('document.getElementById("trackStart").click()'); assert.equal(await evaluate('boatMonitor.track.active'), true);
    await evaluate('document.getElementById("animationEnabled").click()');
    await shot('accounts-desktop-guest');
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true }); await wait(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false); await shot('accounts-mobile-guest');
    await evaluate('document.getElementById("accountLogout").click()'); await until('!BoatAuth.user && !BoatAuth.busy');
    assert.equal(await evaluate('boatMonitor.link.connected'), false);
    await evaluate('document.getElementById("accountLoginOpen").click()'); await login('operator', 'browser-admin-test-only');
    assert.equal(await visible('updateToggle'), true); assert.equal(await visible('settingsToggle'), true);
    await evaluate('document.getElementById("connectButton").click()'); await until('boatMonitor.link.connected');
    await evaluate('boatMonitor.params.command("read")'); assert.ok(await evaluate('accountTestWrites>0'));
    assert.ok(await evaluate('!!boatMonitor.params.confirmed'));
    await evaluate('document.getElementById("updateToggle").click()'); await until('/安装|启用/.test(document.getElementById("updateStatus").textContent)');
    assert.equal(await evaluate('document.getElementById("updateLoginForm").hidden'), true); await shot('accounts-mobile-admin-update');
    await evaluate('document.getElementById("updateClose").click();document.getElementById("accountLogout").click()'); await until('!BoatAuth.user && !BoatAuth.busy');
    assert.equal(await evaluate('boatMonitor.params.confirmed'), null);
    await evaluate('document.getElementById("accountLoginOpen").click()'); await login('observer', 'browser-guest-test-only');
    assert.equal(await visible('updateToggle'), false);
    await evaluate('document.getElementById("telemetrySource").value="cloud";document.getElementById("telemetrySource").dispatchEvent(new Event("change"))');
    await until('document.getElementById("cloudDevice").value==="boat-test" && !document.getElementById("connectButton").disabled');
    await evaluate('document.getElementById("connectButton").click()'); await until('boatMonitor.link.cloud.wanted');
    for (let i = 0; i < 60 && server.boatCloudApi.getClientCount() === 0; i++) await wait(25);
    assert.equal(server.boatCloudApi.getClientCount(), 1);
    await evaluate('document.getElementById("accountLogout").click()'); await until('!BoatAuth.user && !BoatAuth.busy');
    assert.equal(server.boatCloudApi.getClientCount(), 0); assert.equal(await evaluate('boatMonitor.link.cloud.wanted'), false);
    assert.equal(await evaluate('[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>String(value).includes("browser-admin-test-only")||String(value).includes("browser-guest-test-only"))'), false);
    assert.deepEqual(errors, []);
    console.log('Chrome shared accounts passed: real local API, admin/guest/login/logout, 1440px/320px, guest telemetry, guarded BLE parameters, account switching, shared update login, SSE logout.');
  } finally { if (socket) socket.close(); browser.kill(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
