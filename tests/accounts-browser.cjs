/* 真浏览器与本地账户/MQTT桥接API验证，遥测和参数均经过真实HTTP/SSE。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createFixtureServer, fixtureScript } = require('./mqtt-browser-fixture.cjs');
const output = path.resolve(__dirname, '../.test-output'), wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = createFixtureServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
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
      await until('document.getElementById("cloudDevice").value==="boat-mqtt-test" && !document.getElementById("connectButton").disabled');
    };
    const visible = id => evaluate('document.getElementById(' + JSON.stringify(id) + ')?.checkVisibility({checkVisibilityCSS:true})===true');
    await send('Runtime.enable'); await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    await until('!!window.boatMonitor && window.BoatAuth.ready && document.getElementById("accountLoginDialog").open');
    assert.equal(await evaluate('window.BoatAuth.canManage'), false); assert.equal(await visible('updateToggle'), false);
    assert.equal(await evaluate('document.getElementById("connectButton").disabled'), true); await shot('accounts-desktop-login');
    await login('observer', 'browser-guest-test-only');
    assert.equal(await evaluate('document.getElementById("accountName").textContent'), 'observer · 访客');
    for (const id of ['updateToggle', 'settingsToggle', 'settingsEntry']) assert.equal(await visible(id), false);
    assert.equal(await evaluate('document.getElementById("cloudLoginOpen").hidden'), true);
    await evaluate('document.getElementById("connectButton").click()'); await until('boatMonitor.link.connected');
    for (const expression of ['boatMonitor.link.request("read")', 'boatMonitor.link.request("write",{})', 'boatMonitor.params.command("flash")']) {
      const result = await evaluate(expression + '.then(()=>"unexpected",error=>error.message)'); assert.match(result, /访客|只读/);
    }
    assert.equal(server.mqttFixture.calls.length, 0);
    assert.equal(await evaluate('window.testWrites.length'), 0);
    await evaluate('document.getElementById("trackStart").click()'); assert.equal(await evaluate('boatMonitor.track.active'), true);
    await evaluate('document.getElementById("animationEnabled").click()');
    await shot('accounts-desktop-guest');
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true }); await wait(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false); await shot('accounts-mobile-guest');
    await evaluate('document.getElementById("accountLogout").click()'); await until('!BoatAuth.user && !BoatAuth.busy');
    assert.equal(await evaluate('boatMonitor.link.connected'), false);
    // 新页面没有沿用上一位监测用户的已选船ID，验证管理员尚未选船时的入口状态。
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    await until('!!window.boatMonitor && BoatAuth.ready && document.getElementById("accountLoginDialog").open');
    await evaluate('document.getElementById("accountLoginOpen").click()'); await login('operator', 'browser-admin-test-only');
    assert.equal(await visible('updateToggle'), true); assert.equal(await visible('settingsToggle'), false);
    assert.equal(await evaluate('document.getElementById("settingsToggle").hidden'),true);
    const configure='document.querySelector(".fleet-card[data-device-id=boat-mqtt-test] .fleet-parameter-button")';
    await until(configure+'&&!'+configure+'.hidden&&!'+configure+'.disabled');await evaluate(configure+'.click()');
    await until('document.getElementById("settingsDialog").open&&boatMonitor.link.connected');
    assert.equal(await evaluate('document.getElementById("parameterDeviceName").textContent'),'boat-mqtt-test');
    await until('!document.getElementById("readParameters").disabled');await evaluate('document.getElementById("readParameters").click()');
    await until('!!boatMonitor.params.confirmed&&!boatMonitor.params.busy');assert.equal(server.mqttFixture.calls.length, 1);
    assert.equal(server.mqttFixture.calls[0].deviceId, 'boat-mqtt-test'); assert.equal(server.mqttFixture.calls[0].kind, 'read');
    assert.ok(await evaluate('!!boatMonitor.params.confirmed'));
    await evaluate('document.getElementById("settingsClose").click();document.getElementById("updateToggle").click()'); await until('/安装|启用/.test(document.getElementById("updateStatus").textContent)');
    assert.equal(await evaluate('document.getElementById("updateLoginForm").hidden'), true); await shot('accounts-mobile-admin-update');
    await evaluate('document.getElementById("updateClose").click();document.getElementById("accountLogout").click()'); await until('!BoatAuth.user && !BoatAuth.busy');
    assert.equal(await evaluate('boatMonitor.params.confirmed'), null);
    await evaluate('document.getElementById("accountLoginOpen").click()'); await login('observer', 'browser-guest-test-only');
    assert.equal(await visible('updateToggle'), false);
    await evaluate('document.getElementById("connectButton").click()'); await until('boatMonitor.link.wanted');
    for (let i = 0; i < 60 && server.boatCloudApi.getClientCount() < 2; i++) await wait(25);
    assert.equal(server.boatCloudApi.getClientCount(), 2,'One fleet summary stream and one selected-boat telemetry stream');
    await evaluate('document.getElementById("accountLogout").click()'); await until('!BoatAuth.user && !BoatAuth.busy');
    assert.equal(server.boatCloudApi.getClientCount(), 0); assert.equal(await evaluate('boatMonitor.link.wanted'), false);
    assert.equal(await evaluate('[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>String(value).includes("browser-admin-test-only")||String(value).includes("browser-guest-test-only"))'), false);
    assert.deepEqual(errors, []);
    console.log('Chrome shared accounts passed: real local account/MQTT bridge APIs, admin/guest/login/logout, 1440px/320px, guest telemetry, guarded cloud parameters, account switching, shared update login, SSE logout.');
  } finally { if (socket) socket.close(); browser.kill(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
