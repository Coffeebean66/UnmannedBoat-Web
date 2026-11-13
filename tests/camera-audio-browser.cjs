/* 真实 Chrome/账户/上传与持久文件；WVP 和扬声器使用测试桩，不播放生产音频。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { createFixtureServer } = require('./mqtt-browser-fixture.cjs'), { browserSession, login } = require('./amap-browser.cjs');
const { createCameraAudioTools } = require('../server/camera-audio-tools');
async function main() {
  const output = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(output, { recursive: true }); const directory = fs.mkdtempSync(path.join(output, 'camera-audio-browser-'));
  const windowsBin = 'D:/ClaudeTools/ffmpeg/ffmpeg-8.1-essentials_build/bin/';
  const env = { BOAT_CAMERA_FFMPEG: process.env.BOAT_CAMERA_FFMPEG || (process.platform === 'win32' ? windowsBin + 'ffmpeg.exe' : 'ffmpeg'), BOAT_CAMERA_FFPROBE: process.env.BOAT_CAMERA_FFPROBE || (process.platform === 'win32' ? windowsBin + 'ffprobe.exe' : 'ffprobe') };
  const real = createCameraAudioTools({ env }), workers = []; let delayed = false;
  const tools = { available: real.available, probe: real.probe, play(_file, _url, { volume }) {
    let begin, rejectReady, finish; const worker = { volume, setVolume(value) { worker.volume = value; }, ready: new Promise((resolve, reject) => { begin = resolve; rejectReady = reject; }), done: new Promise(resolve => { finish = resolve; }), stop() { rejectReady(Object.assign(Error('播放已停止'), { status: 409 })); finish({ code: -1 }); return worker.done; }, finish() { finish({ code: 0 }); } };
    workers.push(worker); if (!delayed) begin(); return worker;
  } };
  const sourceFile = path.join(directory, 'sources.json');
  fs.writeFileSync(sourceFile, JSON.stringify({ version: 1, revision: 1, boats: { 'boat-mqtt-test': { provider: 'wvp', revision: 1, deviceId: 'cam-01', channelId: 'channel-01', original: { source: 'publisher', sourceOnDemand: false, rtspTransport: 'automatic' } } } }));
  const wvp = { voiceAvailable: async () => true, talkStart: async () => ({ push: { app: 'broadcast' } }), broadcastPublishUrl: async () => 'rtsp://127.0.0.1/broadcast/test', talkStop: async () => {}, close() {} };
  const server = createFixtureServer({ env: { ...env, BOAT_VIDEO_WVP_ENABLED: '1', BOAT_VIDEO_MEDIA_ENABLED: '1', BOAT_VIDEO_WVP_USERNAME: 'test-admin', BOAT_VIDEO_WVP_PASSWORD_MD5: 'a'.repeat(32), BOAT_VIDEO_MEDIA_AUTH_TOKEN: 'a'.repeat(64), BOAT_VIDEO_MEDIA_READER_PASSWORD: 'b'.repeat(64), BOAT_VIDEO_MEDIA_PUBLIC_HOST: '127.0.0.1' },
    accountOptions: { storeFile: path.join(directory, 'accounts.json') }, mapOptions: { file: path.join(directory, 'map.json') }, driverLayoutOptions: { file: path.join(directory, 'layout.json') }, gamepadHapticsOptions: { file: path.join(directory, 'haptics.json') }, missionOptions: { file: path.join(directory, 'missions.json') },
    cameraOptions: { wvp, audioOptions: { tools, directory: path.join(directory, 'audio') } }, videoSourceOptions: { file: sourceFile, wvp: { close() {} }, reconcileMs: 60000, client: async () => ({ devices: [{ deviceId: 'boat-mqtt-test' }] }) } });
  try {
    const mp3 = path.join(directory, '提示音.mp3'); await promisify(execFile)(env.BOAT_CAMERA_FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', '-c:a', 'libmp3lame', mp3], { windowsHide: true, timeout: 10000 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await browserSession(server, 'camera-audio', async browser => {
      const { evaluate, until, send, viewportShot } = browser;
      const open = async () => { await evaluate('boatMonitor.videoView.enabled=false;boatMonitor.selectBoat("boat-mqtt-test",false);BoatWorkspace.navigate("video")'); await until('boatMonitor.cameraControl.config?.enabled'); await evaluate('if(!boatMonitor.cameraControl.opened)document.getElementById("cameraControlToggle").click()'); await until('boatMonitor.cameraControl.audioFiles.library?.available'); };
      await login(browser, 'operator', 'browser-admin-test-only'); await until('boatMonitor.fleet.streamConnected'); await open();
      await send('DOM.enable'); const root = await send('DOM.getDocument'), input = await send('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#cameraAudioFile' });
      await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [mp3] }); await until('!document.getElementById("cameraAudioUpload").disabled');
      await evaluate('document.getElementById("cameraAudioUpload").click()'); await until('boatMonitor.cameraControl.audioFiles.library.files.length===1&&!boatMonitor.cameraControl.audioFiles.busy');
      assert.match(await evaluate('document.getElementById("cameraAudioSelect").selectedOptions[0].textContent'), /提示音.mp3/);
      assert.equal(await evaluate('document.getElementById("cameraAudioVolume").value'), '100');
      await evaluate('document.getElementById("cameraAudioVolume").value="40";document.getElementById("cameraAudioVolume").dispatchEvent(new Event("input"))');
      await evaluate('document.getElementById("cameraAudioPlay").click()'); await until('boatMonitor.cameraControl.audioFiles.state?.playback.status==="playing"&&!boatMonitor.cameraControl.audioFiles.busy');
      assert.equal(workers[0].volume, 40);
      const playbackId = await evaluate('boatMonitor.cameraControl.audioFiles.state.playback.id');
      for (const volume of [50, 0, 100]) {
        await evaluate('document.getElementById("cameraAudioVolume").value=' + JSON.stringify(String(volume)) + ';document.getElementById("cameraAudioVolume").dispatchEvent(new Event("input"));document.getElementById("cameraAudioVolume").dispatchEvent(new Event("change"))');
        await until('boatMonitor.cameraControl.audioFiles.state.playback.volume===' + volume + '&&!boatMonitor.cameraControl.audioFiles.volumeSending'); assert.equal(workers[0].volume, volume);
        assert.equal(await evaluate('boatMonitor.cameraControl.audioFiles.state.playback.id'), playbackId, '调整音量不重启播放');
      }
      await evaluate('window.audioOriginalFetch=boatMonitor.cameraControl.audioFiles.fetch;boatMonitor.cameraControl.audioFiles.fetch=async(url,options)=>{if(options?.method==="PATCH"&&JSON.parse(options.body).volume===80)await new Promise(resolve=>setTimeout(resolve,400));return audioOriginalFetch(url,options)};document.getElementById("cameraAudioVolume").value="80";document.getElementById("cameraAudioVolume").dispatchEvent(new Event("input"));document.getElementById("cameraAudioVolume").dispatchEvent(new Event("change"))');
      await until('boatMonitor.cameraControl.audioFiles.volumeSending');
      await evaluate('document.getElementById("cameraAudioVolume").value="25";document.getElementById("cameraAudioVolume").dispatchEvent(new Event("input"));document.getElementById("cameraAudioVolume").dispatchEvent(new Event("change"))');
      await until('boatMonitor.cameraControl.audioFiles.state.playback.volume===25&&!boatMonitor.cameraControl.audioFiles.volumeSending&&!boatMonitor.cameraControl.audioFiles.volumePending');
      assert.equal(workers[0].volume, 25); assert.equal(workers.length, 1);
      assert.equal(await evaluate('document.getElementById("cameraTalkStart").disabled'), true); assert.equal(await evaluate('document.getElementById("cameraAudioDelete").disabled'), true);
      await evaluate('document.getElementById("cameraControlClose").click();BoatWorkspace.navigate("overview")');
      assert.equal((await fetch('http://127.0.0.1:' + server.address().port + '/api/video/camera/boats/boat-mqtt-test/audio')).status, 401);
      await open(); await until('boatMonitor.cameraControl.audioFiles.state?.playback.status==="playing"');
      assert.equal(await evaluate('document.getElementById("cameraAudioVolume").value'), '25', '收起后恢复当前音量');
      workers[0].finish(); await until('boatMonitor.cameraControl.audioFiles.state?.playback.status==="completed"');
      assert.match(await evaluate('document.getElementById("cameraAudioStatus").textContent'), /已播报完成/);
      // 启动期间允许停止，较晚返回的 POST 错误不能覆盖用户已经完成的停止操作。
      delayed = true; await evaluate('document.getElementById("cameraAudioPlay").click()'); await until('!document.getElementById("cameraAudioStop").disabled');
      await evaluate('document.getElementById("cameraAudioStop").click()'); await until('boatMonitor.cameraControl.audioFiles.state?.playback.status==="stopped"&&!boatMonitor.cameraControl.audioFiles.busy'); delayed = false;
      assert.match(await evaluate('document.getElementById("cameraAudioStatus").textContent'), /已停止/);
      await evaluate('BoatWorkspace.navigate("driving")'); await until('document.documentElement.dataset.workspaceView==="driving"');
      await evaluate('if(!boatMonitor.cameraControl.opened)document.getElementById("cameraControlToggle").click();document.getElementById("cameraAudioSelect").scrollIntoView({block:"center"})');
      await viewportShot('camera-audio-driving');
      await evaluate('BoatWorkspace.navigate("video");if(!boatMonitor.cameraControl.opened)document.getElementById("cameraControlToggle").click()');
      for (const theme of ['light', 'dark']) {
        await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 850, deviceScaleFactor: 1, mobile: true });
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme) + ';document.getElementById("cameraAudioSelect").scrollIntoView({block:"center"})');
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
        assert.equal(await evaluate('document.getElementById("cameraControls").scrollWidth<=document.getElementById("cameraControls").clientWidth'), true);
        await viewportShot('camera-audio-mobile-' + theme);
      }
      assert.equal(await evaluate('(async()=>{const r=await fetch("/api/auth/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"pilot",role:"driver",password:"browser-pilot-test"})});return r.status})()'), 201);
      await evaluate('BoatAuth.logout()'); await until('!BoatAuth.user&&!BoatAuth.busy'); await login(browser, 'pilot', 'browser-pilot-test'); await until('boatMonitor.fleet.streamConnected'); await open();
      assert.equal(await evaluate('document.getElementById("cameraAudioUploadArea").hidden&&document.getElementById("cameraAudioDelete").hidden'), true);
      await until('!document.getElementById("cameraAudioPlay").disabled'); await evaluate('document.getElementById("cameraAudioPlay").click()'); await until('boatMonitor.cameraControl.audioFiles.state?.playback.status==="playing"');
      await evaluate('document.getElementById("cameraAudioStop").click()'); await until('boatMonitor.cameraControl.audioFiles.state?.playback.status==="stopped"');
      await evaluate('BoatAuth.logout()'); await until('!BoatAuth.user&&!BoatAuth.busy'); await login(browser, 'operator', 'browser-admin-test-only'); await open();
      await send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      await evaluate('window.confirm=()=>true;document.getElementById("cameraAudioDelete").click()'); await until('boatMonitor.cameraControl.audioFiles.library.files.length===0&&!boatMonitor.cameraControl.audioFiles.busy');
      await evaluate('BoatAuth.logout()'); await until('!BoatAuth.user&&!BoatAuth.busy'); await login(browser, 'observer', 'browser-guest-test-only');
      assert.equal(await evaluate('document.getElementById("cameraControlToggle").hidden'), true);
      assert.equal(await evaluate('(async()=>{const r=await fetch("/api/video/camera/audio-files");return r.status})()'), 403);
    });
    console.log('Camera MP3 browser passed: real file upload/probe, initial and live volume/mute, rapid slider updates keep final value without restarting playback, panel continuation, stop while preparing, mic exclusion, permissions, deletion and driving/mobile themes. WVP output is simulated.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
