const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareMapVelocity } = require('../public/utils/mapVelocity');

function boat(overrides = {}) {
  return { boat: {
    received: true, feedbackValid: true, ageMs: 0, speedLoop: true, controlMode: 2,
    headingValid: true, sbusValid: true, motorsValid: true, controlEnabled: true,
    targetMps: 1.5, actualMps: 1.2, requestedMps: 2, commonPercent: 30, turnPercent: 0,
    targetHeading: 90, actualHeading: 30, headingError: 60, ...overrides
  } };
}

function rtk(overrides = {}) {
  return { velocity: {
    received: true, fresh: true, ageMs: 0, hasNavigation: true, fixValid: true,
    velocityValid: true, headingValid: true, xMps: 1, yMps: 0,
    latitude: 31.2, longitude: 121.5, headingDegrees: 70, ...overrides
  } };
}

function prepare(boatFrame = boat(), velocityFrame = rtk(), options = {}) {
  return prepareMapVelocity(boatFrame, options.boatReceivedAt ?? 100,
    velocityFrame, options.velocityReceivedAt ?? 100, options.now ?? 100, options.connected ?? true);
}

test('实际速度按东/北分量得到四个罗盘方向和速率，独立于船头朝向', () => {
  for (const [xMps, yMps, bearingDegrees] of [[0, 2, 0], [2, 0, 90], [0, -2, 180], [-2, 0, 270]]) {
    const actual = prepare(boat(), rtk({ xMps, yMps })).actual;
    assert.equal(actual.speedMps, 2);
    assert.equal(actual.bearingDegrees, bearingDegrees);
  }
  const diagonal = prepare(boat(), rtk({ xMps: 3, yMps: 4 })).actual;
  assert.equal(diagonal.speedMps, 5);
  assert.ok(Math.abs(diagonal.bearingDegrees - 36.86989764584402) < 1e-10);
});

test('角度模式使用斜坡目标速度和目标航向，倒车旋转 180 度', () => {
  assert.deepEqual(prepare().target, { speedMps: 1.5, bearingDegrees: 90 });
  assert.deepEqual(prepare(boat({ targetMps: -2, targetHeading: 270 })).target,
    { speedMps: 2, bearingDegrees: 90 });
  assert.deepEqual(prepare(boat({ targetMps: -2, targetHeading: 180 })).target,
    { speedMps: 2, bearingDegrees: 0 });
});

test('速度模式优先融合船头航向，失效时使用 RTK 船头航向，不使用实际运动方向', () => {
  assert.equal(prepare(boat({ controlMode: 1 })).target.bearingDegrees, 30);
  assert.equal(prepare(boat({ controlMode: 1, headingValid: false })).target.bearingDegrees, 70);
  assert.equal(prepare(boat({ controlMode: 1, headingValid: false, targetMps: -1 })).target.bearingDegrees, 250);
  assert.equal(prepare(boat({ controlMode: 1, actualHeading: NaN })).target.bearingDegrees, 70);
  assert.equal(prepare(boat({ controlMode: 1, headingValid: false }), rtk({ headingValid: false })).target, null);
});

test('目标航向无效只隐藏目标箭头，实际运动方向仍可用', () => {
  for (const targetHeading of [-1, 360, Infinity, NaN, null, '90']) {
    const state = prepare(boat({ targetHeading }));
    assert.equal(state.target, null);
    assert.deepEqual(state.actual, { speedMps: 1, bearingDegrees: 90 });
  }
});

test('零目标/实际速度返回无方向的零速点，不借用航向创建箭头', () => {
  const state = prepare(boat({ targetMps: 0, targetHeading: NaN }), rtk({ xMps: 0, yMps: 0, headingValid: false }));
  assert.deepEqual(state.target, { speedMps: 0, bearingDegrees: null });
  assert.deepEqual(state.actual, { speedMps: 0, bearingDegrees: null });
});

