/* 本机真实 G.711A 双向 WebRTC 与模拟国标信令；不操作生产摄像头或真实麦克风。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), dgram = require('node:dgram'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createFixtureServer } = require('./mqtt-browser-fixture.cjs');
const { browserSession, login } = require('./amap-browser.cjs');
const { createMediaTransport } = require('../server/video-media-api');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const gamepadOnly = process.argv.includes('--gamepad-only');
async function gamepadChecks({ evaluate, until }, calls) {
  const pad = (index, value) => evaluate('cameraPad.buttons[' + index + ']={pressed:' + value + ',value:' + Number(value) + '};void 0');
  const stopped = async start => {
    await until('!boatMonitor.cameraControl.ptz');
    for (let i = 0; i < 100 && !calls.slice(start).some(call => call[0] === 'ptz' && call[3] === 'stop'); i++) await wait(30);
    assert.ok(calls.slice(start).some(call => call[0] === 'ptz' && call[3] === 'stop'), '通过服务器发送云台停止');
  };
  await evaluate('BoatWorkspace.navigate("driving");document.getElementById("cameraControlClose").click();window.cameraPad={index:0,id:"WVP Xbox test",mapping:"standard",connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};window.cameraPads=[cameraPad];Object.defineProperty(navigator,"getGamepads",{configurable:true,value:()=>cameraPads});document.getElementById("driverInputSource").value="gamepad";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));document.getElementById("cameraPtzSpeed").value="146";document.activeElement?.blur();void 0');
  await until('boatMonitor.driver.gamepad.sample&&!boatMonitor.cameraControl.gamepadNeedsNeutral');
  assert.equal(await evaluate('document.getElementById("cameraControls").hidden'), true, '收起云台面板仍可使用手柄');
  await evaluate('window.cameraMapPans=[];const d=boatMonitor.driver,original=d.panMainMap;d.panMainMap=function(...offset){cameraMapPans.push(offset);return original.apply(this,offset)};void 0');
  for (const [buttons, command] of [[[12], 'up'], [[13], 'down'], [[14], 'left'], [[15], 'right'], [[12, 14], 'upleft'], [[12, 15], 'upright'], [[13, 14], 'downleft'], [[13, 15], 'downright']]) {
    const start = calls.length;
    await evaluate('for(const i of ' + JSON.stringify(buttons) + ')cameraPad.buttons[i]={pressed:true,value:1};void 0');
    await until('boatMonitor.cameraControl.ptz?.source==="gamepad"&&boatMonitor.cameraControl.ptz.command===' + JSON.stringify(command) + '&&boatMonitor.cameraControl.ptz.sequence>=1');
    for (let i = 0; i < 100 && !calls.slice(start).some(call => call[0] === 'ptz' && call[3] === command); i++) await wait(30);
    assert.ok(calls.slice(start).some(call => call[0] === 'ptz' && call[3] === command && call[4] === 146), command + ' 到达国标接口并沿用速度设置');
    if (command === 'right') {
      const lease = await evaluate('boatMonitor.cameraControl.ptz.leaseId');
      await until('boatMonitor.cameraControl.ptz?.sequence>=2'); assert.equal(await evaluate('boatMonitor.cameraControl.ptz.leaseId'), lease, '长按续租');
    }
    await evaluate('for(const i of ' + JSON.stringify(buttons) + ')cameraPad.buttons[i]={pressed:false,value:0};void 0'); await stopped(start);
  }
  assert.equal(await evaluate('cameraMapPans.length'), 0, '云台控制不调用地图平移');
  assert.equal(await evaluate('boatMonitor.driver.active'), false, '云台控制不接管船体');
  await pad(15, true); await until('boatMonitor.cameraControl.ptz?.command==="right"');
  let start = calls.length; await pad(3, true); await until('document.getElementById("view-driving").dataset.primary==="map"'); await stopped(start);
  await pad(3, false); await until('!boatMonitor.driver.gamepad.sample.swap');
  await pad(3, true); await until('document.getElementById("view-driving").dataset.primary==="video"'); await wait(250);
  assert.equal(await evaluate('boatMonitor.cameraControl.ptz'), null, '切回图传时按住的十字键不自动启动');
  await pad(3, false); await pad(15, false); await until('!boatMonitor.cameraControl.gamepadNeedsNeutral');
  await pad(12, true); await until('boatMonitor.cameraControl.ptz?.command==="up"'); start = calls.length;
  await evaluate('document.getElementById("driverLimit").focus()'); await stopped(start);
  await pad(12, false); await evaluate('document.activeElement?.blur()'); await until('!boatMonitor.cameraControl.gamepadNeedsNeutral');
  await pad(14, true); await until('boatMonitor.cameraControl.ptz?.command==="left"'); start = calls.length;
  await evaluate('window.dispatchEvent(new Event("blur"))'); await stopped(start); await wait(250);
  assert.equal(await evaluate('boatMonitor.cameraControl.ptz'), null, '失焦后不自动恢复长按');
  await pad(14, false); await until('!boatMonitor.cameraControl.gamepadNeedsNeutral');
  await pad(13, true); await until('boatMonitor.cameraControl.ptz?.command==="down"'); start = calls.length;
  await evaluate('cameraPads=[];const e=new Event("gamepaddisconnected");Object.defineProperty(e,"gamepad",{value:cameraPad});window.dispatchEvent(e);void 0'); await stopped(start);
  await evaluate('cameraPads=[cameraPad];cameraPad.buttons[13]={pressed:false,value:0};void 0'); await until('!boatMonitor.cameraControl.gamepadNeedsNeutral');
  await pad(15, true); await until('boatMonitor.cameraControl.ptz?.command==="right"'); start = calls.length;
  await evaluate('BoatWorkspace.navigate("overview")'); await stopped(start);
  await pad(15, false); await evaluate('document.getElementById("driverInputSource").value="keyboard";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));BoatWorkspace.navigate("video");document.getElementById("cameraControlToggle").click();document.getElementById("cameraControls").scrollIntoView({block:"center"});void 0');
  await until('!document.getElementById("cameraControls").hidden');
  console.log('Camera gamepad passed: eight PTZ directions, speed, held renewal/release, collapsed panel, map/video swap, no vessel takeover, editing/blur/disconnect/leave cleanup. WVP is simulated.');
}
async function freePort(udp = false) { const server = udp ? dgram.createSocket('udp4') : net.createServer(); await new Promise(resolve => udp ? server.bind(0, '127.0.0.1', resolve) : server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function main() {
  const output = path.resolve(__dirname, '../.test-output'), directory = fs.mkdtempSync(path.join(output, 'camera-browser-'));
  const [httpPort, udpPort] = await Promise.all([freePort(), freePort(true)]), calls = [], resources = new Set(), logs = [];
  const sourceFile = path.join(directory, 'sources.json');
  fs.writeFileSync(sourceFile, JSON.stringify({ version: 1, revision: 1, boats: { 'boat-mqtt-test': { provider: 'wvp', revision: 1, deviceId: 'cam-01', channelId: 'channel-01', original: { source: 'publisher', sourceOnDemand: false, rtspTransport: 'automatic' } } } }));
  const native = createMediaTransport({ port: httpPort }), wvp = {
    async voiceAvailable() { return true; }, async ptz(...args) { calls.push(['ptz', ...args]); },
    async talkStart(_device, _channel, mode) { calls.push(['start', mode]); return { push: { app: 'voice' }, play: mode === 'talk' ? { app: 'voice' } : null }; },
    async openAudio(_target, direction, sdp) {
      assert.match(sdp, /PCMA\/8000/); assert.doesNotMatch(sdp, /m=video/);
      const response = await native({ method: 'POST', path: '/voice/' + (direction === 'push' ? 'whip' : 'whep'), body: Buffer.from(sdp), headers: { 'Content-Type': 'application/sdp' } });
      if (response.status !== 201) throw Object.assign(Error('fixture WebRTC handshake failed: ' + response.body.toString()), { status: 503 });
      const resource = new URL(response.headers.location, 'http://127.0.0.1:' + httpPort).pathname; resources.add(resource); calls.push(['open', direction]);
      return { resource, sdp: response.body.toString() };
    }, async closeAudio(resource) { await native({ method: 'DELETE', path: resource }); resources.delete(resource); calls.push(['close']); }, async talkStop() { calls.push(['stop']); }, close() {}
  };
  const server = createFixtureServer({ env: { BOAT_VIDEO_WVP_ENABLED: '1', BOAT_VIDEO_MEDIA_ENABLED: '1', BOAT_VIDEO_WVP_USERNAME: 'test-admin', BOAT_VIDEO_WVP_PASSWORD_MD5: 'a'.repeat(32), BOAT_VIDEO_MEDIA_AUTH_TOKEN: 'a'.repeat(64), BOAT_VIDEO_MEDIA_READER_PASSWORD: 'b'.repeat(64), BOAT_VIDEO_MEDIA_PUBLIC_HOST: '127.0.0.1' },
    accountOptions: { storeFile: path.join(directory, 'accounts.json') }, mapOptions: { file: path.join(directory, 'map.json') }, driverLayoutOptions: { file: path.join(directory, 'layout.json') }, gamepadHapticsOptions: { file: path.join(directory, 'haptics.json') }, missionOptions: { file: path.join(directory, 'missions.json') },
    cameraOptions: { wvp }, videoSourceOptions: { file: sourceFile, wvp: { close() {} }, reconcileMs: 60000, client: async () => ({ devices: [{ deviceId: 'boat-mqtt-test' }] }) } });
  const config = { logLevel: 'info', authMethod: 'internal', authInternalUsers: [{ user: 'any', pass: '', ips: ['127.0.0.1'], permissions: [{ action: 'publish', path: '' }, { action: 'read', path: '' }] }], api: false, rtsp: false, rtmp: false, hls: false, srt: false, moq: false,
    webrtc: true, webrtcAddress: '127.0.0.1:' + httpPort, webrtcLocalUDPAddress: ':' + udpPort, webrtcIPsFromInterfaces: true, webrtcAdditionalHosts: ['127.0.0.1'], paths: { voice: { source: 'publisher' } } };
  const configFile = path.join(directory, 'mediamtx.yml'); fs.writeFileSync(configFile, JSON.stringify(config));
  const media = gamepadOnly ? null : spawn(process.env.MEDIAMTX_PATH || (process.platform === 'win32' ? path.join(output, 'mediamtx-v1.21.3/mediamtx.exe') : 'mediamtx'), [configFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  media?.stdout.on('data', value => logs.push(value.toString())); media?.stderr.on('data', value => logs.push(value.toString()));
  try {
    for (let i = 0; media && i < 100 && !logs.join('').includes('(HTTP)') && media.exitCode === null; i++) await wait(50);
    if (media && media.exitCode !== null) throw Error(logs.join(''));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await browserSession(server, 'camera', async browser => {
      const { evaluate, until, send, viewportShot } = browser;
      await login(browser, 'operator', 'browser-admin-test-only');
      await until('boatMonitor.fleet.streamConnected');
      await evaluate('boatMonitor.videoView.enabled=false;boatMonitor.selectBoat("boat-mqtt-test",false);BoatWorkspace.navigate("video");');
      await until('boatMonitor.cameraControl.config?.enabled&&boatMonitor.cameraControl.config?.voice');
      await evaluate('document.getElementById("cameraControlToggle").click();document.getElementById("cameraControls").scrollIntoView({block:"center"})');
      await until('!document.getElementById("cameraControls").hidden');
      const button = await evaluate('(()=>{const r=document.querySelector("[data-camera-command=left]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...button });
      for (let i = 0; i < 40 && !calls.some(call => call[0] === 'ptz' && call[3] === 'left'); i++) await wait(50);
      assert.ok(calls.some(call => call[0] === 'ptz' && call[3] === 'left')); await wait(450);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 1, y: 1 });
      await until('!boatMonitor.cameraControl.ptz'); for (let i = 0; i < 40 && !calls.some(call => call[0] === 'ptz' && call[3] === 'stop'); i++) await wait(30);
      assert.ok(calls.some(call => call[0] === 'ptz' && call[3] === 'stop'), '松开到按钮外仍停止云台');
      await gamepadChecks(browser, calls);
      if (gamepadOnly) return;
      await evaluate('window.cameraRtcDebug=[];window.cameraDebugTimer=setInterval(async()=>{const job=boatMonitor.cameraControl.talk,pc=job?.peers.get("push");if(pc){const stats=await pc.getStats();cameraRtcDebug.push({state:pc.connectionState,ice:pc.iceConnectionState,local:pc.localDescription?.sdp,remote:pc.remoteDescription?.sdp,stats:[...stats.values()].filter(s=>["candidate-pair","local-candidate","remote-candidate","transport"].includes(s.type))});if(cameraRtcDebug.length>3)cameraRtcDebug.shift();}},800);document.getElementById("cameraTalkStart").click()');
      try { await until('boatMonitor.cameraControl.talk?.ready', 30000); } catch (error) { fs.writeFileSync(path.join(output, 'camera-rtc-debug.json'), JSON.stringify(await evaluate('cameraRtcDebug'), null, 2)); throw Error(error.message + '\n' + await evaluate('document.getElementById("cameraControlStatus").textContent') + '\n' + logs.join('')); }
      await until('(async()=>{const reports=await boatMonitor.cameraControl.talk.peers.get("play").getStats();return [...reports.values()].some(r=>r.type==="inbound-rtp"&&r.kind==="audio"&&r.bytesReceived>0)})()', 10000);
      assert.equal(await evaluate('boatMonitor.cameraControl.talk.stream.getAudioTracks()[0].readyState'), 'live');
      await evaluate('window.cameraMicTrack=boatMonitor.cameraControl.talk.stream.getAudioTracks()[0];document.getElementById("cameraMicMute").click()'); assert.equal(await evaluate('cameraMicTrack.enabled'), false);
      await evaluate('document.getElementById("cameraMicMute").click()'); assert.equal(await evaluate('cameraMicTrack.enabled'), true);
      await viewportShot('camera-control-video-dark');
      await evaluate('BoatWorkspace.navigate("driving")'); await until('document.documentElement.dataset.workspaceView==="driving"');
      assert.equal(await evaluate('(()=>{const p=document.getElementById("cameraControls"),b=document.getElementById("cameraTalkStop").getBoundingClientRect();return p.parentNode.id==="driverStage"&&p.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))})()'), true, '驾驶页通话按钮不受图传容器裁剪或仪表遮挡');
      assert.equal(await evaluate('document.getElementById("cameraControlToggle").parentNode.id'), 'driverFocusTools');
      await viewportShot('camera-control-driving-dark');
      await evaluate('document.documentElement.dataset.theme="light"'); await viewportShot('camera-control-driving-light');
      await evaluate('BoatWorkspace.navigate("overview")'); await until('!boatMonitor.cameraControl.talk'); assert.equal(await evaluate('cameraMicTrack.readyState'), 'ended');
      for (let i = 0; i < 40 && resources.size; i++) await wait(50); assert.equal(resources.size, 0);
      await evaluate('BoatWorkspace.navigate("video");document.getElementById("cameraControlToggle").click();document.getElementById("cameraTalkMode").value="broadcast";document.getElementById("cameraTalkMode").dispatchEvent(new Event("change"));document.getElementById("cameraTalkStart").click()');
      await until('boatMonitor.cameraControl.talk?.ready', 30000); assert.equal(await evaluate('boatMonitor.cameraControl.talk.peers.size'), 1);
      await evaluate('window.cameraBroadcastTrack=boatMonitor.cameraControl.talk.stream.getAudioTracks()[0];window.dispatchEvent(new Event("blur"))'); await until('!boatMonitor.cameraControl.talk'); assert.equal(await evaluate('cameraBroadcastTrack.readyState'), 'ended');
      assert.match(await evaluate('document.getElementById("cameraControlStatus").textContent'), /麦克风已关闭/);
      await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 850, deviceScaleFactor: 1, mobile: true });
      await evaluate('document.getElementById("cameraControls").scrollIntoView({block:"center"})'); await viewportShot('camera-control-mobile');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, '手机无横向溢出');
      await evaluate('BoatAuth.logout()'); await until('!BoatAuth.user'); await login(browser, 'observer', 'browser-guest-test-only');
      assert.equal(await evaluate('document.getElementById("cameraControlToggle").hidden'), true);
      assert.equal(await evaluate('(async()=>{const response=await fetch("/api/video/camera/boats/boat-mqtt-test");return response.status})()'), 403);
    }, { chromeArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    if (gamepadOnly) return;
    assert.ok(calls.some(call => call[0] === 'open' && call[1] === 'push')); assert.ok(calls.some(call => call[0] === 'open' && call[1] === 'play'));
    console.log('Camera browser passed: held PTZ and release outside; real PCMA publish/receive; mute; leave-page/blur cleanup; broadcast; visitor denied; desktop/mobile and driver themes. WVP signaling is simulated.');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); media?.kill();
    if (media) await Promise.race([new Promise(resolve => media.once('exit', resolve)), wait(2000)]);
    fs.writeFileSync(path.join(output, 'camera-control-browser-log.txt'), logs.join(''));
    if (path.dirname(directory) === output && path.basename(directory).startsWith('camera-browser-')) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
