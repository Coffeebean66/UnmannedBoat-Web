/* 真实本机账户与设备管理 API、模拟本机 Broker 管理组件；不访问生产服务器。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createFixtureServer, fixtureScript } = require('./mqtt-browser-fixture.cjs');
const output = path.resolve(__dirname, '../.test-output'), wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const run = fs.mkdtempSync(path.join(output, 'mqtt-device-settings-state-'));
  let revision = 'a'.repeat(64), devices = [{ deviceId: 'boat-01', username: 'boat-01' }, { deviceId: 'offline-vessel', username: 'vessel-two' }];
  let mode = 'ready', writes = 0, lastInput;
  const server = createFixtureServer({ accountOptions: { storeFile: path.join(run, 'accounts.json') }, mapOptions: { file: path.join(run, 'map-settings.json') },
    mqttAdminOptions: { client: async (method, route, input) => {
      if (mode === 'unavailable') throw Object.assign(Error('component missing'), { status: 503, unavailable: true });
      if (method === 'GET') return { devices, revision };
      writes++;
      if (mode === 'conflict') throw Object.assign(Error('conflict'), { status: 409 });
      assert.equal(method, 'PUT'); assert.ok(route.startsWith('/devices/')); assert.equal(input.revision, revision);
      lastInput = { ...input }; revision = (revision[0] === 'a' ? 'b' : 'c').repeat(64);
      devices = devices.map(device => device.deviceId === route.split('/').at(-1) ? { ...device, username: input.username } : device);
      return { ok: true, requiresReconnect: true, devices, revision };
    } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(output, 'chrome-mqtt-device-settings-')), errors = [], confirmations = [];
  let acceptConfirm = true;
  const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0', '--user-data-dir=' + profile
  ], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', error => errors.push(error.message)); let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile) && !errors.length; i++) await wait(100);
    if (!fs.existsSync(portFile)) throw Error(errors.join('; ') || 'Chrome did not start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let serial = 0; const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Page.javascriptDialogOpening') {
        confirmations.push(message.params.message);
        send('Page.handleJavaScriptDialog', { accept: acceptConfirm }).catch(error => errors.push(error.message));
      }
      if (pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await wait(70); }
      throw Error('Condition timed out: ' + expression + '\n' + await evaluate('JSON.stringify({auth:BoatAuth.state(),status:document.getElementById("mqttDeviceStatus").textContent})') + '\n' + errors.join('\n'));
    };
    const edit = async deviceId => {
      await evaluate('[...document.getElementById("mqttDeviceList").children].find(row=>row.querySelector("strong").textContent===' + JSON.stringify(deviceId) + ').querySelector("button").click()');
      await until('!document.getElementById("mqttDeviceForm").hidden');
    };
    const fill = (username, password = '', confirmation = password) => evaluate('document.getElementById("mqttDeviceUsername").value=' + JSON.stringify(username) + ';document.getElementById("mqttDevicePassword").value=' + JSON.stringify(password) + ';document.getElementById("mqttDevicePasswordConfirm").value=' + JSON.stringify(confirmation));
    const save = () => evaluate('document.getElementById("mqttDeviceForm").requestSubmit()');
    const saved = () => until('document.getElementById("mqttDeviceStatus").dataset.tone==="success"&&!boatMonitor.mqttDevices.busy');
    const layout = async (width, theme, name) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 820 : 1000, deviceScaleFactor: 1, mobile: width < 600 });
      await evaluate('BoatUI.setTheme(' + JSON.stringify(theme) + ');document.getElementById("mqttDeviceSettings").scrollIntoView({block:"start"})');
      await wait(200);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, width + 'px page must fit');
      assert.equal(await evaluate('document.getElementById("settingsDialog").scrollWidth>document.getElementById("settingsDialog").clientWidth+1'), false, width + 'px dialog must fit');
      assert.equal(await evaluate('document.getElementById("mqttDeviceSettings").scrollWidth>document.getElementById("mqttDeviceSettings").clientWidth+1'), false, width + 'px device panel must fit');
      if (theme === 'light') {
        await until('getComputedStyle(document.getElementById("mqttDeviceRead")).color==="rgb(22, 36, 54)"');
        assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
      }
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
    };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*://tile.openstreetmap.org/*', '*://webapi.amap.com/*'] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url }); await until('!!window.boatMonitor&&BoatAuth.ready');
    await evaluate('ensureTestLogin()'); await evaluate('connectTestBoat()');
    const connectionCount = await evaluate('window.testConnections');
    await evaluate('document.getElementById("settingsToggle").click()');
    await until('document.getElementById("mqttDeviceList").children.length===2&&!boatMonitor.mqttDevices.busy');
    assert.equal(await evaluate('document.getElementById("mqttDeviceSettings").hidden'), false);
    assert.equal(await evaluate('boatMonitor.link.connected'), true); assert.equal(await evaluate('window.testConnections'), connectionCount);
    await edit('boat-01'); assert.equal(await evaluate('document.getElementById("mqttDeviceId").readOnly'), true);
    await fill('vessel-one', 'browser-device-secret', 'not-matching-secret'); await save();
    await until('document.getElementById("mqttDeviceStatus").textContent.includes("不一致")');
    assert.equal(writes, 0); assert.equal(await evaluate('document.getElementById("mqttDevicePassword").value'), '');
    await fill('vessel-one', 'browser-device-secret'); acceptConfirm = false; await save();
    await until('document.getElementById("mqttDeviceStatus").textContent.includes("已取消保存")'); assert.equal(writes, 0);
    await fill('vessel-one', 'browser-device-secret'); acceptConfirm = true; await save(); await saved();
    assert.equal(writes, 1); assert.deepEqual(lastInput, { username: 'vessel-one', password: 'browser-device-secret', revision: 'a'.repeat(64) });
    assert.ok(confirmations.every(message => message.includes('boat-01') && message.includes('STM32') && message.includes('短暂重连') && !message.includes('browser-device-secret')));
    assert.equal(await evaluate('document.getElementById("mqttDevicePassword").value'), '');
    assert.equal(await evaluate('document.getElementById("mqttDeviceForm").hidden'), true);
    await edit('offline-vessel'); await fill('offline-account'); await save(); await saved();
    assert.equal(writes, 2); assert.equal(Object.hasOwn(lastInput, 'password'), false);
    assert.equal(await evaluate('boatMonitor.mqttDevices.devices[1].username'), 'offline-account');
    await edit('boat-01');
    await layout(1440, 'dark', 'mqtt-device-desktop'); await layout(1440, 'light', 'mqtt-device-desktop-light');
    await layout(375, 'dark', 'mqtt-device-mobile-375'); await layout(320, 'light', 'mqtt-device-mobile-320-light');
    await layout(320, 'dark', 'mqtt-device-mobile-320');
    await fill('conflicting-account', 'browser-conflict-secret'); mode = 'conflict'; await save();
    await until('document.getElementById("mqttDeviceStatus").dataset.tone==="error"&&!boatMonitor.mqttDevices.busy');
    assert.equal(writes, 3); assert.equal(await evaluate('boatMonitor.mqttDevices.loaded'), false);
    assert.equal(await evaluate('document.getElementById("mqttDeviceSave").disabled'), true);
    mode = 'unavailable'; await evaluate('document.getElementById("mqttDeviceRead").click()');
    await until('document.getElementById("mqttDeviceStatus").textContent.includes("启用一次")&&!boatMonitor.mqttDevices.busy');
    assert.equal(await evaluate('document.getElementById("mqttDeviceList").hidden'), true);
    mode = 'ready'; await evaluate('document.getElementById("mqttDeviceRead").click()');
    await until('boatMonitor.mqttDevices.loaded&&!boatMonitor.mqttDevices.busy'); await edit('boat-01'); await fill('draft-account', 'browser-draft-secret');
    await evaluate('document.getElementById("settingsClose").click()');
    await until('!boatMonitor.mqttDevices.isOpen');
    assert.equal(await evaluate('document.getElementById("mqttDevicePassword").value'), '');
    assert.equal(await evaluate('boatMonitor.mqttDevices.loaded'), false);
    await evaluate('document.getElementById("accountLogout").click()'); await until('!BoatAuth.user&&!BoatAuth.busy');
    await evaluate('document.getElementById("accountLoginOpen").click();document.getElementById("accountUsername").value="observer";document.getElementById("accountPassword").value="browser-guest-test-only";document.getElementById("accountLoginForm").requestSubmit()');
    await until('BoatAuth.user?.role==="guest"&&!BoatAuth.busy');
    assert.equal(await evaluate('document.getElementById("mqttDeviceSettings").hidden'), true);
    assert.equal(await evaluate('fetch("/api/mqtt/devices").then(response=>response.status)'), 403);
    assert.equal(await evaluate('[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>/browser-device-secret|browser-draft-secret|browser-conflict-secret/.test(String(value)))'), false);
    assert.deepEqual(errors, []);
    console.log('Chrome MQTT device settings passed: real local auth/API, device and offline-device edits, password confirmation, native confirmation cancel/accept, no-op-free single saves, version conflict, unavailable component, guest403, cleanup and 1440/375/320px dark/light layouts.');
  } finally {
    socket?.close(); browser.kill(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
    if (path.dirname(run) === output && path.basename(run).startsWith('mqtt-device-settings-state-')) fs.rmSync(run, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
