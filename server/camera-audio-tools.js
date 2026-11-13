/* 音频文件只在服务器解码；输出摄像头已支持的 8kHz / 单声道 G.711A。 */
'use strict';
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const fault = (status, message) => Object.assign(Error(message), { status });
function validateVolume(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw fault(400, '播报音量必须是0到100的整数');
  return value;
}
// 在服务器对PCM采样缩放，音量变化不需要重新建立摄像头广播或重播文件。
function createVolumeTransform(volume = 100) {
  let level = validateVolume(volume), pending = null;
  const stream = new Transform({ transform(chunk, _encoding, callback) {
    const data = pending === null ? chunk : Buffer.concat([Buffer.from([pending]), chunk]);
    const length = data.length & ~1; pending = data.length === length ? null : data[length];
    if (level !== 100) for (let offset = 0; offset < length; offset += 2) data.writeInt16LE(Math.round(data.readInt16LE(offset) * level / 100), offset);
    callback(null, data.subarray(0, length));
  }, flush(callback) { callback(pending === null ? null : Error('音频采样不完整')); } });
  stream.setVolume = value => { level = validateVolume(value); };
  return stream;
}
function createCameraAudioTools({ env = process.env, run = execute, launch = spawn } = {}) {
  const ffmpeg = env.BOAT_CAMERA_FFMPEG || 'ffmpeg', ffprobe = env.BOAT_CAMERA_FFPROBE || 'ffprobe';
  let checkedAt = 0, checked = false, checking;
  async function available() {
    if (Date.now() - checkedAt < 60000) return checked;
    if (!checking) checking = Promise.all([ffmpeg, ffprobe].map(binary => run(binary, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 32768 })))
      .then(() => true, () => false).then(value => { checked = value; checkedAt = Date.now(); return value; }).finally(() => { checking = null; });
    return checking;
  }
  async function probe(file) {
    if (!await available()) throw fault(503, '服务器需安装 FFmpeg 和 FFprobe 后才能上传与播放 MP3');
    let value;
    try {
      const result = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3', '-i', file,
        '-show_entries', 'format=format_name,duration:stream=codec_name,codec_type', '-of', 'json'], { windowsHide: true, timeout: 12000, maxBuffer: 65536 });
      value = JSON.parse(result.stdout);
    } catch (_) { throw fault(400, '文件不是可解码的 MP3 音频'); }
    const duration = Number(value.format?.duration);
    if (value.format?.format_name !== 'mp3' || !value.streams?.some(track => track.codec_type === 'audio' && track.codec_name === 'mp3') || !Number.isFinite(duration) || duration <= 0 || duration > 1800) throw fault(400, '请上传时长不超过30分钟的有效 MP3');
    return { duration: Math.round(duration * 1000) / 1000 };
  }
  function play(file, url, { signal, volume = 100 } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'rtsp:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.hash) throw fault(503, '摄像头广播地址无效');
    if (signal?.aborted) throw fault(409, '音频播放已取消');
    const gain = createVolumeTransform(volume);
    const decoder = launch(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-protocol_whitelist', 'file,pipe', '-i', file,
      '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-ar', '8000', '-ac', '1', '-flush_packets', '1', '-f', 's16le', 'pipe:1'],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let encoder;
    try {
      encoder = launch(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 's16le', '-ar', '8000', '-ac', '1', '-probesize', '32', '-analyzeduration', '0', '-i', 'pipe:0',
        '-c:a', 'pcm_alaw', '-progress', 'pipe:1', '-stats_period', '0.2', '-flush_packets', '1', '-f', 'rtsp', '-rtsp_transport', 'tcp', url],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { decoder.once('error', () => {}); decoder.kill('SIGKILL'); throw error; }
    const children = [decoder, encoder], codes = new Map();
    let readyDone = false, finished = false, stopping = false, terminating = false, failed = false, piped = false, buffer = '', startupTimer, killTimer, resolveReady, rejectReady, resolveDone;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const done = new Promise(resolve => { resolveDone = resolve; });
    const begin = error => { if (readyDone) return; readyDone = true; clearTimeout(startupTimer); error ? rejectReady(error) : resolveReady(); };
    const terminate = () => {
      if (!finished && !terminating) {
        terminating = true; for (const child of children) if (!codes.has(child)) child.kill('SIGTERM');
        killTimer = setTimeout(() => { for (const child of children) if (!codes.has(child)) child.kill('SIGKILL'); }, 1500); killTimer.unref?.();
      }
    };
    const stop = () => { if (!finished) stopping = true; terminate(); return done; };
    const fail = () => { failed = true; begin(fault(503, '音频发送失败，请检查摄像头在线状态与广播功能')); terminate(); };
    const finish = () => {
      if (finished || !piped || codes.size !== children.length) return;
      finished = true; clearTimeout(killTimer); signal?.removeEventListener('abort', stop);
      const code = !failed && !stopping && [...codes.values()].every(value => value === 0) ? 0 : -1;
      begin(code === 0 ? null : fault(503, '音频发送失败，请检查摄像头在线状态与广播功能')); resolveDone({ code, stopped: stopping });
    };
    encoder.stdout.on('data', chunk => {
      buffer = (buffer + chunk.toString('utf8')).slice(-8192);
      if (/(?:^|\n)out_time_(?:us|ms)=[1-9]\d*/.test(buffer)) begin();
    });
    // FFmpeg 的错误可能包含私密 RTSP 参数，不直接输出日志或返回浏览器。
    for (const child of children) {
      child.stderr.resume(); child.once('error', fail);
      child.once('close', code => { codes.set(child, code ?? -1); if (code !== 0 && !stopping) fail(); finish(); });
    }
    void pipeline(decoder.stdout, gain, encoder.stdin).catch(() => { if (!stopping) fail(); }).finally(() => { piped = true; finish(); });
    startupTimer = setTimeout(() => { begin(fault(504, '摄像头音频发送超时，请检查设备在线状态')); failed = true; terminate(); }, 18000); startupTimer.unref?.();
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    return { ready, done, stop, setVolume: value => { if (finished || terminating) throw fault(409, '音频播放已结束'); gain.setVolume(value); } };
  }
  return { available, probe, play };
}
module.exports = { createCameraAudioTools, createVolumeTransform, validateVolume };
