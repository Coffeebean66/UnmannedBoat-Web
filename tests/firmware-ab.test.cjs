/* 双物理链接镜像与试运行确认，不访问真实船端或MQTT服务器。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const P = require('../server/firmware-protocol'), { FirmwareService } = require('../server/firmware-service');
const { firmwareName } = require('../server/firmware-api');
const KEY = Buffer.alloc(32, 0x42), SESSION = '01'.repeat(8), BOOT = '02'.repeat(8);
function image(slot, size = 1024) {
  const bytes = Buffer.alloc(size, slot + 0x55);
  bytes.writeUInt32LE(0x20020000, 0); bytes.writeUInt32LE(P.AB_ADDRESSES[slot] + 129, 4); return bytes;
}
function bundle() {
  const a = image(0), b = image(1, 1280), header = Buffer.alloc(160);
  header.write('BOATAB2\0'); header.writeUInt32LE(2, 8); header.writeUInt32LE(P.AB_BOARD_ID, 12);
  header.writeUInt32LE(P.AB_ADDRESSES[0], 16); header.writeUInt32LE(a.length, 20);
  crypto.createHash('sha256').update(a).digest().copy(header, 24);
  header.writeUInt32LE(P.AB_ADDRESSES[1], 56); header.writeUInt32LE(b.length, 60);
  crypto.createHash('sha256').update(b).digest().copy(header, 64);
  crypto.createHash('sha256').update(a).update(b).digest().copy(header, 96);
  return Buffer.concat([header, a, b]);
}
function capability(active = 'A', extra = {}) {
  return Buffer.from(JSON.stringify({ v: 2, boardId: P.AB_BOARD_ID, applicationAddress: P.AB_ADDRESSES[active === 'A' ? 1 : 0],
    maxSize: P.MAX_SIZE, chunkSize: 256, session: SESSION, bootId: BOOT, imageSha256: null, ready: true,
    forceSupported: true, forceReady: true, state: 'idle', uptimeMs: 1000, activeSlot: active, confirmed: true,
    rollbackCount: 0, rollbackReason: 0, ...extra }));
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const limit = Date.now() + 1500;
  while (!predicate()) { if (Date.now() >= limit) throw Error('Timed out'); await turn(); }
}
class Bridge extends EventEmitter {
  constructor() { super(); this.brokerConnected = true; this.sent = []; this.locks = new Set(); this.size = 0; }
  claimFirmware(id) { this.locks.add(id); }
  releaseFirmware(id) { this.locks.delete(id); }
  publishFirmware(deviceId, packet) {
    this.sent.push(Buffer.from(packet));
    if ([P.OP.BEGIN, P.OP.BEGIN_FORCE].includes(packet[4])) this.size = packet.readUInt32LE(56);
    if (packet[4] !== P.OP.ABORT) queueMicrotask(() => {
      const ack = Buffer.alloc(48); ack.write('BOR1'); ack[4] = packet[4]; packet.copy(ack, 8, 8, 32);
      ack.writeUInt32LE(packet[4] === P.OP.DATA ? packet.readUInt32LE(32) + packet.readUInt32LE(36) : packet[4] === P.OP.COMMIT ? this.size : 0, 32);
      ack.writeUInt32LE(this.size, 36); this.emit('firmware-response', { deviceId, payload: ack });
    });
    return Promise.resolve();
  }
  cap(active = 'A', extra = {}) { this.emit('firmware-capability', { deviceId: 'boat-01', payload: capability(active, extra) }); }
}
function fixture(t, active = 'A') {
  const bridge = new Bridge(), service = new FirmwareService({ bridge, key: KEY, installTimeoutMs: 1000 });
  t.after(() => service.close()); bridge.cap(active); return { bridge, service };
}
test('A/B capabilities bind running/target addresses, health and rollback fields; old layout stays distinct', () => {
  for (const active of ['A', 'B']) {
    const cap = P.capability(capability(active)); assert.equal(cap.activeSlot, active); assert.equal(cap.v, 2);
    const chosen = P.selectImage(bundle(), cap), target = active === 'A' ? 1 : 0;
    assert.deepEqual(chosen.image, image(target, target ? 1280 : 1024));
    const signed = P.manifest(chosen.image, KEY, cap);
    assert.equal(signed.readUInt32LE(8), P.AB_BOARD_ID); assert.equal(signed.readUInt32LE(12), P.AB_ADDRESSES[target]);
    assert.deepEqual(signed.subarray(56), crypto.createHmac('sha256', KEY).update(signed.subarray(0, 56)).digest());
  }
  for (const extra of [{ activeSlot: 'C' }, { activeSlot: [] }, { confirmed: 1 }, { rollbackCount: -1 }, { rollbackCount: 0x100000000 },
    { rollbackReason: 3 }, { applicationAddress: P.AB_ADDRESSES[0] }, { boardId: P.BOARD_ID }, { confirmed: false }, { v: 3 }])
    assert.equal(P.capability(capability('A', extra)), null);
  assert.equal(P.capability(capability('B', { confirmed: false, ready: false, forceReady: false })).confirmed, false);
  assert.equal(firmwareName('双区固件.boatota'), '双区固件.boatota');
});
test('single, truncated, oversized, swapped, tampered and wrong-address images fail before starting transport', t => {
  const f = fixture(t), valid = bundle();
  const bad = [image(0), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.alloc(1)]), Buffer.alloc(P.MAX_UPLOAD_SIZE + 1)];
  for (const offset of [0, 8, 12, 16, 20, 24, 56, 60, 64, 96, 128, 160 + 4, 160 + 130, valid.length - 1]) {
    const bytes = Buffer.from(valid); bytes[offset] ^= 1; bad.push(bytes);
  }
  for (const bytes of bad) assert.throws(() => f.service.start('boat-01', 'invalid.boatota', bytes), { status: 400 });
  assert.equal(f.bridge.sent.length, 0); assert.equal(f.bridge.locks.size, 0);
  assert.throws(() => P.selectImage(valid, { v: 1 }), { status: 400 });
});
test('A to B and B to A transmit only the inactive image; a trial report cannot complete the job', async t => {
  for (const active of ['A', 'B']) {
    const f = fixture(t, active), target = active === 'A' ? 'B' : 'A';
    const expected = image(target === 'B' ? 1 : 0, target === 'B' ? 1280 : 1024);
    const start = f.service.start('boat-01', 'dual.boatota', bundle());
    assert.equal(start.job.targetSlot, target); assert.equal(start.job.size, expected.length);
    await until(() => f.service.snapshot('boat-01').job.state === 'installing');
    const chunks = f.bridge.sent.filter(packet => packet[4] === P.OP.DATA).map(packet => packet.subarray(40));
    assert.deepEqual(Buffer.concat(chunks), expected);
    const sha256 = P.validateImage(expected, P.AB_ADDRESSES[target === 'B' ? 1 : 0]).sha256;
    f.bridge.cap(target, { bootId: '03'.repeat(8), confirmed: false, ready: false, forceReady: false, imageSha256: sha256 });
    assert.equal(f.service.snapshot('boat-01').job.state, 'installing'); assert.equal(f.bridge.locks.size, 1);
    f.bridge.cap(target, { bootId: '03'.repeat(8), imageSha256: sha256 });
    assert.equal(f.service.snapshot('boat-01').job.state, 'succeeded'); assert.equal(f.bridge.locks.size, 0);
  }
});
test('a reboot into the old confirmed slot with increased rollback counter reports automatic rollback', async t => {
  for (const reason of [1, 2]) {
    const f = fixture(t); f.service.start('boat-01', 'bad-runtime.boatota', bundle(), { force: true });
    await until(() => f.service.snapshot('boat-01').job.state === 'installing');
    f.bridge.cap('A', { bootId: '04'.repeat(8), rollbackCount: 1, rollbackReason: reason });
    const job = f.service.snapshot('boat-01').job;
    assert.equal(job.state, 'rolled_back'); assert.match(job.error, /自动回滚/); assert.equal(f.bridge.locks.size, 0);
    assert.equal(f.service.jobs.get('boat-01').image, null);
  }
});
