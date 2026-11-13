/* 验证真实PCM采样的幅值、负数边界、跨块采样与静音，而非只检查滑块数值。 */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createVolumeTransform } = require('../server/camera-audio-tools');
const { once } = require('node:events');
async function processAudio(chunks, volume) {
  const stream = createVolumeTransform(volume), output = []; stream.on('data', chunk => output.push(chunk));
  const done = once(stream, 'end'); for (const chunk of chunks) stream.write(chunk); stream.end(); await done; return Buffer.concat(output);
}
test('PCM音量以幅值缩放，静音归零且原始音量保留全部16位边界', async () => {
  const values = [-32768, -20000, -1, 0, 1, 20000, 32767], input = Buffer.alloc(values.length * 2); values.forEach((value, index) => input.writeInt16LE(value, index * 2));
  for (const volume of [0, 1, 50, 100]) {
    const out = await processAudio([Buffer.from(input.subarray(0, 1)), Buffer.from(input.subarray(1, 6)), Buffer.from(input.subarray(6))], volume);
    assert.equal(out.length, input.length); values.forEach((value, index) => assert.equal(out.readInt16LE(index * 2), Math.round(value * volume / 100) || 0));
  }
});
test('音量可在流中变化，跨块字节仍组成同一采样；截断采样会报错', async () => {
  const stream = createVolumeTransform(100), chunks = []; stream.on('data', chunk => chunks.push(chunk));
  const done = once(stream, 'end'); stream.write(Buffer.from([0x10, 0x27])); stream.setVolume(50); stream.write(Buffer.from([0x10])); stream.write(Buffer.from([0x27])); stream.setVolume(0); stream.end(Buffer.from([0xf0, 0xd8])); await done;
  const out = Buffer.concat(chunks); assert.deepEqual([0, 2, 4].map(offset => out.readInt16LE(offset)), [10000, 5000, 0]);
  await assert.rejects(processAudio([Buffer.from([1])], 100), /采样不完整/);
  for (const value of [-1, 101, 1.5, null, '50']) assert.throws(() => createVolumeTransform(value), error => error.status === 400);
});
