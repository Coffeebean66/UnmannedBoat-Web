/* 真实本机认证/用户库/SSE；不访问生产服务，地图瓦片在浏览器中阻断。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createFixtureServer, fixtureScript } = require('./mqtt-browser-fixture.cjs');
const output = path.resolve(__dirname, '../.test-output'), wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const run = fs.mkdtempSync(path.join(output, 'user-management-state-'));
  const storeFile = path.join(run, 'accounts.json');
  const server = createFixtureServer({ accountOptions: { storeFile }, mapOptions: { file: path.join(run, 'map-settings.json') } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(output, 'chrome-user-management-')), errors = [];
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
      for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await wait(70); }
      throw Error('Condition timed out: ' + expression + '\n' + await evaluate('JSON.stringify({auth:BoatAuth.state(),status:document.getElementById("userManagementStatus").textContent,form:document.getElementById("userManagementForm").hidden})') + '\n' + errors.join('\n'));
    };
    const shot = async name => {
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
    };
    const login = async (username, password) => {
      await evaluate('document.getElementById("accountUsername").value=' + JSON.stringify(username) + ';document.getElementById("accountPassword").value=' + JSON.stringify(password) + ';document.getElementById("accountLoginForm").requestSubmit()');
      await until('BoatAuth.user?.username===' + JSON.stringify(username) + '&&!BoatAuth.busy&&!document.getElementById("accountLoginDialog").open');
    };
    const logout = async () => {
      await evaluate('document.getElementById("accountLogout").click()'); await until('!BoatAuth.user&&!BoatAuth.busy');
      await evaluate('document.getElementById("accountLoginOpen").click()');
    };
    const edit = async username => {
      await evaluate('[...document.getElementById("userManagementList").children].find(row=>row.querySelector("strong").textContent===' + JSON.stringify(username) + ').querySelector("button").click()');
      await until('!document.getElementById("userManagementForm").hidden');
    };
    const fill = async (username, role, password, confirmation = password) => {
      await evaluate('document.getElementById("userUsername").value=' + JSON.stringify(username) + ';document.getElementById("userRole").value=' + JSON.stringify(role) + ';document.getElementById("userPassword").value=' + JSON.stringify(password) + ';document.getElementById("userPasswordConfirm").value=' + JSON.stringify(confirmation));
    };
    const save = async () => { await evaluate('document.getElementById("userManagementForm").requestSubmit()'); };
    const saved = async () => { await until('document.getElementById("userManagementStatus").dataset.tone==="success"&&!document.getElementById("userManagementCreate").disabled'); };
    const layout = async (width, theme, name) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 820 : 1000, deviceScaleFactor: 1, mobile: width < 600 });
      await evaluate('if(document.documentElement.dataset.theme!==' + JSON.stringify(theme) + ')document.getElementById("themeToggle").click();document.querySelector("#platformSettingsDialog .dialog-scroll").scrollTop=0');
      await wait(200);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, width + 'px page must fit');
      assert.equal(await evaluate('document.getElementById("platformSettingsDialog").scrollWidth>document.getElementById("platformSettingsDialog").clientWidth+1'), false, width + 'px dialog must fit');
      assert.equal(await evaluate('document.getElementById("userManagement").scrollWidth>document.getElementById("userManagement").clientWidth+1'), false, width + 'px user panel must fit');
      if (theme === 'light') assert.equal(await evaluate('getComputedStyle(document.getElementById("userManagementRead")).color'), 'rgb(50, 50, 81)', 'light-theme utility buttons use the dark platform text color');
      await shot(name);
    };

    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*://tile.openstreetmap.org/*', '*://webapi.amap.com/*'] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript + '\n' + '(' + function () {
      const original = window.fetch.bind(window); window.testUserMutations = 0;
      window.fetch = (url, options) => { if (String(url).startsWith('/api/auth/users') && options?.method && options.method !== 'GET') window.testUserMutations++; return original(url, options); };
    }.toString() + ')();' });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await until('!!window.boatMonitor&&BoatAuth.ready&&document.getElementById("accountLoginDialog").open');
    await login('operator', 'browser-admin-test-only');
    await until('document.getElementById("cloudDevice").value==="boat-mqtt-test"&&!document.getElementById("connectButton").disabled');
    await evaluate('document.getElementById("connectButton").click()'); await until('boatMonitor.link.connected');
    await evaluate('document.getElementById("platformSettingsToggle").click()');
    await until('document.getElementById("userManagementList").children.length===2&&!document.getElementById("userManagementCreate").disabled');
    assert.equal(server.boatCloudApi.getClientCount(), 2);
    const connectionCount = await evaluate('window.testConnections');

    await evaluate('document.getElementById("userManagementCreate").click()');
    await fill('crew-01', 'guest', 'crew-initial-password', 'different-password'); await save();
    await until('document.getElementById("userManagementStatus").textContent.includes("不一致")');
    assert.equal(await evaluate('window.testUserMutations'), 0);
    assert.equal(await evaluate('document.getElementById("userPassword").value'), '');
    await fill('crew-01', 'guest', 'crew-initial-password'); await save(); await saved();
    await evaluate('document.getElementById("userManagementCreate").click()'); await fill('skipper-02', 'admin', 'skipper-admin-password'); await save(); await saved();
    assert.equal(await evaluate('document.getElementById("userManagementList").children.length'), 4);
    await edit('crew-01'); await fill('watcher-01', 'guest', 'watcher-new-password'); await save(); await saved();
    assert.equal(await evaluate('boatMonitor.link.connected'), true); assert.equal(await evaluate('window.testConnections'), connectionCount);
    assert.equal(server.boatCloudApi.getClientCount(), 2);
    const storage = fs.readFileSync(storeFile, 'utf8');
    for (const password of ['browser-admin-test-only', 'crew-initial-password', 'watcher-new-password', 'skipper-admin-password']) assert.ok(!storage.includes(password), 'passwords are never stored in plaintext');
    await layout(1440, 'dark', 'user-management-desktop');
    await edit('watcher-01'); await layout(1440, 'dark', 'user-management-edit');
    await layout(1440, 'light', 'user-management-desktop-light');
    await layout(375, 'dark', 'user-management-mobile-375');
    await layout(320, 'light', 'user-management-mobile-320-light');
    await layout(320, 'dark', 'user-management-mobile-320');
    await evaluate('document.getElementById("userManagementCancel").click()');

    await edit('operator'); await fill('captain-01', 'admin', 'captain-new-password');
    assert.equal(await evaluate('document.getElementById("userSelfNotice").hidden'), false); await save();
    await until('!BoatAuth.user&&document.getElementById("accountLoginDialog").open');
    assert.equal(await evaluate('boatMonitor.link.wanted'), false); assert.equal(server.boatCloudApi.getClientCount(), 0);
    assert.equal(await evaluate('document.getElementById("userPassword").value'), '');
    assert.match(await evaluate('document.getElementById("toast").textContent'), /重新登录/);
    await evaluate('document.getElementById("accountUsername").value="operator";document.getElementById("accountPassword").value="browser-admin-test-only";document.getElementById("accountLoginForm").requestSubmit()');
    await until('!BoatAuth.busy&&document.getElementById("accountLoginError").textContent.length>0');
    assert.equal(await evaluate('!!BoatAuth.user'), false);
    await login('captain-01', 'captain-new-password'); await logout();
    await evaluate('document.getElementById("accountUsername").value="watcher-01";document.getElementById("accountPassword").value="crew-initial-password";document.getElementById("accountLoginForm").requestSubmit()');
    await until('!BoatAuth.busy&&document.getElementById("accountLoginError").textContent.length>0');
    assert.equal(await evaluate('!!BoatAuth.user'), false);
    await login('watcher-01', 'watcher-new-password');
    assert.equal(await evaluate('document.getElementById("platformSettingsToggle").hidden'), true);
    assert.equal(await evaluate('fetch("/api/auth/users").then(response=>response.status)'), 403);
    await send('Page.navigate', { url }); await until('window.BoatAuth?.ready&&window.BoatAuth.user?.username==="watcher-01"');
    assert.equal(await evaluate('BoatAuth.user.role'), 'guest');
    await logout(); await login('skipper-02', 'skipper-admin-password');
    await evaluate('document.getElementById("platformSettingsToggle").click()');
    await until('document.getElementById("userManagementList").children.length===4');
    assert.equal(await evaluate('document.getElementById("userManagement").hidden'), false);
    assert.equal(await evaluate('[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>/captain-new-password|watcher-new-password|skipper-admin-password|crew-initial-password/.test(String(value)))'), false);
    assert.deepEqual(errors, []);
    console.log('Chrome user management passed: real local auth/store/SSE, admin creation and user edits, password confirmation, self-session revocation and relogin, guest403, refreshed new-user login, 1440/375/320px dark/light layouts.');
  } finally {
    socket?.close(); browser.kill(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
    if (path.dirname(run) === output && path.basename(run).startsWith('user-management-state-')) fs.rmSync(run, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
