/* 真实本机账户与设备管理 API、模拟本机 Broker 管理组件；不访问生产服务器。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createFixtureServer, fixtureScript } = require('./mqtt-browser-fixture.cjs');
const output = path.resolve(__dirname, '../.test-output'), wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const run = fs.mkdtempSync(path.join(output, 'mqtt-device-settings-state-'));
  let revision = 'a'.repeat(64), devices = [{ deviceId: 'boat-01', username: 'boat-01' }, { deviceId: 'offline-vessel', username: 'vessel-two' }];
  let videos = [{ deviceId: 'boat-01', username: 'boat-01-video' }];
  let mode = 'ready', writes = 0, lastInput, reading = false, helperReads = 0, overlappingReads = 0;
  const snapshot = () => ({ devices, videos, revision, canCreate: true, canManageVideo: true });
  const server = createFixtureServer({ accountOptions: { storeFile: path.join(run, 'accounts.json') }, mapOptions: { file: path.join(run, 'map-settings.json') },
    mqttAdminOptions: { client: async (method, route, input) => {
      if (mode === 'unavailable') throw Object.assign(Error('component missing'), { status: 503, unavailable: true });
      if (method === 'GET') {
        helperReads++;
        if (reading) { overlappingReads++; throw Object.assign(Error('component busy'), { status: 409 }); }
        reading = true;
        try {
          // 真正的特权组件将读取和写入一起互斥；两个设置面板必须共享同一在途读取。
          await wait(80);
          if (mode === 'read-failure') throw Object.assign(Error('component read failed'), { status: 503 });
          return snapshot();
        } finally { reading = false; }
      }
      writes++;
      if (mode === 'conflict') throw Object.assign(Error('conflict'), { status: 409 });
      assert.ok(['PUT','POST'].includes(method)); assert.ok(method === 'POST' ? route === '/devices' : route.startsWith('/devices/')); assert.equal(input.revision, revision);
      lastInput = { ...input }; revision = (revision[0] === 'a' ? 'b' : 'c').repeat(64);
      if (route.endsWith('/video')) {
        const deviceId = route.split('/').at(-2);
        videos = [...videos.filter(video => video.deviceId !== deviceId), { deviceId, username: input.username }];
      } else devices = method === 'POST' ? [...devices, {deviceId: input.deviceId, username: input.username}] : devices.map(device => device.deviceId === route.split('/').at(-1) ? { ...device, username: input.username } : device);
      return { ok: true, requiresReconnect: true, ...snapshot() };
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
      throw Error('Condition timed out: ' + expression + '\n' + await evaluate('JSON.stringify({auth:BoatAuth.state(),status:document.getElementById("mqttDeviceStatus").textContent,videoStatus:document.getElementById("videoDeviceStatus").textContent})') + '\n' + errors.join('\n'));
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
      assert.equal(await evaluate('document.getElementById("platformSettingsDialog").scrollWidth>document.getElementById("platformSettingsDialog").clientWidth+1'), false, width + 'px dialog must fit');
      assert.equal(await evaluate('document.getElementById("mqttDeviceSettings").scrollWidth>document.getElementById("mqttDeviceSettings").clientWidth+1'), false, width + 'px device panel must fit');
      if (theme === 'light') {
        await until('getComputedStyle(document.getElementById("mqttDeviceRead")).color==="rgb(50, 50, 81)"');
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
    const readsBeforeOpen = helperReads;
    await evaluate('document.getElementById("platformSettingsToggle").click()');
    await until('document.getElementById("mqttDeviceList").children.length===2&&!boatMonitor.mqttDevices.busy&&document.getElementById("videoDeviceList").children.length===2&&!document.getElementById("videoDeviceList").hidden&&!document.getElementById("videoDeviceRead").disabled');
    assert.equal(helperReads - readsBeforeOpen, 1, 'both account panels share one privileged read');
    assert.equal(overlappingReads, 0, 'opening settings never enters the worker concurrently');
    assert.equal(await evaluate('document.getElementById("mqttDeviceSettings").hidden'), false);
    assert.equal(await evaluate('document.getElementById("videoDeviceSettings").hidden'), false);
    assert.ok(await evaluate('document.getElementById("videoDeviceList").textContent.includes("boat-01-video")'));
    assert.equal(await evaluate('boatMonitor.link.connected'), true); assert.equal(await evaluate('window.testConnections'), connectionCount);
    await evaluate('[...document.getElementById("videoDeviceList").children].find(row=>row.querySelector("strong").textContent==="boat-01").querySelector("button").click();document.getElementById("videoDeviceUsername").value="video-draft-account";document.getElementById("videoDevicePassword").value="browser-video-draft-secret"');
    await evaluate('BoatAuth.initialize()');
    assert.equal(await evaluate('document.getElementById("videoDeviceForm").hidden'), false, 'unchanged administrator refresh preserves the video editor');
    assert.equal(await evaluate('document.getElementById("videoDeviceUsername").value'), 'video-draft-account');
    assert.equal(await evaluate('document.getElementById("videoDevicePassword").value'), 'browser-video-draft-secret');
    assert.equal(await evaluate('document.getElementById("videoDeviceRead").disabled'), false);
    await evaluate('document.getElementById("videoDeviceCancel").click()');
    assert.equal(await evaluate('document.getElementById("videoDevicePassword").value'), '');
    mode = 'read-failure';
    const readsBeforeFailure = helperReads;
    await evaluate('document.getElementById("mqttDeviceRead").click();document.getElementById("videoDeviceRead").click()');
    await until('document.getElementById("mqttDeviceStatus").dataset.tone==="error"&&document.getElementById("videoDeviceStatus").dataset.tone==="error"&&!boatMonitor.mqttDevices.busy&&!document.getElementById("videoDeviceRead").disabled');
    assert.equal(helperReads - readsBeforeFailure, 1, 'a failed shared read is dispatched only once');
    mode = 'ready';
    await evaluate('document.getElementById("mqttDeviceRead").click();document.getElementById("videoDeviceRead").click()');
    await until('boatMonitor.mqttDevices.loaded&&!boatMonitor.mqttDevices.busy&&!document.getElementById("videoDeviceList").hidden&&!document.getElementById("videoDeviceRead").disabled&&document.getElementById("videoDeviceStatus").dataset.tone!=="error"');
    assert.equal(helperReads - readsBeforeFailure, 2, 'retry reaches the component instead of retaining a rejected promise');
    assert.equal(overlappingReads, 0);
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
    await evaluate('document.getElementById("mqttDeviceAdd").click()');
    await until('boatMonitor.mqttDevices.creating&&!document.getElementById("mqttDeviceId").readOnly');
    await evaluate('document.getElementById("mqttDeviceId").value="boat-03"');
    await fill('vessel-three', 'browser-new-boat-secret');
    await layout(1440, 'dark', 'mqtt-device-create-desktop'); await layout(320, 'light', 'mqtt-device-create-mobile-320-light');
    await save(); await saved();
    assert.equal(writes, 3); assert.equal(lastInput.deviceId, 'boat-03'); assert.equal(lastInput.username, 'vessel-three');
    assert.equal(devices.length, 3); assert.equal(await evaluate('document.getElementById("mqttDevicePassword").value'), '');
    assert.ok(confirmations.at(-1).includes('boat-03') && !confirmations.at(-1).includes('browser-new-boat-secret'));
    await evaluate('document.getElementById("mqttDeviceAdd").click();document.getElementById("mqttDeviceId").value="boat-03"');
    await fill('duplicate-boat', 'browser-duplicate-secret'); await save();
    await until('document.getElementById("mqttDeviceStatus").textContent.includes("已存在")'); assert.equal(writes, 3);
    await evaluate('document.getElementById("mqttDeviceId").value="boat-04"');
    await fill('vessel-four', 'browser-new-conflict-secret'); mode = 'conflict'; await save();
    await until('!boatMonitor.mqttDevices.busy&&!boatMonitor.mqttDevices.loaded'); assert.equal(writes, 4);
    assert.equal(devices.length, 3); assert.equal(await evaluate('document.getElementById("mqttDevicePassword").value'), '');
    mode = 'ready'; await evaluate('document.getElementById("mqttDeviceRead").click()');
    await until('boatMonitor.mqttDevices.loaded&&!boatMonitor.mqttDevices.busy');
    await edit('boat-01');
    await layout(1440, 'dark', 'mqtt-device-desktop'); await layout(1440, 'light', 'mqtt-device-desktop-light');
    await layout(375, 'dark', 'mqtt-device-mobile-375'); await layout(320, 'light', 'mqtt-device-mobile-320-light');
    await layout(320, 'dark', 'mqtt-device-mobile-320');
    await fill('conflicting-account', 'browser-conflict-secret'); mode = 'conflict'; await save();
    await until('document.getElementById("mqttDeviceStatus").dataset.tone==="error"&&!boatMonitor.mqttDevices.busy');
    assert.equal(writes, 5); assert.equal(await evaluate('boatMonitor.mqttDevices.loaded'), false);
    assert.equal(await evaluate('document.getElementById("mqttDeviceSave").disabled'), true);
    mode = 'unavailable'; await evaluate('document.getElementById("mqttDeviceRead").click()');
    await until('document.getElementById("mqttDeviceStatus").textContent.includes("启用一次")&&!boatMonitor.mqttDevices.busy');
    assert.equal(await evaluate('document.getElementById("mqttDeviceList").hidden'), true);
    mode = 'ready'; await evaluate('document.getElementById("mqttDeviceRead").click()');
    await until('boatMonitor.mqttDevices.loaded&&!boatMonitor.mqttDevices.busy');
    await evaluate('document.getElementById("videoDeviceRead").click()');
    await until('!document.getElementById("videoDeviceList").hidden&&!document.getElementById("videoDeviceRead").disabled&&document.getElementById("videoDeviceList").children.length===3');
    await evaluate('[...document.getElementById("videoDeviceList").children].find(row=>row.querySelector("strong").textContent==="boat-01").querySelector("button").click();document.getElementById("videoDeviceUsername").value="boat-01-video-updated";document.getElementById("videoDevicePassword").value="browser-video-secret";document.getElementById("videoDevicePasswordConfirm").value="browser-video-secret";document.getElementById("videoDeviceForm").requestSubmit()');
    await until('document.getElementById("videoDeviceStatus").dataset.tone==="success"&&!document.getElementById("videoDeviceRead").disabled');
    assert.equal(writes, 6);
    assert.equal(lastInput.username, 'boat-01-video-updated');
    assert.equal(lastInput.password, 'browser-video-secret');
    assert.equal(await evaluate('document.getElementById("videoDevicePassword").value'), '');
    assert.ok(await evaluate('document.getElementById("videoDeviceList").textContent.includes("boat-01-video-updated")'));
    assert.equal(devices[0].username, 'vessel-one', 'video save preserves the boat telemetry account');
    assert.equal(overlappingReads, 0);
    await evaluate('document.getElementById("mqttDeviceAdd").click();document.getElementById("mqttDeviceId").value="boat-04"'); await fill('draft-account', 'browser-draft-secret');
    await evaluate('document.getElementById("platformSettingsClose").click()');
    await until('!boatMonitor.mqttDevices.isOpen');
    assert.equal(await evaluate('document.getElementById("mqttDevicePassword").value'), '');
    assert.equal(await evaluate('document.getElementById("mqttDeviceId").value'), '');
    assert.equal(await evaluate('boatMonitor.mqttDevices.loaded'), false);
    await evaluate('document.getElementById("accountLogout").click()'); await until('!BoatAuth.user&&!BoatAuth.busy');
    await evaluate('document.getElementById("accountLoginOpen").click();document.getElementById("accountUsername").value="observer";document.getElementById("accountPassword").value="browser-guest-test-only";document.getElementById("accountLoginForm").requestSubmit()');
    await until('BoatAuth.user?.role==="guest"&&!BoatAuth.busy');
    assert.equal(await evaluate('document.getElementById("mqttDeviceSettings").hidden'), true);
    assert.equal(await evaluate('document.getElementById("videoDeviceSettings").hidden'), true);
    assert.equal(await evaluate('fetch("/api/mqtt/devices").then(response=>response.status)'), 403);
    assert.equal(await evaluate('[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>/browser-device-secret|browser-draft-secret|browser-conflict-secret|browser-new-boat-secret|browser-new-conflict-secret|browser-duplicate-secret|browser-video-secret|browser-video-draft-secret/.test(String(value)))'), false);
    assert.deepEqual(errors, []);
    console.log('Chrome MQTT device settings passed: concurrent device/video panels share the exclusive helper, real auth refresh preserves video drafts, failed reads recover, video credentials save independently, new-boat provisioning and duplicate/conflict checks, device/offline-device edits, confirmation cancel/accept, unavailable component, guest403, draft cleanup and 1440/375/320px dark/light layouts.');
  } finally {
    socket?.close(); browser.kill(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
    if (path.dirname(run) === output && path.basename(run).startsWith('mqtt-device-settings-state-')) fs.rmSync(run, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
