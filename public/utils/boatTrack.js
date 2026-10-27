const { wgs84ToGcj02 } = require('./mapCoordinates');

// 正常航行每秒最多留一个点，滤除不足 1 米的微小位移，限制长期运行时的地图负担。
const TRACK_SAMPLE_INTERVAL_MS = 1000;
const TRACK_GAP_MS = 1000;
const TRACK_MIN_DISTANCE_M = 1;
const TRACK_MAX_POINTS = 1000;
const TRACK_MAX_SEGMENTS = 64;

// 每 0.5 m/s 一档，由冷到暖表示实际对地速率；超过 3 m/s 仍使用最高档。
const TRACK_SPEED_BANDS = [
  { id: 'speed-0', label: '0–0.5', maxMps: 0.5, color: '#2563eb' },
  { id: 'speed-1', label: '0.5–1', maxMps: 1, color: '#0891b2' },
  { id: 'speed-2', label: '1–1.5', maxMps: 1.5, color: '#16a34a' },
  { id: 'speed-3', label: '1.5–2', maxMps: 2, color: '#ca8a04' },
  { id: 'speed-4', label: '2–2.5', maxMps: 2.5, color: '#ea580c' },
  { id: 'speed-5', label: '2.5–3', maxMps: 3, color: '#dc2626' }
];
const TRACK_UNKNOWN_SPEED = { id: 'unknown', label: '速度无效', color: '#94a3b8' };
// 图例与折线共用颜色定义，避免修改档位后页面说明与路径颜色不一致。
const TRACK_SPEED_LEGEND = TRACK_SPEED_BANDS.map(({ id, label, color }) => ({ id, label, color }))
  .concat(TRACK_UNKNOWN_SPEED);

function speedColor(speedMps) {
  if (speedMps === null) return TRACK_UNKNOWN_SPEED.color;
  const band = TRACK_SPEED_BANDS.find(item => speedMps < item.maxMps);
  return (band || TRACK_SPEED_BANDS[TRACK_SPEED_BANDS.length - 1]).color;
}

function mapPoint(point) {
  // 地图只接收坐标，不把内部的速度元数据提交给原生 map 组件。
  return { latitude: point.latitude, longitude: point.longitude };
}

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const latitudeDelta = (b.latitude - a.latitude) * radians;
  const longitudeDelta = (b.longitude - a.longitude) * radians;
  const value = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))));
}

// 轨迹只在本次首页会话内保留，不写入手机预设、单片机 RAM 或 Flash。
class BoatTrack {
  constructor(project = wgs84ToGcj02) {
    this.project = project;
    this.active = false;
    this.revision = 0;
    this.clear();
  }

  clear() {
    this.segments = [];
    this.pointCount = 0;
    this.truncated = false;
    this.breakSegment();
    this.revision += 1;
  }

  start() {
    this.active = true;
    this.breakSegment();
  }

  stop() {
    this.active = false;
    this.breakSegment();
  }

  // 云端每秒采样的历史不能套用实时1秒断流判据；5秒空窗或无效定位才分段。
  restore(samples) {
    const active = this.active;
    this.clear();this.active = active;
    let previous = null;
    for (const sample of samples || []) {
      const raw = sample?.velocity, timestamp = sample?.timestamp;
      const valid = raw?.received === true && raw.fresh === true && raw.fixValid === true && raw.hasNavigation === true &&
        Number.isFinite(raw.ageMs) && raw.ageMs >= 0 && raw.ageMs < 1000 && Number.isFinite(raw.latitude) && Number.isFinite(raw.longitude) &&
        Math.abs(raw.latitude) <= 90 && Math.abs(raw.longitude) <= 180;
      const point = valid && this.project(raw.latitude, raw.longitude);
      if (!point || !Number.isFinite(timestamp)) { previous = null; continue; }
      if (!previous || timestamp <= previous.timestamp || timestamp - previous.timestamp > 5000) this.segments.push([]);
      const speedMps = raw.velocityValid === true && Number.isFinite(raw.xMps) && Number.isFinite(raw.yMps) ? Math.hypot(raw.xMps, raw.yMps) : null;
      this.segments[this.segments.length - 1].push({ ...point, speedMps });this.pointCount++;
      previous = { timestamp, raw };
    }
    while (this.segments.length > TRACK_MAX_SEGMENTS) { this.pointCount -= this.segments.shift().length;this.truncated = true; }
    while (this.pointCount > TRACK_MAX_POINTS) { this.segments[0].shift();this.pointCount--;if (!this.segments[0].length) this.segments.shift();this.truncated = true; }
    this.breakSegment();this.revision++;
  }

