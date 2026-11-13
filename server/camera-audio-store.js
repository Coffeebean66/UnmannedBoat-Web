/* 私有 MP3 音频库：流式限量上传、真实格式校验、原子索引；浏览器文件名只作显示。 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Transform } = require('node:stream'), { pipeline } = require('node:stream/promises');
const { resolveDriverLayoutFile } = require('./driver-layout-api');
const ID = /^[a-f0-9]{32}$/, MAX_BYTES = 20 * 1024 * 1024, MAX_TOTAL = 200 * 1024 * 1024, MAX_FILES = 50;
const fault = (status, message) => Object.assign(Error(message), { status });
function resolveAudioDirectory(env = process.env, directory) {
  const value = directory || env.BOAT_CAMERA_AUDIO_DIR || path.join(path.dirname(resolveDriverLayoutFile({ ...env, BOAT_DRIVER_LAYOUT_FILE: '' })), 'camera-audio');
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fault(503, '音频目录需要服务器上的可写绝对路径');
  return path.normalize(value);
}
function createCameraAudioStore({ env = process.env, directory, tools, uploadTimeoutMs = 60000, now = Date.now } = {}) {
  let root = '', entries = [], loaded = false, closed = false, operation = null, deleting = '', uploadController;
  const users = new Map();
  const assertOpen = () => { if (closed) throw fault(503, '音频库已关闭'); };
  function load() {
    assertOpen(); if (loaded) return;
    root = resolveAudioDirectory(env, directory);
    try {
      const stat = fs.lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error();
      const index = path.join(root, 'index.json');
      if (fs.existsSync(index)) {
        const info = fs.lstatSync(index); if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error();
        const data = JSON.parse(fs.readFileSync(index, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.files) || data.files.length > MAX_FILES) throw Error();
        const ids = new Set(); let size = 0;
        for (const row of data.files) {
          if (!row || !ID.test(row.id || '') || ids.has(row.id) || typeof row.name !== 'string' || !row.name.endsWith('.mp3') || row.name.length > 160 || /[\x00-\x1f\x7f/\\]/.test(row.name) || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > MAX_BYTES || !Number.isFinite(row.duration) || row.duration <= 0 || row.duration > 1800 || !Number.isFinite(row.uploadedAt)) throw Error();
          ids.add(row.id); size += row.size;
        }
        if (size > MAX_TOTAL) throw Error(); entries = data.files;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw fault(503, '音频库无法读取，请检查服务器音频目录与索引'); }
    loaded = true;
  }
  function list() { load(); return entries.map(({ id, name, size, duration, uploadedAt }) => ({ id, name, size, duration, uploadedAt })); }
  async function save(next, allowed) {
    const temporary = path.join(root, '.' + crypto.randomBytes(16).toString('hex') + '.index');
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ version: 1, files: next }) + '\n'); await handle.sync(); await handle.close(); handle = null;
      if (closed || !allowed()) throw fault(401, '登录会话已失效或请求已取消');
      fs.renameSync(temporary, path.join(root, 'index.json')); entries = next;
    } finally { await handle?.close().catch(() => {}); await fs.promises.unlink(temporary).catch(() => {}); }
  }
  async function mutate(work) {
    load(); if (operation) throw fault(409, '另一项音频文件操作正在进行，请稍后重试');
    const task = Promise.resolve().then(work); operation = task;
    try { return await task; } finally { if (operation === task) operation = null; }
  }
  async function upload(req, name, allowed) {
    if (typeof name !== 'string' || !/\.mp3$/i.test(name) || name.length > 160 || /[\x00-\x1f\x7f/\\]/.test(name)) throw fault(400, '请选择文件名不超过160字的 MP3');
    name = name.trim().replace(/\.mp3$/i, '.mp3');
    if (!['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(String(req.headers['content-type'] || '').split(';')[0].toLowerCase())) throw fault(415, '请上传 MP3 音频文件');
    if (Number(req.headers['content-length']) > MAX_BYTES) throw fault(413, '单个 MP3 不能超过20MB');
    return mutate(async () => {
      if (entries.length >= MAX_FILES) throw fault(409, '音频库最多保存50个文件，请先删除不需要的音频');
      const room = MAX_TOTAL - entries.reduce((sum, file) => sum + file.size, 0), id = crypto.randomBytes(16).toString('hex');
      const temporary = path.join(root, '.' + id + '.upload'), target = path.join(root, id + '.mp3');
      let size = 0, committed = false, moved = false;
      uploadController = new AbortController();
      const timer = setTimeout(() => uploadController?.abort(fault(408, 'MP3 上传超时')), uploadTimeoutMs); timer.unref?.();
      const controller = uploadController;
      const limiter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > MAX_BYTES ? fault(413, '单个 MP3 不能超过20MB') : size > room ? fault(413, '音频库总容量不能超过200MB') : null, chunk); } });
      const aborted = () => limiter.destroy(fault(400, 'MP3 上传已取消'));
      req.once('aborted', aborted); req.once('error', aborted);
      try {
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
        req.pipe(limiter);
        await pipeline(limiter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
        if (!size) throw fault(400, 'MP3 文件为空');
        const info = await tools.probe(temporary);
        if (controller.signal.aborted || !allowed() || closed) throw fault(401, '登录会话已失效或请求已取消');
        await fs.promises.rename(temporary, target); moved = true;
        const row = { id, name, size, duration: info.duration, uploadedAt: now() };
        await save([...entries, row], allowed); committed = true; return row;
      } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
      finally {
        clearTimeout(timer); uploadController = null; req.unpipe(limiter); req.removeListener('aborted', aborted); req.removeListener('error', aborted);
        await fs.promises.unlink(temporary).catch(() => {}); if (moved && !committed) await fs.promises.unlink(target).catch(() => {});
      }
    });
  }
  function acquire(id) {
    load(); const entry = ID.test(id || '') ? entries.find(file => file.id === id) : null;
    if (!entry) throw fault(404, '音频文件不存在，请刷新列表');
    if (deleting === id) throw fault(409, '此音频正在删除');
    const file = path.join(root, id + '.mp3');
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) throw Error(); }
    catch (_) { throw fault(404, '音频文件已缺失，请重新上传'); }
    users.set(id, (users.get(id) || 0) + 1); let released = false;
    return { ...entry, file, release() { if (released) return; released = true; const count = (users.get(id) || 1) - 1; count ? users.set(id, count) : users.delete(id); } };
  }
  async function remove(id, allowed) {
    return mutate(async () => {
      const entry = ID.test(id || '') ? entries.find(file => file.id === id) : null;
      if (!entry) throw fault(404, '音频文件不存在');
      if (users.has(id)) throw fault(409, '音频正在摄像头播放，请先停止再删除');
      deleting = id; const file = path.join(root, id + '.mp3'), trash = path.join(root, '.' + id + '.delete'); let moved = false, saved = false;
      try {
        try { const stat = await fs.promises.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw fault(409, '音频文件状态异常'); await fs.promises.rename(file, trash); moved = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await save(entries.filter(row => row.id !== id), allowed); saved = true;
      } finally { if (moved) { if (saved) await fs.promises.unlink(trash).catch(() => {}); else await fs.promises.rename(trash, file).catch(() => {}); } deleting = ''; }
    });
  }
  return { list, upload, acquire, remove, limits: { maxBytes: MAX_BYTES, maxTotalBytes: MAX_TOTAL, maxFiles: MAX_FILES, maxDuration: 1800 },
    async close() { closed = true; uploadController?.abort(fault(503, '音频服务已停止')); await operation?.catch(() => {}); } };
}
module.exports = { createCameraAudioStore, resolveAudioDirectory, MAX_BYTES };
