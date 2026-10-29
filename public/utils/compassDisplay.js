/* 罗盘只使用真北参考航向；原始 IMU yaw 是局部坐标，不能直接当作绝对船头朝向。 */
const SOURCE_TIMEOUT_MS = 1000;
const MIN_COURSE_SPEED_MPS = 0.1;

function validHeading(value) {
  return Number.isFinite(value) && value >= 0 && value < 360;
}

function elapsedSince(receivedAt, now) {
  if (!Number.isFinite(receivedAt) || receivedAt < 0 || !Number.isFinite(now) || now < 0) return null;
  return Math.max(0, now - receivedAt);
}

function sourceFresh(data, elapsed) {
  return !!(data && data.received === true && elapsed !== null && elapsed < SOURCE_TIMEOUT_MS &&
    Number.isFinite(data.ageMs) && data.ageMs >= 0 && data.ageMs + elapsed < SOURCE_TIMEOUT_MS);
}

function validSpeedComponent(value) {
  // UART4 中 RTK 东/北速度为 int16 毫米每秒，拒绝异常对象和超出协议范围的值。
  return Number.isFinite(value) && value >= -32.768 && value <= 32.767;
}

function normalizeBearing(value) {
  return ((value % 360) + 360) % 360;
}

function shortestTurn(target, heading) {
  const difference = normalizeBearing(target - heading + 180) - 180;
  // 罗盘角顺时针增加：正值向右、负值向左；恰好相差 180° 时统一显示 +180°。
  return difference === -180 ? 180 : difference;
}

/**
 * 生成罗盘快照，各数据源独立判断时效，不依赖经纬度定位是否有效。
 * 船体帧的 actualHeading 来自控制器航向管线，各控制模式均会上报；
 * 它未单列航向年龄，因此沿用既有展示规则，以船速样本年龄保守检查，失效再回退 RTK。
 */
function prepareCompassDisplay(boatFrame, boatAt, velocityFrame, velocityAt, now, connected) {
  const result = {
    headingDegrees: null, headingSource: null, targetDegrees: null, courseDegrees: null,
    speedMps: null, turnDegrees: null, connected: connected === true, status: '等待有效航向'
  };
  if (!result.connected) { result.status = '未连接'; return result; }
  const boat = boatFrame && boatFrame.boat;
  const velocity = velocityFrame && velocityFrame.velocity;
  const boatElapsed = elapsedSince(boatAt, now);
  const velocityElapsed = elapsedSince(velocityAt, now);
  const boatCurrent = !!(boat && boatElapsed !== null && boatElapsed < SOURCE_TIMEOUT_MS);
  const rtkFresh = sourceFresh(velocity, velocityElapsed) && velocity.fresh === true;

  if (sourceFresh(boat, boatElapsed) && boat.headingValid === true && validHeading(boat.actualHeading)) {
    result.headingDegrees = boat.actualHeading;
    result.headingSource = 'fused';
  } else if (rtkFresh && velocity.hasNavigation === true && velocity.headingValid === true && validHeading(velocity.headingDegrees)) {
    result.headingDegrees = velocity.headingDegrees;
    result.headingSource = 'rtk';
  }

  // 目标表示船头的设定朝向，倒车时也不额外翻转 180°；它与实际航迹角不同。
  if (boatCurrent && boat.controlMode === 2 && validHeading(boat.targetHeading)) result.targetDegrees = boat.targetHeading;

  if (rtkFresh && velocity.velocityValid !== false && validSpeedComponent(velocity.xMps) && validSpeedComponent(velocity.yMps)) {
    result.speedMps = Math.hypot(velocity.xMps, velocity.yMps);
    // X 向东、Y 向北，北为 0°，顺时针增加；低速时隐藏航迹角，避免静止噪声指向。
    if (result.speedMps >= MIN_COURSE_SPEED_MPS)
      result.courseDegrees = normalizeBearing(Math.atan2(velocity.xMps, velocity.yMps) * 180 / Math.PI);
  }
  if (result.headingDegrees !== null && result.targetDegrees !== null)
    result.turnDegrees = shortestTurn(result.targetDegrees, result.headingDegrees);

  result.status = result.headingSource === 'fused' ? '实时控制器航向' : result.headingSource === 'rtk' ? '实时 RTK 航向' :
    boat || velocity ? '航向无效或已过期' : '等待有效航向';
  return result;
}

module.exports = { prepareCompassDisplay, MIN_COURSE_SPEED_MPS };
