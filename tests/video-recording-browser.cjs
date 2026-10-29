'use strict';
// 真实 Chrome UI 与本机模拟录像接口；真实 SRT/MP4 写盘另由媒体集成测试验证。
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..'), output = path.join(project, '.test-output'), ROOT = '/var/lib/unmanned-boat-video';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  fs.mkdirSync(output, { recursive: true }); const run = fs.mkdtempSync(path.join(output, 'recording-browser-'));
  const sample = path.join(run, 'sample.mp4'), calls = [], errors = [], states = new Map(), removed = new Set(); let directory = ROOT + '/recordings';
  const generated = spawnSync(process.env.FFMPEG_PATH || (process.platform === 'win32' ? 'D:/ClaudeTools/ffmpeg/ffmpeg-8.1-essentials_build/bin/ffmpeg.exe' : 'ffmpeg'),
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '8', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sample],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (generated.error || generated.status !== 0) throw Error('Local test video generation failed: ' + (generated.error?.message || generated.stderr));
  const source = fs.readFileSync(path.join(project, 'public/index.html'), 'utf8');
  const card = source.match(/<article class="card recording-card"[\s\S]*?<\/article>/)[0];
  const settings = source.match(/<section id="recordingSettings"[\s\S]*?<\/section>/)[0];
  const styles = [...source.matchAll(/<link rel="stylesheet"[^>]+>/g)].map(item => item[0]).join('\n');
  const bootstrap = `class FixtureAuth extends EventTarget { constructor(){super();this.enabled=true;this.ready=true;this.generation=1;this.user={username:'operator',role:'admin'};} async verifyManage(){this.dispatchEvent(new Event('change'));if(this.user?.role!=='admin')throw Error('admin required');} change(role){this.generation++;this.user=role?{username:role,role}:null;this.dispatchEvent(new Event('change'));} }
window.BoatAuth=new FixtureAuth();window.recording=new BoatVideoRecordingPanel();recording.update({deviceId:'boat-01',authenticated:true});recording.setVisible(true);`;
  const html = '<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1">' + styles + '</head><body><main style="max-width:1000px;margin:0 auto;padding:16px;box-sizing:border-box">' + card + '</main><dialog id="fixtureSettings" style="width:min(680px,calc(100vw - 32px));box-sizing:border-box">' + settings + '</dialog><script src="/video-recording.js"></script><script>' + bootstrap + '</script></body></html>';
  const snapshot = boat => {
    const armed = states.get(boat) === true;
    return { deviceId: boat, enabled: true, armed, receiving: boat === 'boat-01', recording: armed && boat === 'boat-01', error: null,
      segments: (boat === 'boat-01' ? ['a', 'c'] : ['b', 'd']).map((letter, index) => {
        const id = letter.repeat(64), base = '/api/video/recording/boats/' + boat + '/clips/' + id;
        return { id, start: index ? '2026-10-28T01:01:03Z' : '2026-10-28T01:02:03Z', duration: 8, playbackUrl: base, downloadUrl: base + '?download=1' };
      }).filter(clip => !removed.has(boat + ':' + clip.id)) };
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith('/api/video/recording/')) {
      calls.push({ method: req.method, path: url.pathname });
      let body = ''; for await (const chunk of req) body += chunk;
      if (url.pathname === '/api/video/recording/config') {
        if (req.method === 'PATCH') directory = JSON.parse(body).directory;
        return json(200, { enabled: true, directory, allowedRoot: ROOT, persistent: true, segmentSeconds: 60, retentionDays: 7, activeCount: [...states.values()].filter(Boolean).length });
      }
      const match = /^\/api\/video\/recording\/boats\/([A-Za-z0-9_-]+)(?:\/(start|stop))?$/.exec(url.pathname);
      if (match) { if (req.method === 'POST') states.set(match[1], match[2] === 'start'); return json(200, snapshot(match[1])); }
      const clipRoute = /^\/api\/video\/recording\/boats\/(boat-01|boat-02)\/clips\/([a-d]{64})$/.exec(url.pathname);
      if (clipRoute) {
        if (!snapshot(clipRoute[1]).segments.some(clip => clip.id === clipRoute[2])) return json(404, { error: '录像不存在或已删除' });
        if (req.method === 'DELETE') {
          removed.add(clipRoute[1] + ':' + clipRoute[2]);
          return json(200, { deviceId: clipRoute[1], deletedId: clipRoute[2], deleted: true });
        }
        const size = fs.statSync(sample).size, range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start >= size) { res.writeHead(416); return res.end(); }
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size } : {}) });
        const stream = fs.createReadStream(sample, { start, end }); res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      return json(404, { error: 'Unknown fixture API' });
    }
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
    const file = path.resolve(project, 'public', '.' + url.pathname), base = path.resolve(project, 'public') + path.sep;
    if (!file.startsWith(base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = path.join(run, 'chrome');
  const browser = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome'),
    ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', fault => errors.push(fault.message)); let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort'); for (let i = 0; i < 100 && !fs.existsSync(portFile) && !errors.length; i++) await wait(100);
    if (!fs.existsSync(portFile)) throw Error('Chrome did not start: ' + errors.join('; '));
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0], pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let serial = 0, confirmDelete = false; const pending = new Map(), dialogs = [];
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    socket.onmessage = event => { const data = JSON.parse(event.data); if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
      if (data.method === 'Page.javascriptDialogOpening') { dialogs.push(data.params); send('Page.handleJavaScriptDialog', { accept: confirmDelete }).catch(error => errors.push(error.message)); }
      const item = pending.get(data.id); if (item) { pending.delete(data.id); clearTimeout(item.timer); data.error ? item.reject(Error(data.error.message)) : item.resolve(data.result); } };
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
    const until = async expression => { for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await wait(50); } throw Error('Condition timed out: ' + expression + '\n' + await evaluate('document.body.innerText') + '\n' + errors.join('\n')); };
    await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    await until('window.recording?.snapshot?.segments.length===2');
    assert.equal(await evaluate('document.getElementById("recordingStart").disabled'), false);
    await evaluate('document.getElementById("recordingStart").click()'); await until('recording.snapshot?.armed&&!recording.channels.boat.busy');
    assert.equal(states.get('boat-01'), true);
    const before = calls.filter(call => call.method === 'POST').length;
    await evaluate('recording.setVisible(false)'); await evaluate('recording.setVisible(true)'); await until('!recording.channels.boat.busy');
    assert.equal(calls.filter(call => call.method === 'POST').length, before, 'Hide/show never stops recording');
    await evaluate('document.querySelector(".recording-row button").click()'); await until('document.getElementById("recordingPlayer").currentTime>0&&document.getElementById("recordingPlayer").videoWidth>0');
    assert.equal(await evaluate('document.querySelector(".recording-download").getAttribute("href").endsWith("?download=1")'), true);
    await evaluate('recording.update({deviceId:"boat-02",authenticated:true})'); await until('recording.snapshot?.deviceId==="boat-02"');
    assert.equal(await evaluate('document.getElementById("recordingPlayer").getAttribute("src")'), null);
    await evaluate('document.getElementById("recordingStart").click()'); await until('recording.snapshot?.armed&&!recording.channels.boat.busy');
    assert.match(await evaluate('document.getElementById("recordingStatus").textContent'), /等待船端视频/);
    await evaluate('document.getElementById("fixtureSettings").showModal();recording.open()'); await until('recording.config?.activeCount===2');
    assert.equal(await evaluate('document.getElementById("recordingSettingsSave").disabled'), true);
    await evaluate('document.getElementById("fixtureSettings").close();recording.close();recording.command("stop")'); await until('!recording.snapshot?.armed&&!recording.channels.boat.busy');
    await evaluate('recording.update({deviceId:"boat-01",authenticated:true})'); await until('recording.snapshot?.deviceId==="boat-01"');
    await evaluate('recording.command("stop")'); await until('!recording.snapshot?.armed&&!recording.channels.boat.busy');
    await evaluate('document.getElementById("fixtureSettings").showModal();recording.open()'); await until('recording.config?.activeCount===0');
    await evaluate('document.getElementById("recordingDirectory").value="/var/lib/unmanned-boat-video/voyage-2026";document.getElementById("recordingSettingsForm").requestSubmit()');
    await until('recording.config?.directory.endsWith("voyage-2026")&&!recording.channels.config.busy'); assert.equal(directory, ROOT + '/voyage-2026');
    for (const width of [1440, 375, 320]) for (const theme of ['dark', 'light']) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 900 : 1000, deviceScaleFactor: 1, mobile: width < 600 });
      await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme)); await wait(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, width + 'px ' + theme + ' recording settings fit');
      assert.equal(await evaluate('document.getElementById("fixtureSettings").scrollWidth>document.getElementById("fixtureSettings").clientWidth+1'), false);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, 'recording-settings-' + width + '-' + theme + '.png'), Buffer.from(shot.data, 'base64'));
      await evaluate('document.getElementById("fixtureSettings").close()'); await wait(40);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, width + 'px ' + theme + ' clips fit');
      const pageShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, 'recording-' + width + '-' + theme + '.png'), Buffer.from(pageShot.data, 'base64'));
      await evaluate('document.getElementById("fixtureSettings").showModal()');
    }
    await evaluate('document.getElementById("fixtureSettings").close();recording.close()');
    // 原生确认框取消不发送 DELETE；确认只删除当前船所选片段。
    await evaluate('document.querySelector(".recording-row button").click()'); await until('document.getElementById("recordingPlayer").currentTime>0');
    const deletesBefore = calls.filter(call => call.method === 'DELETE').length;
    await evaluate('document.querySelector(".recording-delete").click()');
    assert.equal(calls.filter(call => call.method === 'DELETE').length, deletesBefore);
    assert.equal(await evaluate('recording.snapshot.segments.length'), 2);
    assert.equal(dialogs.at(-1).type, 'confirm'); assert.match(dialogs.at(-1).message, /boat-01/);
    confirmDelete = true;
    // 删除另一段不打断当前回放。
    await evaluate('document.querySelectorAll(".recording-delete")[1].click()');
    await until('recording.snapshot?.segments.length===1&&!recording.channels.boat.busy');
    assert.equal(calls.filter(call => call.method === 'DELETE').at(-1).path, '/api/video/recording/boats/boat-01/clips/' + 'c'.repeat(64));
    assert.equal(await evaluate('recording.playingId'), 'a'.repeat(64));
    assert.equal(await evaluate('document.getElementById("recordingCount").textContent'), '1 段录像');
    assert.equal(snapshot('boat-02').segments.length, 2);
    // 删除正播放片段立即卸载播放器，刷新也不会恢复已删录像。
    await evaluate('document.querySelector(".recording-delete").click()');
    await until('recording.snapshot?.segments.length===0&&!recording.channels.boat.busy');
    assert.equal(await evaluate('document.getElementById("recordingPlayer").getAttribute("src")'), null);
    assert.equal(await evaluate('document.getElementById("recordingPlayerWrap").hidden'), true);
    await evaluate('recording.refresh()'); assert.equal(await evaluate('recording.snapshot.segments.length'), 0);
    await evaluate('recording.update({deviceId:"boat-02",authenticated:true})'); await until('recording.snapshot?.deviceId==="boat-02"&&recording.snapshot.segments.length===2');
    await evaluate('BoatAuth.change("guest")'); await until('recording.snapshot?.segments.length===2');
    assert.equal(await evaluate('document.getElementById("recordingStart").hidden&&document.getElementById("recordingStop").hidden&&document.getElementById("recordingSettings").hidden'), true);
    assert.equal(await evaluate('[...document.querySelectorAll(".recording-delete")].every(button=>button.hidden)'), true);
    const writes = calls.filter(call => call.method !== 'GET').length; assert.equal(await evaluate('recording.command("start")'), false); assert.equal(calls.filter(call => call.method !== 'GET').length, writes);
    await evaluate('document.querySelector(".recording-row button").click()'); await until('document.getElementById("recordingPlayer").currentTime>0');
    await evaluate('BoatAuth.change(null)'); assert.equal(await evaluate('document.getElementById("recordingList").children.length'), 0);
    assert.equal(await evaluate('document.getElementById("recordingPlayer").getAttribute("src")'), null); assert.deepEqual(errors, []);
    console.log('Chrome recording UI passed: independent boat recording, real MP4 replay/download, confirmed per-clip deletion/cancel, playback cleanup, boat isolation, directory lock/save, guest view-only, logout unloading, 1440/375/320px dark/light layouts.');
  } finally {
    socket?.close(); browser.kill(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
    // 只清理本次在 .test-output 内创建的测试目录。
    if (path.dirname(run) === output && path.basename(run).startsWith('recording-browser-')) { await wait(250); try { fs.rmSync(run, { recursive: true, force: true }); } catch (_) { /* Chrome 退出较慢时留待后续测试清理。 */ } }
  }
}
main().catch(fault => { console.error(fault); process.exitCode = 1; });
