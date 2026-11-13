/* 真实 FFmpeg → 本机 RTSP：验证 MP3 检测、G.711A/8kHz/单声道、自然结束与停止。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { createCameraAudioTools } = require('../server/camera-audio-tools');
const run = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const number = server.address().port; await new Promise(resolve => server.close(resolve)); return number; }
async function main() {
  const output = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(output, { recursive: true }); const directory = fs.mkdtempSync(path.join(output, 'camera-audio-native-'));
  const windowsBin = 'D:/ClaudeTools/ffmpeg/ffmpeg-8.1-essentials_build/bin/';
  const env = { ...process.env, BOAT_CAMERA_FFMPEG: process.env.BOAT_CAMERA_FFMPEG || (process.platform === 'win32' ? windowsBin + 'ffmpeg.exe' : 'ffmpeg'), BOAT_CAMERA_FFPROBE: process.env.BOAT_CAMERA_FFPROBE || (process.platform === 'win32' ? windowsBin + 'ffprobe.exe' : 'ffprobe') };
  const tools = createCameraAudioTools({ env }), rtspPort = await port(), log = [], workers = [];
  const config = path.join(directory, 'mediamtx.yml'), file = path.join(directory, 'silence.mp3');
  fs.writeFileSync(config, JSON.stringify({ logLevel: 'info', api: false, rtsp: true, rtspAddress: '127.0.0.1:' + rtspPort, rtspTransports: ['tcp'], rtmp: false, hls: false, srt: false, moq: false, webrtc: false, paths: { broadcast: { source: 'publisher' } } }));
  const media = spawn(process.env.MEDIAMTX_PATH || (process.platform === 'win32' ? path.join(output, 'mediamtx-v1.21.3/mediamtx.exe') : 'mediamtx'), [config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  media.stdout.on('data', chunk => log.push(chunk.toString())); media.stderr.on('data', chunk => log.push(chunk.toString()));
  try {
    assert.equal(await tools.available(), true);
    await run(env.BOAT_CAMERA_FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '7', '-c:a', 'libmp3lame', '-b:a', '64k', file], { windowsHide: true, timeout: 10000 });
    assert.ok((await tools.probe(file)).duration >= 7);
    const invalid = path.join(directory, 'invalid.mp3'); fs.writeFileSync(invalid, 'not mp3'); await assert.rejects(tools.probe(invalid), error => error.status === 400);
    const url = 'rtsp://127.0.0.1:' + rtspPort + '/broadcast';
    for (let i = 0; i < 100 && !log.join('').includes('[RTSP] listener opened') && media.exitCode === null; i++) await wait(30);
    if (media.exitCode !== null) throw Error(log.join(''));
    const worker = tools.play(file, url); workers.push(worker); await worker.ready;
    const result = await run(env.BOAT_CAMERA_FFPROBE, ['-v', 'error', '-rtsp_transport', 'tcp', '-analyzeduration', '200000', '-probesize', '32000', '-i', url, '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json'], { windowsHide: true, timeout: 10000 });
    const track = JSON.parse(result.stdout).streams[0]; assert.equal(track.codec_name, 'pcm_alaw'); assert.equal(track.sample_rate, '8000'); assert.equal(track.channels, 1);
    assert.equal((await worker.done).code, 0);
    const stopped = tools.play(file, url); workers.push(stopped); await stopped.ready; assert.equal((await stopped.stop()).stopped, true);
    for (const address of ['https://127.0.0.1/audio', 'rtsp://external.example/live', 'rtsp://user:pass@127.0.0.1/live']) assert.throws(() => tools.play(file, address));
    // 仅向本机RTSP发送测试正弦波，解码后测量幅值，验证滑块实际改变了发出的音频。
    const tone = path.join(directory, 'tone.mp3');
    await run(env.BOAT_CAMERA_FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '12', '-c:a', 'libmp3lame', tone], { windowsHide: true, timeout: 10000 });
    const live = tools.play(tone, url, { volume: 100 }); workers.push(live); await live.ready;
    const receiver = spawn(env.BOAT_CAMERA_FFMPEG, ['-v', 'error', '-nostdin', '-rtsp_transport', 'tcp', '-analyzeduration', '0', '-probesize', '32', '-i', url, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let captured = Buffer.alloc(0); receiver.stdout.on('data', chunk => { captured = Buffer.concat([captured, chunk]); });
    async function moreAudio() {
      const target = captured.length + 16000;
      for (let i = 0; i < 250 && captured.length < target; i++) await wait(20);
      assert.ok(captured.length >= target, '本机应持续收到音频');
      const data = captured.subarray(captured.length - 4000); let power = 0;
      for (let offset = 0; offset < data.length - 1; offset += 2) power += data.readInt16LE(offset) ** 2;
      return Math.sqrt(power / (data.length / 2));
    }
    try {
      const full = await moreAudio(); assert.ok(full > 1000);
      live.setVolume(50); const half = await moreAudio(); assert.ok(half / full > 0.45 && half / full < 0.55, '50%输出幅值应减半');
      live.setVolume(0); assert.ok(await moreAudio() <= 10, '0%应为G.711A静音');
      live.setVolume(100); const restored = await moreAudio(); assert.ok(restored / full > 0.95 && restored / full < 1.05, '100%恢复原始幅值');
    } finally { receiver.kill(); await live.stop(); }
    const unavailable = tools.play(file, 'rtsp://127.0.0.1:' + await port() + '/missing'); workers.push(unavailable);
    await assert.rejects(unavailable.ready); assert.notEqual((await unavailable.done).code, 0);
    console.log('Camera MP3 native passed: real MP3/PCMA 8000Hz mono, natural completion/stop, live 100%→50%→mute→100% measured from decoded RTSP samples without restarting the stream, and failed-output cleanup. Audio stayed on localhost.');
  } finally {
    await Promise.allSettled(workers.map(worker => worker.stop())); media.kill(); await Promise.race([new Promise(resolve => media.once('exit', resolve)), wait(2000)]);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
