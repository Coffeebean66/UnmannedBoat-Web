/* OTA v1 字段与固件身份校验；不接受浏览器提供签名、加载地址或磁盘路径。 */
'use strict';
const crypto = require('node:crypto');
const BOARD_ID = 0x07530001, APPLICATION_ADDRESS = 0x08020000, MAX_SIZE = 640 * 1024, CHUNK_SIZE = 256;
const OP = Object.freeze({ BEGIN: 1, DATA: 2, COMMIT: 3, ABORT: 4, BEGIN_FORCE: 5 });
const HEX8 = /^[a-f0-9]{16}$/, HEX16 = /^[a-f0-9]{32}$/;
const errors = ['成功', '单片机正在处理其他升级操作', '请先将遥控倍率归零并确认两路电机停稳至少1秒', '固件数据格式或偏移不正确',
  '固件身份校验失败，请检查服务器和单片机的OTA密钥是否一致', '单片机Flash写入失败', '固件摘要校验失败', '单片机不支持此升级操作', '单片机会话已变化，请重新开始', '单片机升级等待超时'];
const fault = message => Object.assign(Error(message), { status: 400 });
function keyFrom(value) { return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value) ? Buffer.from(value, 'hex') : null; }
function validateImage(image) {
  if (!Buffer.isBuffer(image) || image.length < 256 || image.length > MAX_SIZE) throw fault('固件必须是256字节至640 KiB的OTA应用.bin文件');
  const sp = image.readUInt32LE(0), reset = image.readUInt32LE(4), address = reset & 0xfffffffe;
  // 本项目 MSP 位于 DTCM；允许 H753 的 D1/D2/D3 SRAM，仍要求8字节对齐。
  const ram = [[0x20000000, 0x20020000], [0x24000000, 0x24080000], [0x30000000, 0x30048000], [0x38000000, 0x38010000]];
  if (sp % 8 || !ram.some(([low, high]) => sp > low && sp <= high) || !(reset & 1) || address < APPLICATION_ADDRESS || address >= APPLICATION_ADDRESS + image.length)
    throw fault('固件向量不匹配OTA应用地址0x08020000；请上传OTA构建的.bin，不能使用原来的直烧固件');
  return { size: image.length, sha256: crypto.createHash('sha256').update(image).digest('hex') };
}
function manifest(image, key) {
  const info = validateImage(image);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('OTA key unavailable');
  const result = Buffer.alloc(88); result.write('BOATOTA1', 0, 'ascii'); result.writeUInt32LE(BOARD_ID, 8);
  result.writeUInt32LE(APPLICATION_ADDRESS, 12); result.writeUInt32LE(image.length, 16); Buffer.from(info.sha256, 'hex').copy(result, 24);
  crypto.createHmac('sha256', key).update(result.subarray(0, 56)).digest().copy(result, 56);
  return result;
}
function command(op, session, transferId, offset = 0, payload = Buffer.alloc(0)) {
  if (!Object.values(OP).includes(op) || typeof session !== 'string' || !HEX8.test(session) || typeof transferId !== 'string' || !HEX16.test(transferId) || !Number.isInteger(offset) || offset < 0 || offset > MAX_SIZE ||
      !Buffer.isBuffer(payload) || payload.length > CHUNK_SIZE || op !== OP.DATA && offset !== 0 ||
      op === OP.BEGIN && payload.length !== 88 || op === OP.BEGIN_FORCE && payload.length !== 120 ||
      op === OP.DATA && (!payload.length || offset + payload.length > MAX_SIZE) || [OP.COMMIT, OP.ABORT].includes(op) && payload.length) throw Error('Invalid OTA command');
  const result = Buffer.alloc(40 + payload.length); result.write('BOT1'); result[4] = op; Buffer.from(session, 'hex').copy(result, 8);
  Buffer.from(transferId, 'hex').copy(result, 16); result.writeUInt32LE(offset, 32); result.writeUInt32LE(payload.length, 36); payload.copy(result, 40); return result;
}
function forceBegin(session, transferId, signedManifest, key) {
  if (!Buffer.isBuffer(signedManifest) || signedManifest.length !== 88 || !Buffer.isBuffer(key) || key.length !== 32) throw Error('Invalid forced OTA authorization');
  // 额外签名绑定操作、当前会话、传输编号和完整 manifest；不改变 Bootloader 的 88 字节格式。
  const payload = Buffer.alloc(120); signedManifest.copy(payload);
  const packet = command(OP.BEGIN_FORCE, session, transferId, 0, payload);
  crypto.createHmac('sha256', key).update(packet.subarray(0, 128)).digest().copy(packet, 128);
  return packet;
}
function response(payload) {
  if (!Buffer.isBuffer(payload) || payload.length !== 48 || payload.toString('ascii', 0, 4) !== 'BOR1' ||
      !Object.values(OP).includes(payload[4]) || payload[5] > 9 || payload.readUInt16LE(6) || payload.readUInt32LE(44)) return null;
  return { op: payload[4], status: payload[5], session: payload.subarray(8, 16).toString('hex'), transferId: payload.subarray(16, 32).toString('hex'),
    nextOffset: payload.readUInt32LE(32), size: payload.readUInt32LE(36), detail: payload.readUInt32LE(40) };
}
function capability(payload) {
  if (!Buffer.isBuffer(payload) || payload.length > 1024) return null;
  let value; try { value = JSON.parse(payload.toString('utf8')); } catch (_) { return null; }
  if (!value || value.v !== 1 || value.boardId !== BOARD_ID || value.applicationAddress !== APPLICATION_ADDRESS || value.maxSize !== MAX_SIZE || value.chunkSize !== CHUNK_SIZE ||
      typeof value.session !== 'string' || !HEX8.test(value.session) || typeof value.bootId !== 'string' || !HEX8.test(value.bootId) || typeof value.ready !== 'boolean' || !['idle', 'receiving', 'ready', 'failed', 'installing'].includes(value.state) ||
      !Number.isInteger(value.uptimeMs) || value.uptimeMs < 0 || value.uptimeMs > 0xffffffff || value.imageSha256 !== null && (typeof value.imageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.imageSha256)) ||
      Object.hasOwn(value, 'forceSupported') && typeof value.forceSupported !== 'boolean' || Object.hasOwn(value, 'forceReady') && typeof value.forceReady !== 'boolean') return null;
  return { v: 1, boardId: BOARD_ID, applicationAddress: APPLICATION_ADDRESS, maxSize: MAX_SIZE, chunkSize: CHUNK_SIZE, session: value.session, bootId: value.bootId,
    ready: value.ready, forceSupported: value.forceSupported === true, forceReady: value.forceReady === true,
    state: value.state, uptimeMs: value.uptimeMs, imageSha256: value.imageSha256 };
}
module.exports = { BOARD_ID, APPLICATION_ADDRESS, MAX_SIZE, CHUNK_SIZE, OP, keyFrom, validateImage, manifest, command, forceBegin, response, capability, errors };