test('开环、未知模式或断开连接不创建任何速度箭头', () => {
  for (const frame of [boat({ speedLoop: false }), boat({ controlMode: 0 }), boat({ controlMode: 3 })]) {
    const state = prepare(frame);
    assert.equal(state.closedLoop, false);
    assert.equal(state.target, null);
    assert.equal(state.actual, null);
    assert.ok(state.fix);
  }
  assert.deepEqual(prepare(boat(), rtk(), { connected: false }),
    { closedLoop: false, fix: null, target: null, actual: null });
  assert.equal(prepare(boat({ controlMode: undefined })).closedLoop, true);
});

test('船体帧与 RTK 帧分别检查超时，达到 1000ms 即隐藏对应箭头', () => {
  assert.ok(prepare(boat(), rtk(), { now: 1099 }).actual);
  const staleBoat = prepare(boat(), rtk(), { boatReceivedAt: 0, now: 1000, velocityReceivedAt: 1000 });
  assert.equal(staleBoat.closedLoop, false);
  assert.equal(staleBoat.target, null);
  assert.equal(staleBoat.actual, null);
  assert.ok(staleBoat.fix);
  const staleRtk = prepare(boat(), rtk(), { boatReceivedAt: 1000, now: 1000, velocityReceivedAt: 0 });
  assert.equal(staleRtk.closedLoop, true);
  assert.equal(staleRtk.fix, null);
  assert.equal(staleRtk.target, null);
  assert.equal(staleRtk.actual, null);
  assert.equal(prepare(boat(), rtk({ ageMs: 950 }), { now: 150 }).fix, null);
  assert.equal(prepare(boat({ controlMode: 1, ageMs: 1000 })).target.bearingDegrees, 70);
});

test('定位、速度、航向有效位各自生效，速度无效时仍可显示目标', () => {
  const invalidVelocity = prepare(boat(), rtk({ velocityValid: false }));
  assert.ok(invalidVelocity.fix);
  assert.ok(invalidVelocity.target);
  assert.equal(invalidVelocity.actual, null);
  for (const flags of [{ received: false }, { fresh: false }, { fixValid: false }, { hasNavigation: false }]) {
    const state = prepare(boat(), rtk(flags));
    assert.equal(state.fix, null);
    assert.equal(state.target, null);
    assert.equal(state.actual, null);
  }
});

test('经纬度边界合法，越界/非数值坐标隐藏全部速度箭头', () => {
  for (const longitude of [-180, 180]) {
    assert.deepEqual(prepare(boat(), rtk({ latitude: 90, longitude })).fix, { latitude: 90, longitude });
  }
  for (const position of [{ latitude: -90.1 }, { latitude: 90.1 }, { longitude: 180.1 },
    { longitude: -180.1 }, { latitude: NaN }, { longitude: Infinity }, { longitude: null }]) {
    const state = prepare(boat(), rtk(position));
    assert.equal(state.fix, null);
    assert.equal(state.target, null);
    assert.equal(state.actual, null);
  }
});

test('残缺帧、无效时间和线速度不抛错，也不会生成异常箭头', () => {
  for (const frame of [null, {}, { boat: {} }]) {
    assert.equal(prepare(frame).closedLoop, false);
  }
  for (const frame of [null, {}, { velocity: {} }]) assert.equal(prepare(boat(), frame).fix, null);
  for (const ageMs of [-1, Infinity, NaN, null]) assert.equal(prepare(boat(), rtk({ ageMs })).fix, null);
  for (const targetMps of [Infinity, NaN, null, '1', 32.768, -32.769]) {
    assert.equal(prepare(boat({ targetMps })).target, null);
  }
  for (const xMps of [Infinity, NaN, null, '1', 32.768, -32.769]) {
    assert.equal(prepare(boat(), rtk({ xMps })).actual, null);
  }
  assert.ok(prepare(boat({ targetMps: -32.768 }), rtk({ xMps: 32.767, yMps: -32.768 })).actual);
  assert.equal(prepare(boat(), rtk(), { now: NaN }).closedLoop, false);
  assert.equal(prepare(boat(), rtk(), { boatReceivedAt: NaN }).closedLoop, false);
  assert.equal(prepare(boat(), rtk(), { velocityReceivedAt: NaN }).fix, null);
});