  // 暂停、定位无效或断流后另起一段，不能把缺失的航程绘成直线。
  breakSegment() {
    this.segmentOpen = false;
    this.lastObservedAt = null;
    this.lastPointAt = null;
    this.lastRawPoint = null;
  }

  record(raw, now, fixFresh) {
    if (!this.active) return false;
    const point = fixFresh && raw && this.project(raw.latitude, raw.longitude);
    if (!point || !Number.isFinite(now)) {
      this.breakSegment();
      return false;
    }
    // 即使过期检查定时器还没有运行，新帧也不能跨过超过源超时的空窗续线。
    if (this.lastObservedAt !== null &&
        (now < this.lastObservedAt || now - this.lastObservedAt >= TRACK_GAP_MS)) {
      this.breakSegment();
    }
    this.lastObservedAt = now;
    if (this.segmentOpen && (now - this.lastPointAt < TRACK_SAMPLE_INTERVAL_MS ||
        distanceMeters(this.lastRawPoint, raw) < TRACK_MIN_DISTANCE_M)) return false;

    if (!this.segmentOpen) {
      this.segments.push([]);
      this.segmentOpen = true;
    }
    // 路径与船位图钉使用同一坐标转换；距离筛选使用未转换的 WGS84 数据。
    // 保存采样当时的速度，后续速度变化不会重染历史路径。定位有效但速度无效时
    // 继续记录位置，以 null 区分未知速度和真实的 0 m/s。
    const speedMps = raw.velocityValid === true && Number.isFinite(raw.xMps) && Number.isFinite(raw.yMps)
      ? Math.hypot(raw.xMps, raw.yMps) : null;
    this.segments[this.segments.length - 1].push({ ...point, speedMps });
    this.lastRawPoint = { latitude: raw.latitude, longitude: raw.longitude };
    this.lastPointAt = now;
    this.pointCount += 1;
    while (this.segments.length > TRACK_MAX_SEGMENTS) {
      this.pointCount -= this.segments.shift().length;
      this.truncated = true;
    }
    while (this.pointCount > TRACK_MAX_POINTS) {
      this.segments[0].shift();
      this.pointCount -= 1;
      if (!this.segments[0].length) this.segments.shift();
      this.truncated = true;
    }
    this.revision += 1;
    return true;
  }

  polylines() {
    const lines = [];
    this.segments.forEach(points => {
      let line = null;
      for (let index = 1; index < points.length; index += 1) {
        // 每条边按终点采样时的速度着色；相邻同色边合并，变色处共用边界点。
        // 每个连续航段重新建线，不能因颜色相同而跨越暂停或定位失效区间。
        const color = speedColor(points[index].speedMps);
        if (!line || line.color !== color) {
          line = { points: [mapPoint(points[index - 1])], color, width: 4, dottedLine: false };
          lines.push(line);
        }
        line.points.push(mapPoint(points[index]));
      }
    });
    // 全部坐标均为副本，后续采样和裁剪不会修改已经提交给 setData 的对象。
    return lines;
  }
}

module.exports = {
  BoatTrack, TRACK_MAX_POINTS, TRACK_MAX_SEGMENTS, TRACK_SPEED_LEGEND
};
