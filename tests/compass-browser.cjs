/* 真实 Chrome + 本地 HTTP/SSE 遥测：检查航海罗盘的数据来源、失效处理和窄屏布局。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createFixtureServer, fixtureScript } = require('./mqtt-browser-fixture.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const output = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(output, { recursive: true });
  const run = fs.mkdtempSync(path.join(output, 'compass-state-'));
  // 所有账户和历史均为本次测试的临时数据，禁止沿用开发机的真实账户库。
  const server = createFixtureServer({ env: {
    BOAT_ACCOUNTS_FILE: path.join(run, 'accounts.json'),
    BOAT_MAP_CONFIG_FILE: path.join(run, 'map.json'),
    BOAT_TELEMETRY_HISTORY_FILE: path.join(run, 'history.json'),
    BOAT_OTA_KEY: ''
  } });
  server.mqttFixture.running = false;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(output, 'chrome-compass-')), errors = [];
  const browser = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome'),
    ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  browser.on('error', error => errors.push(error.message)); let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile) && !errors.length; attempt++) await wait(100);
    if (!fs.existsSync(portFile)) throw Error(errors.join('\n') || 'Chrome did not start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let serial = 0; const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      const item = pending.get(message.id);
      if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); }
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
      for (let attempt = 0; attempt < 120; attempt++) { if (await evaluate(expression)) return; await wait(75); }
      throw Error('Condition timed out: ' + expression + '\n' + errors.join('\n'));
    };
    const data = () => evaluate("(()=>{const el=document.getElementById('boatCompass');const text=selector=>el.querySelector(selector)?.textContent;return {valid:el.dataset.valid,source:el.dataset.source,heading:el.dataset.heading,target:el.dataset.target,course:el.dataset.course,headingText:text('.compass-heading-value'),targetText:text('.compass-target-value'),courseText:text('.compass-course-value'),speedText:text('.compass-speed-value'),turnText:text('.compass-turn-value'),targetVisible:el.querySelector('.compass-target-pointer').style.display!=='none',courseVisible:el.querySelector('.compass-course-pointer').style.display!=='none',label:el.querySelector('svg').getAttribute('aria-label')};})()");
    const feed = async overrides => { await evaluate('window.telemetryOverrides=' + JSON.stringify(overrides) + ';feedTelemetry()'); };
    const navigate = async view => {
      await evaluate('BoatWorkspace.navigate(' + JSON.stringify(view) + ',{focus:false})');
      await until('BoatWorkspace.current===' + JSON.stringify(view)); await wait(180);
    };
    const shot = async name => {
      await evaluate("document.getElementById('compassCard').scrollIntoView({block:'center',behavior:'instant'})"); await wait(180);
      const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
    };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    // 不请求公网地图或生产服务器；在线状态来自同一进程的模拟船只。
    await send('Network.setBlockedURLs', { urls: ['https://*', 'http://tile.openstreetmap.org/*'] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/#overview' });
    await until('window.boatMonitor && BoatAuth.ready && window.BoatCompassView && boatMonitor.compass');
    let current = await data(); assert.equal(current.valid, 'false'); assert.equal(current.heading, '--'); assert.equal(current.headingText, '--');
    assert.equal(current.targetVisible, false); assert.equal(current.courseVisible, false);
    await evaluate('connectTestBoat()');
    await feed({ actualHeading: 45, targetHeading: 90, rtkHeading: 200, x: 1.5, y: .4 });
    await until("document.getElementById('boatCompass').dataset.heading==='45'");
    current = await data(); assert.equal(current.valid, 'true'); assert.equal(current.source, 'fused'); assert.equal(current.target, '90');
    assert.ok(Math.abs(Number(current.course) - Math.atan2(1.5, .4) * 180 / Math.PI) < .01, 'COG uses east/north velocity, independently of bow heading');
    assert.ok(current.targetVisible && current.courseVisible); assert.match(current.label, /45/);
    assert.match(await evaluate("document.getElementById('compassCard').textContent"), /真北|真航向/);
    await shot('compass-overview-desktop');

    // 四个基本方位经真实二进制协议、服务器 SSE、页面适配器进入罗盘。
    for (const heading of [0, 90, 180, 270]) {
      await feed({ actualHeading: heading, targetHeading: 315, rtkHeading: 120, x: 1, y: 0 });
      await until("document.getElementById('boatCompass').dataset.heading==='" + heading + "'");
      current = await data(); assert.equal(current.source, 'fused'); assert.equal(Number(current.course), 90);
    }
    await feed({ headingFlags: 0, rtkHeading: 270, targetHeading: 300, x: 0, y: -2 });
    await until("document.getElementById('boatCompass').dataset.source==='rtk'");
    current = await data(); assert.equal(current.heading, '270'); assert.equal(Number(current.course), 180);
    await feed({ headingFlags: 0, rtkFlags: 14, rtkHeading: 120, targetHeading: 170, x: 0, y: 0 });
    await until("document.getElementById('boatCompass').dataset.heading==='120' && document.getElementById('boatCompass').dataset.course==='--'");
    current = await data(); assert.equal(current.valid, 'true'); assert.equal(current.target, '170'); assert.equal(current.courseVisible, false, 'Stationary RTK does not invent a course');
    await feed({ mode: 1, actualHeading: 180, targetHeading: 170 });
    await until("document.getElementById('boatCompass').dataset.target==='--'");
    assert.equal((await data()).targetVisible, false, 'Target pointer is available only in heading mode');
    await feed({ headingFlags: 0, rtkFlags: 3, x: 1, y: 0, yaw: 32 });
    await until("document.getElementById('boatCompass').dataset.valid==='false'");
    current = await data(); assert.equal(current.heading, '--'); assert.equal(current.source, 'none');
    assert.equal(current.headingText, '--'); assert.equal(current.targetVisible, false); assert.equal(current.courseVisible, false, 'A relative dial cannot show a course pointer without bow heading');

    await feed({ actualHeading: 359, targetHeading: 1, x: 1, y: 1 });
    await until("document.getElementById('boatCompass').dataset.valid==='true'");
    await evaluate("window.__compassHost=document.getElementById('boatCompass');window.__compassSvg=__compassHost.querySelector('svg')");
    for (const view of ['attitude', 'overview']) {
      await navigate(view);
      assert.equal(await evaluate("document.getElementById('boatCompass')===window.__compassHost && document.getElementById('boatCompass').querySelector('svg')===window.__compassSvg"), true, 'Workspace changes keep the same instrument and SVG');
      assert.equal(await evaluate("document.querySelectorAll('#boatCompass').length"), 1);
      assert.ok(await evaluate("document.getElementById('compassCard').getBoundingClientRect().width>0"), 'Compass visible on ' + view);
      assert.equal(await evaluate("document.getElementById('sensorTelemetry').contains(document.getElementById('compassCard'))"), true, 'Compass belongs to the sensor panel on ' + view);
    }
    await navigate('navigation');
    assert.equal(await evaluate("document.getElementById('compassCard').getBoundingClientRect().width"), 0, 'Map page does not display the sensor compass');
    assert.equal(await evaluate("document.getElementById('navigation').contains(document.getElementById('compassCard'))"), false, 'Compass is no longer a map overlay');
    await navigate('attitude');
    let besideObserved = false, belowObserved = false;
    for (const [width, theme] of [[2048, 'dark'], [1920, 'dark'], [1920, 'light'], [1440, 'dark'], [1440, 'light'], [390, 'dark'], [390, 'light'], [320, 'dark'], [320, 'light']]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 500 });
      await evaluate('if(document.documentElement.dataset.theme!==' + JSON.stringify(theme) + ')document.getElementById("themeToggle").click()');
      await wait(150);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, 'Page overflow at ' + width);
      assert.equal(await evaluate("(()=>{const c=document.getElementById('compassCard');return c.scrollWidth>c.clientWidth;})()"), false, 'Compass card overflow at ' + width);
      const layout = await evaluate("(()=>{const h=document.getElementById('boatCompass'),r=h.querySelector('svg').getBoundingClientRect(),p=h.getBoundingClientRect(),c=document.getElementById('compassCard').getBoundingClientRect(),s=document.getElementById('sensorTelemetry'),m=s.getBoundingClientRect(),i=s.querySelector('.sensor-instruments').getBoundingClientRect(),row=s.querySelector('.sensor-attitude-layout').getBoundingClientRect(),style=getComputedStyle(s);return {svg:r.width,host:p.width,contentWidth:s.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),card:{left:c.left,right:c.right,top:c.top,bottom:c.bottom},sensor:{left:m.left,right:m.right,top:m.top,bottom:m.bottom},instruments:{left:i.left,right:i.right,top:i.top,bottom:i.bottom},rowWidth:row.width};})()");
      assert.ok(layout.svg > 140 && layout.svg <= layout.host + 1, 'Dial remains readable and within its container at ' + width);
      assert.ok(layout.card.left >= layout.sensor.left - 2 && layout.card.right <= layout.sensor.right + 2 && layout.card.top >= layout.sensor.top - 2 && layout.card.bottom <= layout.sensor.bottom + 2, 'Compass stays inside the sensor card at ' + width);
      if (layout.contentWidth >= 600) {
        besideObserved = true;
        assert.ok(layout.card.left >= layout.instruments.right - 2 && layout.card.top < layout.instruments.bottom && layout.card.bottom > layout.instruments.top, 'Wide sensor panel shows compass beside the horizon instruments at ' + width);
      } else {
        belowObserved = true;
        assert.ok(layout.card.top >= layout.instruments.bottom - 2, 'Narrow sensor panel shows compass below the horizon instruments at ' + width);
      }
      assert.equal(await evaluate("(()=>{const b=document.getElementById('compassToggle');return b.scrollWidth<=b.clientWidth+1;})()"), true, 'Compass toggle label fits at ' + width);
      await evaluate('document.getElementById("compassToggle").click()');
      assert.equal(await evaluate('document.getElementById("compassCard").hidden'), true);
      const hiddenLayout = await evaluate("(()=>{const panel=document.querySelector('#sensorTelemetry .sensor-attitude-layout'),row=panel.querySelector('.sensor-instruments');return {available:panel.getBoundingClientRect().width,instruments:row.getBoundingClientRect().width};})()");
      assert.ok(hiddenLayout.instruments >= hiddenLayout.available - 2, 'Hiding compass leaves no empty grid column at ' + width);
      await evaluate('document.getElementById("compassToggle").click()');
      await shot('compass-attitude-' + width + '-' + theme);
      // 并排后欧拉角列更窄，检查带负号的极值及角度单位仍完整显示。
      await feed({ actualHeading: 359, targetHeading: 1, x: 1, y: 1, roll: -179.99, pitch: -89.99, yaw: -179.99 });
      await until("document.getElementById('roll').textContent==='-179.99'");
      assert.equal(await evaluate("[...document.querySelectorAll('.imu-euler-values dd')].every(row=>row.scrollWidth<=row.clientWidth&&row.lastElementChild.getBoundingClientRect().right<=row.getBoundingClientRect().right+1)"), true, 'Extreme Euler numbers and units fit beside the compass at ' + width);
      if (width === 2048) await shot('compass-attitude-2048-extreme');
      await feed({ actualHeading: 359, targetHeading: 1, x: 1, y: 1 });
    }
    assert.equal(besideObserved, true, 'At least one desktop width exercises side-by-side instruments');
    assert.equal(belowObserved, true, 'Mobile widths exercise stacked instruments');

    // 显隐只控制仪表面板，不中断遥测；偏好随刷新恢复。
    await evaluate('document.getElementById("compassToggle").click()');
    assert.equal(await evaluate('document.getElementById("compassCard").hidden'), true);
    assert.equal(await evaluate('document.getElementById("compassToggle").getAttribute("aria-pressed")'), 'false');
    assert.equal(await evaluate('boatMonitor.link.connected'), true);
    await send('Page.reload');
    await until('window.boatMonitor && BoatAuth.ready && boatMonitor.compass');
    assert.equal(await evaluate('document.getElementById("compassCard").hidden'), true, 'Hidden preference survives reload');
    assert.equal(await evaluate('document.getElementById("compassToggle").getAttribute("aria-pressed")'), 'false');
    await evaluate('document.getElementById("compassToggle").click()');
    assert.equal(await evaluate('document.getElementById("compassCard").hidden'), false);
    assert.equal(await evaluate('document.getElementById("compassToggle").getAttribute("aria-pressed")'), 'true');
    await evaluate('connectTestBoat()');
    await until("document.getElementById('boatCompass').dataset.valid==='true'");

    // 独立渲染器探针避免页面200ms刷新影响跨零点动画和重置断言。
    const shortArc = await evaluate("(()=>{const h=document.createElement('div'),c=new BoatCompassView(h);const value={connected:true,headingDegrees:359,headingSource:'fused',targetDegrees:1,courseDegrees:90,speedMps:1,turnDegrees:2,status:'实时'};c.setTelemetry(value);const a=Number(c.rose.dataset.angle);c.setTelemetry({...value,headingDegrees:1,targetDegrees:359,turnDegrees:-2});const b=Number(c.rose.dataset.angle);const valid=h.dataset.valid;c.reset();const reset={heading:h.dataset.heading,target:h.dataset.target,course:h.dataset.course,valid:h.dataset.valid};c.destroy?.();return {delta:b-a,valid,reset};})()");
    assert.equal(shortArc.delta, -2, '359° → 1° turns the rose by the shortest two degrees');
    assert.equal(shortArc.valid, 'true'); assert.deepEqual(shortArc.reset, { heading: '--', target: '--', course: '--', valid: 'false' });
    const relative = await evaluate("(()=>{const h=document.createElement('div'),c=new BoatCompassView(h);c.setTelemetry({connected:true,headingDegrees:90,headingSource:'rtk',targetDegrees:180,courseDegrees:0,speedMps:2,turnDegrees:90,status:'实时'});const value={rose:Number(c.rose.dataset.angle),target:Number(c.targetPointer.dataset.angle),course:Number(c.coursePointer.dataset.angle)};c.destroy();return value;})()");
    assert.deepEqual(relative, { rose: -90, target: 90, course: -90 }, 'Head-up dial and directional pointers share the correct relative coordinate system');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#boatCompass .compass-rose')).transitionDuration"), '0s', 'Reduced motion preference disables dial transitions');
    await send('Emulation.setEmulatedMedia', { features: [] });
    await evaluate('stopTelemetry()');
    await until("document.getElementById('boatCompass').dataset.valid==='false'");
    current = await data(); assert.equal(current.headingText, '--'); assert.equal(current.targetVisible, false); assert.equal(current.courseVisible, false);
    await shot('compass-attitude-stale');
    await evaluate('startTelemetry()'); await until("document.getElementById('boatCompass').dataset.valid==='true'");
    await evaluate('document.getElementById("disconnectButton").click()');
    await until("document.getElementById('boatCompass').dataset.valid==='false'");
    assert.equal((await data()).headingText, '--');
    assert.deepEqual(errors, []);
    console.log('Compass Chrome passed: local login/binary telemetry/SSE; fused/RTK sources; cardinal/course axes; low-speed/invalid/stale/disconnect; 359→1 shortest arc; reset; shared sensor card; side-by-side/stacked/hidden layouts and extreme Euler values; 320/390/1440/1920px dark/light and 2048px side-by-side.');
  } finally {
    socket?.close(); browser.kill(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
    if (path.dirname(run) === output && path.basename(run).startsWith('compass-state-')) fs.rmSync(run, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
