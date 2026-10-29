/* 服务器历史用于回看，绝不产生在线状态或参数能力；时间换算与实时数据保持同一单调时钟。 */
'use strict';
const { createBoatChartSample } = require('./boatChart');
const MAX_HISTORY_POINTS = 3600;

function historyFrame(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const frame = {};
  if (summary.velocity && typeof summary.velocity === 'object') frame.velocity = summary.velocity;
  if (summary.boat && typeof summary.boat === 'object') frame.boat = summary.boat;
  if (summary.imu && typeof summary.imu === 'object') frame.imu = summary.imu;
  if (summary.status && typeof summary.status === 'object') Object.assign(frame, summary.status);
  return Object.keys(frame).length ? frame : null;
}

function prepareHistory(result, deviceId, nowWall, nowMono) {
  if (!result || result.deviceId !== deviceId || !Array.isArray(result.samples) || result.samples.length > MAX_HISTORY_POINTS ||
      !Number.isFinite(nowWall) || !Number.isFinite(nowMono)) throw Error('历史记录格式不正确');
  const records = result.samples.filter(item => item && (!item.deviceId || item.deviceId === deviceId) && Number.isFinite(item.receivedAt) && item.receivedAt > 0 && item.receivedAt <= nowWall + 1000)
    .map(item => ({ ...item, frame: historyFrame(item.summary), at: nowMono - Math.max(0, nowWall - item.receivedAt) }))
    .filter(item => item.frame).sort((a, b) => a.receivedAt - b.receivedAt);
  const chart = [], points = [];
  // 历史默认每秒采样，不能套用实时流的 1 秒断线阈值，否则曲线只剩孤立点。
  const gapMs = Math.max(5000, Number.isFinite(result.recording?.sampleMs) ? result.recording.sampleMs * 2.5 : 5000);
  for (const item of records) {
    const boat = item.frame.boat;
    const chartable = boat && ['targetMps', 'actualMps', 'requestedMps', 'commonPercent', 'turnPercent'].every(key => Number.isFinite(boat[key])) &&
      (boat.controlMode !== 2 || ['targetHeading', 'actualHeading', 'headingError'].every(key => Number.isFinite(boat[key])));
    if (chartable) chart.push(createBoatChartSample(item.frame, item.at, item.at, true, chart.at(-1), gapMs));
    if (item.frame.velocity) points.push({ velocity: item.frame.velocity, timestamp: item.at });
  }
  const source = result.latest;
  let latest = null;
  if (source && (!source.deviceId || source.deviceId === deviceId) && Number.isFinite(source.receivedAt) && source.receivedAt > 0 && source.receivedAt <= nowWall + 1000) {
    const frame = historyFrame(source.summary), age = Math.max(0, nowWall - source.receivedAt);
    if (frame) latest = { frame, receivedAt: source.receivedAt, at: nowMono - age, ageMs: age };
  }
  const receivedAt = latest?.receivedAt || records.at(-1)?.receivedAt || null;
  const last = latest?.frame || records.at(-1)?.frame;
  const velocity = last?.velocity, boat = last?.boat;
  const sourceFresh = velocity?.received === true && velocity.fresh === true && Number.isFinite(velocity.ageMs) && velocity.ageMs >= 0 && velocity.ageMs < 1000;
  const boatFresh = boat?.received === true && Number.isFinite(boat.ageMs) && boat.ageMs >= 0 && boat.ageMs < 1000;
  const fix = sourceFresh && velocity?.hasNavigation === true && velocity.fixValid === true && Number.isFinite(velocity.latitude) &&
    Number.isFinite(velocity.longitude) && Math.abs(velocity.latitude) <= 90 && Math.abs(velocity.longitude) <= 180 ?
    { latitude: velocity.latitude, longitude: velocity.longitude } : null;
  return { chart, points, latest, receivedAt, end: records.at(-1)?.at ?? null, recording: result.recording || null,
    last: { speedMps: boatFresh && boat.feedbackValid === true && Number.isFinite(boat.actualMps) ? boat.actualMps : sourceFresh && velocity.velocityValid === true && Number.isFinite(velocity.xMps) && Number.isFinite(velocity.yMps) ? Math.hypot(velocity.xMps, velocity.yMps) : null,
      headingDegrees: boatFresh && boat.headingValid === true && Number.isFinite(boat.actualHeading) && boat.actualHeading >= 0 && boat.actualHeading < 360 ? boat.actualHeading : sourceFresh && velocity.headingValid === true && Number.isFinite(velocity.headingDegrees) && velocity.headingDegrees >= 0 && velocity.headingDegrees < 360 ? velocity.headingDegrees : null,
      fix } };
}

module.exports = { historyFrame, prepareHistory, MAX_HISTORY_POINTS };
