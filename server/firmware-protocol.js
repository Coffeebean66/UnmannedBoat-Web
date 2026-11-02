/* OTA v1 字段与固件身份校验；不接受浏览器提供签名、加载地址或磁盘路径。 */
'use strict';
const crypto = require('node:crypto');
const BOARD_ID = 0x07530001, APPLICATION_ADDRESS = 0x08020000, MAX_SIZE = 640 * 1024, CHUNK_SIZE = 256;
const AB_BOARD_ID = 0x07530002, AB_ADDRESSES = Object.freeze([0x08020000, 0x08100000]);
const AB_HEADER_SIZE = 160, MAX_UPLOAD_SIZE = AB_HEADER_SIZE + 2 * MAX_SIZE;
const OP = Object.freeze({ BEGIN: 1, DATA: 2, COMMIT: 3, ABORT: 4, BEGIN_FORCE: 5 });
const HEX8 = /^[a-f0-9]{16}$/, HEX16 = /^[a-f0-9]{32}$/;
const errors = ['成功', '单片机正在处理其他升级操作', '请先将遥控倍率归零并确认两路电机停稳至少1秒', '固件数据格式或偏移不正确',
  '固件身份校验失败，请检查服务器和单片机的OTA密钥是否一致', '单片机Flash写入失败', '固件摘要校验失败', '单片机不支持此升级操作', '单片机会话已变化，请重新开始', '单片机升级等待超时'];
