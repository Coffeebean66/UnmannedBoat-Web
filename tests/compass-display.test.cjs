'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareCompassDisplay } = require('../public/utils/compassDisplay');

const boat = (overrides = {}) => ({ boat: {
  received: true, headingValid: true, feedbackValid: true, ageMs: 10, controlMode: 2,
  targetHeading: 90, actualHeading: 35, targetMps: 1, ...overrides
} });
const rtk = (overrides = {}) => ({ velocity: {
  received: true, fresh: true, ageMs: 10, hasNavigation: true, headingValid: true,
  velocityValid: true, fixValid: true, headingDegrees: 70, xMps: 1, yMps: 0, ...overrides
} });
function prepare(boatFrame = boat(), velocityFrame = rtk(), options = {}) {
  return prepareCompassDisplay(boatFrame, options.boatAt ?? 100, velocityFrame,
    options.velocityAt ?? 100, options.now ?? 100, options.connected ?? true);
}

test('各模式优先控制器真实船头航向，只有角度模式出现目标', () => {
  for (const controlMode of [0, 1, 2]) {
    const view = prepare(boat({ controlMode, feedbackValid: false }));
    assert.equal(view.headingDegrees, 35);
    assert.equal(view.headingSource, 'fused');
    assert.equal(view.targetDegrees, controlMode === 2 ? 90 : null);
    assert.equal(view.turnDegrees, controlMode === 2 ? 55 : null);
  }
  assert.equal(prepare(boat({ controlMode: undefined })).targetDegrees, null);
});

test('控制器航向失效或船速年龄未知时回退独立有效 RTK 船头朝向', () => {
  for (const invalid of [{ received: false }, { headingValid: false }, { ageMs: null }, { ageMs: -1 },
    { ageMs: 1000 }, { actualHeading: NaN }, { actualHeading: '35' }, { actualHeading: 360 }]) {
    const view = prepare(boat(invalid));
    assert.equal(view.headingDegrees, 70);
    assert.equal(view.headingSource, 'rtk');
  }
  const noHeading = prepare(boat({ headingValid: false }), rtk({ headingValid: false }));
  assert.equal(noHeading.headingDegrees, null);
  assert.equal(noHeading.headingSource, null);
  assert.equal(noHeading.turnDegrees, null);
  assert.equal(noHeading.targetDegrees, 90, '设定值不依赖反馈是否有效');
});

test('船头、运动方向和位置有效位各自独立，不将运动角或局部 yaw 充当船头', () => {
  const view = prepare(boat({ headingValid: false }), rtk({ fixValid: false, headingValid: false, yawDegrees: 123 }));
  assert.equal(view.headingDegrees, null);
  assert.equal(view.courseDegrees, 90);
  assert.equal(view.speedMps, 1);
  const headingOnly = prepare(null, rtk({ velocityValid: false, fixValid: false }));
  assert.equal(headingOnly.headingDegrees, 70);
  assert.equal(headingOnly.speedMps, null);
  assert.equal(headingOnly.courseDegrees, null);
  assert.equal(prepare(null, rtk({ hasNavigation: false })).headingDegrees, null);
});

test('RTK 东/北分量生成四方位和斜向航迹，倒车也保留实际运动方向', () => {
  for (const [xMps, yMps, degrees] of [[0, 2, 0], [2, 0, 90], [0, -2, 180], [-2, 0, 270]]) {
    const view = prepare(boat({ actualHeading: 0, targetHeading: 0, targetMps: -2 }), rtk({ xMps, yMps }));
    assert.equal(view.courseDegrees, degrees);
    assert.equal(view.speedMps, 2);
    assert.equal(view.headingDegrees, 0);
    assert.equal(view.targetDegrees, 0, '倒车不翻转船头目标');
  }
  const diagonal = prepare(null, rtk({ xMps: 3, yMps: 4 }));
  assert.equal(diagonal.speedMps, 5);
  assert.ok(Math.abs(diagonal.courseDegrees - 36.86989764584402) < 1e-10);
});

