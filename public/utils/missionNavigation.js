/* 航线几何统一使用 WGS84，真北为 0°、顺时针增加。地图偏移不得参与控制。 */
'use strict';
const R = 6371008.8, RAD = Math.PI / 180;
const wrap = angle => (angle % 360 + 360) % 360;
const angleError = (target, actual) => (target - actual + 540) % 360 - 180;
function distance(a, b) {
  const lat = (b.latitude - a.latitude) * RAD, lon = (b.longitude - a.longitude) * RAD;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.latitude * RAD) * Math.cos(b.latitude * RAD) * Math.sin(lon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
function bearing(a, b) {
  const d = (b.longitude - a.longitude) * RAD, x = a.latitude * RAD, y = b.latitude * RAD;
  return wrap(Math.atan2(Math.sin(d) * Math.cos(y), Math.cos(x) * Math.sin(y) - Math.sin(x) * Math.cos(y) * Math.cos(d)) / RAD);
}
function destination(a, heading, meters) {
  const d = meters / R, h = heading * RAD, lat = a.latitude * RAD;
  const y = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(h));
  const x = a.longitude * RAD + Math.atan2(Math.sin(h) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(y));
  return {latitude: y / RAD, longitude: (x / RAD + 540) % 360 - 180};
}
// 沿当前航段向前看，修正横向偏差；超越终点仍返回终点，不能跳过未到达的航点。
function guide(position, start, end, lookAheadM) {
  const lengthM = distance(start, end), d = distance(start, position) / R;
  const delta = angleError(bearing(start, position), bearing(start, end)) * RAD;
  const alongM = Math.atan2(Math.sin(d) * Math.cos(delta), Math.cos(d)) * R;
  const crossM = Math.asin(Math.max(-1, Math.min(1, Math.sin(d) * Math.sin(delta)))) * R;
  const aim = destination(start, bearing(start, end), Math.min(lengthM, Math.max(0, alongM) + lookAheadM));
  return {heading: bearing(position, aim), distanceM: distance(position, end), crossM, alongM, lengthM};
}
module.exports = {distance, bearing, destination, guide, wrap, angleError};