const fault = message => Object.assign(Error(message), { status: 400 });
function keyFrom(value) { return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value) ? Buffer.from(value, 'hex') : null; }
function validateImage(image, applicationAddress = APPLICATION_ADDRESS) {
  if (!Buffer.isBuffer(image) || image.length < 256 || image.length > MAX_SIZE) throw fault('固件必须是256字节至640 KiB的OTA应用.bin文件');
  const sp = image.readUInt32LE(0), reset = image.readUInt32LE(4), address = reset & 0xfffffffe;
  // 本项目 MSP 位于 DTCM；允许 H753 的 D1/D2/D3 SRAM，仍要求8字节对齐。
  const ram = [[0x20000000, 0x20020000], [0x24000000, 0x24080000], [0x30000000, 0x30048000], [0x38000000, 0x38010000]];
  if (!AB_ADDRESSES.includes(applicationAddress) || sp % 8 || !ram.some(([low, high]) => sp > low && sp <= high) || !(reset & 1) || address < applicationAddress || address >= applicationAddress + image.length)
    throw fault('固件向量不匹配OTA应用地址0x' + applicationAddress.toString(16) + '；请上传对应OTA构建，不能使用原来的直烧固件');
  return { size: image.length, sha256: crypto.createHash('sha256').update(image).digest('hex') };
}
function manifest(image, key, cap = { boardId: BOARD_ID, applicationAddress: APPLICATION_ADDRESS }) {
  const info = validateImage(image, cap.applicationAddress);
  if (![BOARD_ID, AB_BOARD_ID].includes(cap.boardId) || cap.boardId === BOARD_ID && cap.applicationAddress !== APPLICATION_ADDRESS) throw fault('OTA固件身份不正确');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('OTA key unavailable');
  const result = Buffer.alloc(88); result.write('BOATOTA1', 0, 'ascii'); result.writeUInt32LE(cap.boardId, 8);
  result.writeUInt32LE(cap.applicationAddress, 12); result.writeUInt32LE(image.length, 16); Buffer.from(info.sha256, 'hex').copy(result, 24);
  crypto.createHmac('sha256', key).update(result.subarray(0, 56)).digest().copy(result, 56);
  return result;
}
function selectImage(upload, cap) {
  if (cap.v !== 2) return { image: upload, ...validateImage(upload) };
  if (!Buffer.isBuffer(upload) || upload.length < AB_HEADER_SIZE + 512 || upload.length > MAX_UPLOAD_SIZE ||
      upload.subarray(0, 8).toString('hex') !== '424f415441423200' || upload.readUInt32LE(8) !== 2 ||
      upload.readUInt32LE(12) !== AB_BOARD_ID || upload.readUInt32LE(16) !== AB_ADDRESSES[0] ||
      upload.readUInt32LE(56) !== AB_ADDRESSES[1] || upload.subarray(128, 160).some(byte => byte !== 0))
    throw fault('A/B设备需要双镜像.boatota升级包；请运行tools/build-ota-ab.ps1，不能上传单独.bin');
  const sizes = [upload.readUInt32LE(20), upload.readUInt32LE(60)];
  if (sizes.some(size => size < 256 || size > MAX_SIZE) || AB_HEADER_SIZE + sizes[0] + sizes[1] !== upload.length)
    throw fault('A/B升级包大小或分区布局不正确');
  const images = [upload.subarray(160, 160 + sizes[0]), upload.subarray(160 + sizes[0])];
  const info = images.map((image, slot) => validateImage(image, AB_ADDRESSES[slot]));
  if (!Buffer.from(info[0].sha256, 'hex').equals(upload.subarray(24, 56)) ||
      !Buffer.from(info[1].sha256, 'hex').equals(upload.subarray(64, 96)) ||
      !crypto.createHash('sha256').update(upload.subarray(160)).digest().equals(upload.subarray(96, 128)))
    throw fault('A/B升级包摘要校验失败，请重新编译或上传');
  const target = cap.activeSlot === 'A' ? 1 : 0;
  if (cap.applicationAddress !== AB_ADDRESSES[target]) throw fault('设备的A/B目标区不正确');
  return { image: images[target], ...info[target], targetSlot: target ? 'B' : 'A' };
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
  const ab = value?.v === 2;
  if (!value || ![1, 2].includes(value.v) || value.boardId !== (ab ? AB_BOARD_ID : BOARD_ID) ||
      (ab ? !['A', 'B'].includes(value.activeSlot) || value.applicationAddress !== AB_ADDRESSES[value.activeSlot === 'A' ? 1 : 0] ||
        typeof value.confirmed !== 'boolean' || !Number.isInteger(value.rollbackCount) || value.rollbackCount < 0 || value.rollbackCount > 0xffffffff ||
        !Number.isInteger(value.rollbackReason) || value.rollbackReason < 0 || value.rollbackReason > 2 ||
        !value.confirmed && (value.ready || value.forceReady) : value.applicationAddress !== APPLICATION_ADDRESS) || value.maxSize !== MAX_SIZE || value.chunkSize !== CHUNK_SIZE ||
      typeof value.session !== 'string' || !HEX8.test(value.session) || typeof value.bootId !== 'string' || !HEX8.test(value.bootId) || typeof value.ready !== 'boolean' || !['idle', 'receiving', 'ready', 'failed', 'installing'].includes(value.state) ||
      !Number.isInteger(value.uptimeMs) || value.uptimeMs < 0 || value.uptimeMs > 0xffffffff || value.imageSha256 !== null && (typeof value.imageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.imageSha256)) ||
      Object.hasOwn(value, 'forceSupported') && typeof value.forceSupported !== 'boolean' || Object.hasOwn(value, 'forceReady') && typeof value.forceReady !== 'boolean') return null;
  return { v: value.v, boardId: value.boardId, applicationAddress: value.applicationAddress, maxSize: MAX_SIZE, chunkSize: CHUNK_SIZE, session: value.session, bootId: value.bootId,
    ready: value.ready, forceSupported: value.forceSupported === true, forceReady: value.forceReady === true,
    state: value.state, uptimeMs: value.uptimeMs, imageSha256: value.imageSha256,
    ...(ab ? { activeSlot: value.activeSlot, confirmed: value.confirmed, rollbackCount: value.rollbackCount, rollbackReason: value.rollbackReason } : {}) };
}
module.exports = { BOARD_ID, APPLICATION_ADDRESS, MAX_SIZE, AB_BOARD_ID, AB_ADDRESSES, MAX_UPLOAD_SIZE, CHUNK_SIZE, OP, keyFrom, validateImage, selectImage, manifest, command, forceBegin, response, capability, errors };