test('0.1m/s 以下仅显示合速，不用静止噪声生成航迹方向', () => {
  for (const xMps of [0, 0.001, -0.099]) {
    const view = prepare(null, rtk({ xMps, yMps: 0 }));
    assert.equal(view.speedMps, Math.abs(xMps));
    assert.equal(view.courseDegrees, null);
  }
  assert.equal(prepare(null, rtk({ xMps: 0.1, yMps: 0 })).courseDegrees, 90);
});

test('跨北点角差走最短方向，180度相反方向统一为向右180度', () => {
  for (const [actualHeading, targetHeading, difference] of [[359, 1, 2], [1, 359, -2],
    [0, 180, 180], [180, 0, 180], [90, 90, 0], [270, 0, 90]]) {
    assert.equal(prepare(boat({ actualHeading, targetHeading })).turnDegrees, difference);
  }
});

test('无效目标不会隐藏可信实测航向和航迹，数值字符串不能变为目标', () => {
  for (const targetHeading of [-1, 360, NaN, Infinity, null, undefined, '90']) {
    const view = prepare(boat({ targetHeading }));
    assert.equal(view.headingDegrees, 35);
    assert.equal(view.targetDegrees, null);
    assert.equal(view.turnDegrees, null);
    assert.equal(view.courseDegrees, 90);
  }
});

test('源年龄叠加本页等待时间，达到1000ms分别失效，不以新船体帧刷新旧RTK', () => {
  assert.equal(prepare(boat({ ageMs: 0 }), rtk({ ageMs: 0 }), { now: 1099 }).headingSource, 'fused');
  const staleBoat = prepare(boat(), rtk(), { boatAt: 0, velocityAt: 1000, now: 1000 });
  assert.equal(staleBoat.headingSource, 'rtk');
  assert.equal(staleBoat.targetDegrees, null);
  const staleRtk = prepare(boat(), rtk(), { boatAt: 1000, velocityAt: 0, now: 1000 });
  assert.equal(staleRtk.headingSource, 'fused');
  assert.equal(staleRtk.courseDegrees, null);
  assert.equal(staleRtk.speedMps, null);
  const aged = prepare(boat({ ageMs: 950 }), rtk({ ageMs: 950 }), { now: 150 });
  assert.equal(aged.headingDegrees, null);
  assert.equal(aged.courseDegrees, null);
  assert.equal(aged.targetDegrees, 90, '目标时效来自控制帧而非反馈源');
  for (const flags of [{ received: false }, { fresh: false }, { ageMs: null }, { ageMs: -1 }]) {
    assert.equal(prepare(null, rtk(flags)).speedMps, null);
    assert.equal(prepare(null, rtk(flags)).headingDegrees, null);
  }
});

test('断开或切换到无数据船只后清空所有动态量，不显示旧船方向', () => {
  const expected = { headingDegrees: null, headingSource: null, targetDegrees: null,
    courseDegrees: null, speedMps: null, turnDegrees: null, connected: false, status: '未连接' };
  assert.deepEqual(prepare(boat(), rtk(), { connected: false }), expected);
  const empty = prepare(null, null);
  assert.deepEqual(empty, { ...expected, connected: true, status: '等待有效航向' });
});

test('残缺对象、非法时钟与非法速度不会抛错或产生伪零方向', () => {
  for (const frame of [null, {}, { boat: {} }]) {
    assert.equal(prepare(frame, null).headingDegrees, null);
    assert.equal(prepare(frame, null).targetDegrees, null);
  }
  for (const frame of [null, {}, { velocity: {} }]) assert.equal(prepare(null, frame).courseDegrees, null);
  for (const xMps of ['1', null, undefined, NaN, Infinity, -32.769, 32.768]) {
    const view = prepare(null, rtk({ xMps }));
    assert.equal(view.courseDegrees, null);
    assert.equal(view.speedMps, null);
    assert.equal(view.headingDegrees, 70);
  }
  for (const bad of [NaN, Infinity, -1, '100']) {
    const invalidNow = prepare(boat(), rtk(), { now: bad });
    assert.equal(invalidNow.headingDegrees, null);
    assert.equal(invalidNow.targetDegrees, null);
    assert.equal(invalidNow.courseDegrees, null);
    assert.equal(prepare(boat(), null, { boatAt: bad }).headingDegrees, null);
    assert.equal(prepare(null, rtk(), { velocityAt: bad }).headingDegrees, null);
  }
});
