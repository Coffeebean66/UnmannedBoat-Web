/* 真 Chrome 的更新弹窗集成测试；更新 API 全部替身，不连接生产服务器。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('../server');
const output = path.resolve(__dirname, '../.test-output');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const mock = '(' + function () {
  const original = window.fetch.bind(window), oldCommit = '1'.repeat(40), latest = '2'.repeat(40);
  window.updateTest = { enabled: true, authorized: false, job: null, current: oldCommit, statusReads: 0,
    calls: [], started: false, mode: 'idle' };
  const response = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options = {}) => {
    if (!String(url).startsWith('/api/update/')) return original(url, options);
    const t = window.updateTest, route = String(url).split('/').pop();
    t.calls.push({ route, method: options.method || 'GET', body: route === 'login' ? '<redacted>' : options.body,
      ticket: !!options.headers?.['X-Boat-Update-Ticket'] });
    if (route === 'config') return response(200, { enabled: t.enabled, requiresLogin: true, apiVersion: 1 });
    if (route === 'login') {
      t.authorized = JSON.parse(options.body).password === 'test-update-admin-only';
      return response(t.authorized ? 200 : 401, { error: '更新管理密码错误' });
    }
    if (route === 'session') { t.authorized = false; return response(200, { ok: true }); }
    if (!t.authorized && !(route === 'status' && options.headers?.['X-Boat-Update-Ticket'])) return response(401, { error: '需要更新管理员登录' });
    if (route === 'check') return response(200, { latestCommit: latest, available: t.current !== latest });
    if (route === 'start') {
      if (JSON.parse(options.body).expectedCommit !== latest) return response(409, { error: '候选提交不一致' });
      t.started = true; t.statusReads = 0; t.mode = 'running';
      t.job = { id: 'browser-test-job', status: 'queued', phase: 'queued', expectedCommit: latest, message: '等待更新测试任务' };
      return response(202, { job: t.job, ticket: 'browser-test-read-only-ticket' });
    }
    if (route === 'status') {
      if (t.started) {
        t.statusReads++;
        if (t.mode === 'offline') return response(503, { error: '测试：服务正在重启' });
        if (t.mode === 'succeeded') { t.job = { ...t.job, targetCommit: latest, status: 'succeeded', phase: 'complete', message: '新版本启动成功' }; t.current = latest; }
        else if (t.mode === 'old-instance') t.job = { ...t.job, targetCommit: latest, status: 'succeeded', phase: 'complete' };
        else t.job = { ...t.job, status: 'running', phase: 'building', message: '正在验证并构建测试版本' };
      }
      return response(200, { current: { version: t.current === latest ? '1.4.1' : '1.4.0', commit: t.current, instanceId: t.current }, job: t.job,
        repository: { url: 'https://github.com/Coffeebean66/UnmannedBoat-Web', branch: 'main' } });
    }
    return response(404, { error: 'Unexpected test route' });
  };
}.toString() + ')();';

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(output, 'chrome-update-')), errors = [];
  const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--remote-debugging-port=0', '--user-data-dir=' + profile
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
    const pending = new Map(); let serial = 0;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => reject(Error('CDP timeout: ' + method)), 15000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await wait(75); }
      const diagnostics = await evaluate("({status:document.getElementById('updateStatus')?.textContent,open:document.getElementById('updateDialog')?.open,loginHidden:document.getElementById('updateLoginForm')?.hidden,busy:document.getElementById('updateLoginSubmit')?.disabled,calls:window.updateTest?.calls})");
      await shot('update-browser-failure');
      throw Error('Condition timed out: ' + expression + '\n' + JSON.stringify(diagnostics) + '\n' + errors.join('\n'));
    };
    const shot = async name => {
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
    };
    const bounds = () => evaluate("(()=>{const d=document.getElementById('updateDialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,innerWidth,innerHeight,overflow:d.scrollWidth>d.clientWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth};})()");
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: mock });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    await until("!!window.boatMonitor && !!document.getElementById('updateToggle') && typeof window.BoatUpdateController==='function'");
    await evaluate("document.getElementById('updateToggle').click()");
    await until("!document.getElementById('updateLoginForm').hidden && !document.getElementById('updateLoginSubmit').disabled");
    assert.equal(await evaluate("document.getElementById('updateDialog').open"), true);
    assert.equal(await evaluate("document.getElementById('cloudLoginDialog').open"), false);
    await shot('update-desktop-login');
    await evaluate("document.getElementById('updatePassword').value='cloud-monitor-password';document.getElementById('updateLoginForm').requestSubmit()");
    await until("document.getElementById('updateStatus').textContent.includes('密码错误')");
    assert.equal(await evaluate("document.getElementById('updatePassword').value"), '');
    await evaluate("document.getElementById('updatePassword').value='test-update-admin-only';document.getElementById('updateLoginForm').requestSubmit()");
    await until("!document.getElementById('updateStart').disabled");
    assert.equal(await evaluate("document.getElementById('updateLatestCommit').textContent"), '2222222222');
    assert.equal(await evaluate("[...Object.values(sessionStorage),...Object.values(localStorage)].some(x=>String(x).includes('test-update-admin-only'))"), false);
    const desktop = await bounds(); assert.equal(desktop.overflow, false); assert.equal(desktop.pageOverflow, false);
    assert.ok(desktop.width > 500 && desktop.right < 1440); await shot('update-desktop-ready');
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true }); await wait(150);
    const mobile = await bounds();
    assert.equal(mobile.overflow, false); assert.equal(mobile.pageOverflow, false);
    assert.ok(mobile.left >= 0 && mobile.right <= 320 && mobile.top >= 0 && mobile.bottom <= 740);
    assert.equal(await evaluate("(()=>{const b=document.getElementById('updateStart').getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;})()"), true);
    await shot('update-mobile-ready');
    await evaluate("document.getElementById('updateStart').click();document.getElementById('updateStart').click()");
    await until('updateTest.started');
    assert.equal(await evaluate("updateTest.calls.filter(x=>x.route==='start').length"), 1);
    assert.equal(await evaluate("document.getElementById('updateCheck').disabled"), true);
    assert.equal(await evaluate("document.getElementById('updateBusyDot').hidden"), false);
    assert.equal(await evaluate("!!sessionStorage.getItem('boat_web_update_ticket_v1')"), true);
    await evaluate("updateTest.mode='offline';updateTest.authorized=false");
    await until("document.getElementById('updateStatus').textContent.includes('自动重连')");
    assert.equal(await evaluate("document.getElementById('updateRefresh').hidden"), true); await shot('update-mobile-restarting');
    await evaluate("document.getElementById('updateClose').click()");
    await until("!document.documentElement.classList.contains('update-modal-open')");
    await evaluate("document.getElementById('updateToggle').click();updateTest.mode='old-instance'");
    await until("document.getElementById('updateStatus').textContent.includes('核对提交')");
    assert.equal(await evaluate("document.getElementById('updateRefresh').hidden"), true);
    await evaluate("updateTest.mode='succeeded'");
    await until("!document.getElementById('updateRefresh').hidden");
    assert.match(await evaluate("document.getElementById('updateStatus').textContent"), /更新成功/);
    assert.equal(await evaluate("sessionStorage.getItem('boat_web_update_ticket_v1')"), null);
    assert.equal(await evaluate("document.getElementById('updateCurrentVersion').textContent"), '1.4.1');
    assert.equal(await evaluate("updateTest.calls.filter(x=>x.route==='status'&&x.ticket).length>=3"), true);
    assert.equal(await evaluate("document.getElementById('connectionBadge').textContent"), '未连接');
    await shot('update-mobile-succeeded');
    await evaluate("document.getElementById('updateClose').click();updateTest.enabled=false;document.getElementById('updateToggle').click()");
    await until("document.getElementById('updateStatus').textContent.includes('安装')");
    assert.equal(await evaluate("document.getElementById('updateStart').disabled"), true);
    assert.deepEqual(errors, []);
    console.log('Chrome update panel passed: 1440px / 320px, independent admin login, exact commit, single job, restart recovery, verified success, unconfigured state.');
    console.log('Screenshots: ' + output);
  } finally {
    if (socket) socket.close(); browser.kill(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
