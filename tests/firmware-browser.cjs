/* 真实页面中的按船固件入口、二进制上传、安装确认及窄屏布局；设备协议由后端专项覆盖。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const { createFixtureServer, fixtureScript } = require('./mqtt-browser-fixture.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = path.resolve(__dirname, '..'), output = path.join(root, '.test-output'); fs.mkdirSync(output, { recursive: true });
  const server = createFixtureServer(), original = server.listeners('request')[0], calls = [], deviceId = 'boat-mqtt-test';
  let supported = false, currentJob = null, upload = null;
  const snapshot = () => ({ deviceId, supported, online: true, capability: supported ? { ready: true, state: 'idle' } : null, job: currentJob });
  server.removeListener('request', original);
  server.on('request', async (req, res) => {
    if (!req.url.startsWith('/api/firmware/')) return original(req, res);
    calls.push({ method: req.method, url: req.url }); const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), json = data => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (req.url.endsWith('/config')) return json({ enabled: true, maxSize: 655360, chunkSize: 256 });
    if (req.method === 'POST' && req.url.endsWith('/cancel')) currentJob = { ...currentJob, state: 'cancelled', cancelable: false };
    else if (req.method === 'POST') {
      upload = { bytes, name: decodeURIComponent(req.headers['x-firmware-name']), type: req.headers['content-type'], url: req.url };
      currentJob = { id: 'test', deviceId, name: upload.name, size: bytes.length, sha256: 'a'.repeat(64), state: 'transferring', receivedBytes: 256, progress: 25, cancelable: true, error: null };
    }
    json(snapshot());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(output, 'chrome-firmware-')), errors = [];
  const browser = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome'),
    ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', error => errors.push(error.message)); let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile) && !errors.length; i++) await wait(100);
    if (!fs.existsSync(portFile)) throw Error(errors.join('\n') || 'Chrome did not start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0], pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let serial = 0; const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => reject(Error('CDP timeout: ' + method)), 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
    const until = async expression => { for (let i = 0; i < 140; i++) { if (await evaluate(expression)) return; await wait(75); } throw Error('Condition timed out: ' + expression); };
    const shot = async name => { const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(image.data, 'base64')); };
    await send('Runtime.enable'); await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript + '\nwindow.confirm=()=>true;' });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    await until('window.boatMonitor && BoatAuth.ready');
    await evaluate('BoatAuth.login("operator","browser-admin-test-only")');
    await until('document.querySelector(".fleet-firmware-button:not([hidden])") && boatMonitor.link.connected');
    await evaluate('document.querySelector(".fleet-firmware-button").click()');
    await until('document.getElementById("firmwareDialog").open && document.getElementById("firmwareStatus").textContent.includes("首次")');
    assert.equal(await evaluate('document.getElementById("firmwareDevice").textContent'), deviceId);
    assert.equal(await evaluate('document.getElementById("firmwareStart").disabled'), true);
    supported = true;
    await evaluate('document.getElementById("firmwareRefresh").click()');
    await until('document.getElementById("firmwareCapability").textContent.includes("支持 OTA")');
    await evaluate('(()=>{const b=new Uint8Array(1024);new DataView(b.buffer).setUint32(0,0x20020000,true);new DataView(b.buffer).setUint32(4,0x08020101,true);const transfer=new DataTransfer();transfer.items.add(new File([b],"boat-ota.bin",{type:"application/octet-stream"}));const input=document.getElementById("firmwareFile");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()');
    assert.equal(await evaluate('document.getElementById("firmwareStart").disabled'), false);
    await shot('firmware-desktop-ready');
    await evaluate('document.getElementById("firmwareStart").click()');
    await until('document.getElementById("firmwarePhase").textContent==="传输固件"');
    assert.equal(upload.type, 'application/octet-stream'); assert.equal(upload.bytes.length, 1024); assert.equal(upload.name, 'boat-ota.bin');
    assert.equal(upload.url, '/api/firmware/boats/' + deviceId);
    await evaluate('document.getElementById("firmwareClose").click()');
    assert.equal(calls.some(call => call.url.endsWith('/cancel')), false);
    await evaluate('document.querySelector(".fleet-firmware-button").click()');
    await until('document.getElementById("firmwarePhase").textContent==="传输固件"');
    currentJob = { ...currentJob, state: 'installing', receivedBytes: 1024, progress: 100, cancelable: false };
    await evaluate('document.getElementById("firmwareRefresh").click()');
    await until('document.getElementById("firmwarePhase").textContent==="等待重启验证"');
    assert.equal(await evaluate('document.getElementById("firmwareCancel").hidden'), true);
    for (const width of [1440, 390, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 500 });
      await wait(100);
      assert.equal(await evaluate('document.getElementById("firmwareDialog").scrollWidth>document.getElementById("firmwareDialog").clientWidth'), false, 'Dialog overflow at ' + width);
      await shot('firmware-' + width + '-installing');
    }
    currentJob = { ...currentJob, state: 'succeeded' };
    await evaluate('document.getElementById("firmwareRefresh").click()');
    await until('document.getElementById("firmwarePhase").textContent==="升级完成"');
    await evaluate('BoatAuth.logout()'); await until('!document.getElementById("firmwareDialog").open');
    await evaluate('BoatAuth.login("observer","browser-guest-test-only")');
    await until('document.querySelector(".fleet-card")');
    assert.equal(await evaluate('document.querySelector(".fleet-firmware-button").hidden'), true);
    assert.equal(await evaluate('document.getElementById("firmwareToggle").hidden'), true);
    assert.deepEqual(errors, []); console.log('Firmware browser passed: per-boat upload, legacy gate, background task, install confirmation, guest access and 320–1440px.');
  } finally { socket?.close(); browser.kill(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
