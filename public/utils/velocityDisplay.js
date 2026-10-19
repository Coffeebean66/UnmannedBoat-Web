/* 实际速度卡片的数据转换。数据源与手机链路分别判定超时。 */
const SOURCE_TIMEOUT_MS = 1000;
const LINK_TIMEOUT_MS = 1500;

function prepareVelocityDisplay(frame, receivedAt, now, connected) {
  const data = frame && frame.velocity;
  const elapsed = Math.max(0, now - receivedAt);
  // 将MCU生成帧时的源年龄加上手机等待时间，两端的时间戳无需同步。
  const age = data && data.ageMs !== null ? data.ageMs + elapsed : null;
  const sourceFresh = !!(connected && data && data.received && data.fresh &&
    age !== null && age < SOURCE_TIMEOUT_MS && elapsed < LINK_TIMEOUT_MS);
  // 三个源有效位分别生效：速度失效不应隐藏仍有效的定位或航向。
  // 旧协议没有velocityValid字段，只有明确的false才判定源速度无效。
  const fresh = sourceFresh && data.velocityValid !== false;
  const fixFresh = !!(sourceFresh && data.hasNavigation && data.fixValid);
  const headingFresh = !!(sourceFresh && data.hasNavigation && data.headingValid);
  let status = '等待速度数据';
  if (!connected) status = '未连接';
  else if (frame && elapsed >= LINK_TIMEOUT_MS) status = '转发链路超时';
  else if (data && !data.received) status = 'USART3 未收到数据';
  else if (data && !sourceFresh) status = '速度数据已过期';
  else if (sourceFresh && !fresh) status = '速度无效';
  else if (fresh) status = '实时';

  let fixStatus = '等待定位数据';
  if (!connected) fixStatus = '未连接';
  else if (frame && elapsed >= LINK_TIMEOUT_MS) fixStatus = '转发链路超时';
  else if (data && !data.received) fixStatus = 'USART3 未收到数据';
  else if (data && !sourceFresh) fixStatus = '定位数据已过期';
  else if (data && !data.hasNavigation) fixStatus = '旧协议无经纬度';
  else if (sourceFresh && !fixFresh) fixStatus = '定位无效';
  else if (fixFresh) fixStatus = '实时定位';

  // 超时不显示为“0 速度”，防止把断流误解为船已停止。
  return {
    fresh,
    sourceFresh,
    fixFresh,
    headingFresh,
    fixStatus,
    status,
    x: fresh ? data.xMps.toFixed(3) : '--',
    y: fresh ? data.yMps.toFixed(3) : '--',
    z: fresh && Number.isFinite(data.zRadps) ? data.zRadps.toFixed(3) : '--',
    latitude: fixFresh ? data.latitude.toFixed(7) : '--',
    longitude: fixFresh ? data.longitude.toFixed(7) : '--',
    heading: headingFresh ? data.headingDegrees.toFixed(2) : '--',
    // 时间对齐只描述上位机话题时间关系，不代表RTK固定解或定位精度等级。
    alignmentText: sourceFresh && data.hasNavigation ? (data.timeAligned ? '已对齐' : '未对齐') : '--',
    planar: fresh ? Math.sqrt(data.xMps ** 2 + data.yMps ** 2).toFixed(3) : '--',
    ageText: data && data.received && age !== null ? `${Math.round(age)} ms` : '--',
    sequence: frame ? frame.sequence : '--'
  };
}

module.exports = { prepareVelocityDisplay };
