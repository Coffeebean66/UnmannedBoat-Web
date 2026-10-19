const { prepareBoatDisplay } = require('./boatDisplay');
const { prepareVelocityDisplay } = require('./velocityDisplay');

// 遥测速度使用有符号 int16，单位为 mm/s；异常值不能变成地图上的长箭头。
const MIN_SPEED_COMPONENT = -32.768;
const MAX_SPEED_COMPONENT = 32.767;
const BOAT_NUMBERS = ['targetMps', 'actualMps', 'requestedMps', 'commonPercent',
  'turnPercent', 'targetHeading', 'actualHeading', 'headingError'];
const VELOCITY_NUMBERS = ['xMps', 'yMps', 'zRadps', 'latitude', 'longitude', 'headingDegrees'];

function validHeading(value) {
  return Number.isFinite(value) && value >= 0 && value < 360;
}

function validSpeedComponent(value) {
  return Number.isFinite(value) && value >= MIN_SPEED_COMPONENT && value <= MAX_SPEED_COMPONENT;
}

// 复用现有显示层的独立超时规则；只为它补全数值字段，避免残缺对象在格式化时抛错。
// NaN 不会用于箭头计算，后续仍逐项检查原始数值及有效位。
function safeDisplayFrame(frame, key, fields) {
  const source = frame && frame[key];
  if (!source || typeof source !== 'object') return null;
  const data = { ...source };
  for (const field of fields) data[field] = Number.isFinite(source[field]) ? source[field] : NaN;
  data.ageMs = Number.isFinite(source.ageMs) && source.ageMs >= 0 ? source.ageMs : null;
  return { ...frame, [key]: data };
}

function normalizeBearing(value) {
  return ((value % 360) + 360) % 360;
}

/**
 * 生成 WGS84 船位上的目标/实际速度矢量，不做地图投影或 DOM 操作。
 * 船体帧决定控制模式与目标，RTK 帧提供位置和实际东/北速度；两者各自检查 1 秒超时。
 */
function prepareMapVelocity(boatFrame, boatReceivedAt, velocityFrame, velocityReceivedAt, now, connected) {
  const empty = { closedLoop: false, fix: null, target: null, actual: null };
  if (!Number.isFinite(now)) return empty;
  const boat = boatFrame && boatFrame.boat;
  const velocity = velocityFrame && velocityFrame.velocity;
  const boatDisplay = prepareBoatDisplay(safeDisplayFrame(boatFrame, 'boat', BOAT_NUMBERS),
    Number.isFinite(boatReceivedAt) ? boatReceivedAt : NaN, now, connected);
  const velocityDisplay = prepareVelocityDisplay(safeDisplayFrame(velocityFrame, 'velocity', VELOCITY_NUMBERS),
    Number.isFinite(velocityReceivedAt) ? velocityReceivedAt : NaN, now, connected);
  const mode = boat && boat.controlMode !== undefined ? boat.controlMode : boat && boat.speedLoop ? 1 : 0;
  const closedLoop = !!(boatDisplay.current && boat.speedLoop && (mode === 1 || mode === 2));
  const fix = velocityDisplay.fixFresh && Number.isFinite(velocity.latitude) &&
    Number.isFinite(velocity.longitude) && Math.abs(velocity.latitude) <= 90 && Math.abs(velocity.longitude) <= 180
    ? { latitude: velocity.latitude, longitude: velocity.longitude } : null;
  const result = { closedLoop, fix, target: null, actual: null };
  if (!closedLoop || !fix) return result;

  if (validSpeedComponent(boat.targetMps)) {
    const speedMps = Math.abs(boat.targetMps);
    // 角度模式跟随目标罗盘航向；速度模式跟随船头朝向，不能拿运动航迹角替代。
    const heading = mode === 2 ? boat.targetHeading
      : boatDisplay.headingFresh && validHeading(boat.actualHeading) ? boat.actualHeading
        : velocityDisplay.headingFresh && validHeading(velocity.headingDegrees) ? velocity.headingDegrees : null;
    if (speedMps === 0) result.target = { speedMps: 0, bearingDegrees: null };
    else if (validHeading(heading)) result.target = {
      speedMps,
      // 负目标速度代表倒车，目标运动方向相对船头旋转 180°。
      bearingDegrees: normalizeBearing(heading + (boat.targetMps < 0 ? 180 : 0))
    };
  }

  if (velocityDisplay.fresh && validSpeedComponent(velocity.xMps) && validSpeedComponent(velocity.yMps)) {
    const speedMps = Math.hypot(velocity.xMps, velocity.yMps);
    result.actual = {
      speedMps,
      // 上位机 X 向东、Y 向北；atan2(东, 北) 转成北为 0°、顺时针增大的地图方向。
      bearingDegrees: speedMps === 0 ? null : normalizeBearing(Math.atan2(velocity.xMps, velocity.yMps) * 180 / Math.PI)
    };
  }
  return result;
}

module.exports = { prepareMapVelocity };
