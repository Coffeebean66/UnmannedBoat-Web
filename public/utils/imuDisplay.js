/* 原始IMU显示：角速度/欧拉角分别有效，源年龄与手机等待时间共同决定超时。 */
const IMU_SOURCE_TIMEOUT_MS = 1000;
const IMU_LINK_TIMEOUT_MS = 1500;

function prepareImuDisplay(frame, receivedAt, now, connected) {
  const data = frame && frame.imu;
  const elapsed = Math.max(0, now - receivedAt);
  const age = data && data.ageMs !== null ? data.ageMs + elapsed : null;
  const sourceFresh = !!(connected && data && data.received && data.fresh &&
    age !== null && age < IMU_SOURCE_TIMEOUT_MS && elapsed < IMU_LINK_TIMEOUT_MS);
  const gyroFresh = !!(sourceFresh && data.gyroValid);
  const eulerFresh = !!(sourceFresh && data.eulerValid &&
    [data.rollDegrees, data.pitchDegrees, data.yawDegrees].every(Number.isFinite));
  let status = '等待 IMU 数据';
  if (!connected) status = '未连接';
  else if (frame && elapsed >= IMU_LINK_TIMEOUT_MS) status = 'IMU 转发链路超时';
  else if (data && !data.received) status = 'USART3 未收到 IMU 帧';
  else if (data && !sourceFresh) status = 'IMU 数据已过期';
  else if (sourceFresh && !gyroFresh && !eulerFresh) status = 'IMU 数据无效';
  else if (sourceFresh && !gyroFresh) status = '角速度无效';
  else if (sourceFresh && !eulerFresh) status = '欧拉角无效';
  else if (sourceFresh) status = '实时';
  return {
    status, sourceFresh, gyroFresh, eulerFresh,
    fresh: gyroFresh && eulerFresh,
    gyroX: gyroFresh ? data.gyroRadps[0].toFixed(3) : '--',
    gyroY: gyroFresh ? data.gyroRadps[1].toFixed(3) : '--',
    gyroZ: gyroFresh ? data.gyroRadps[2].toFixed(3) : '--',
    roll: eulerFresh ? data.rollDegrees.toFixed(2) : '--',
    pitch: eulerFresh ? data.pitchDegrees.toFixed(2) : '--',
    yaw: eulerFresh ? data.yawDegrees.toFixed(2) : '--',
    // 仪表使用原始数值，避免把占位符转换成零或丢失小数精度。
    rollDegrees: eulerFresh ? data.rollDegrees : null,
    pitchDegrees: eulerFresh ? data.pitchDegrees : null,
    yawDegrees: eulerFresh ? data.yawDegrees : null,
    alignmentText: sourceFresh ? (data.timeAligned ? '已对齐' : '未对齐') : '--',
    headingUpdateText: !sourceFresh ? '--' : !data.headingAvailable ? '等待航向' :
      data.headingFresh ? '本帧新值' : '保持值',
    ageText: data && data.received && age !== null ? `${Math.round(age)} ms` : '--',
    sequence: frame ? frame.sequence : '--'
  };
}

module.exports = { prepareImuDisplay };
