/* NavSatFix 使用 WGS84；微信 map 使用 GCJ-02。只转换地图点，数字显示保留原值。
 * 常用境内偏移算法为近似换算，不能据此声称厘米级地图精度；境外范围直接使用原坐标。 */
const PI = Math.PI;
const A = 6378245.0;              // 偏移近似模型使用的椭球长半轴，单位米。
const EE = 0.006693421622965943;   // 椭球第一偏心率平方，用于纬度方向的尺度修正。

// x/y为相对基准经纬度的偏移量；多项式与正弦项组合得到近似纬向偏移。
function latitudeOffset(x, y) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  value += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  return value + (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
}

// 经向偏移与纬向模型不同，最后在wgs84ToGcj02中按当地纬度换算成角度。
function longitudeOffset(x, y) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  value += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  return value + (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
}

// 返回地图使用的新坐标对象，不覆盖RTK原始经纬度；非法坐标返回null。
function wgs84ToGcj02(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // 此包围框只用于限定近似算法的应用范围，不是精确的国界判定。
  if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271) {
    return { latitude, longitude };
  }
  const radLat = latitude * PI / 180;
  const sinLat = Math.sin(radLat);
  const magic = 1 - EE * sinLat * sinLat;
  const sqrtMagic = Math.sqrt(magic);
  return {
    latitude: latitude + latitudeOffset(longitude - 105, latitude - 35) * 180 /
      ((A * (1 - EE) / (magic * sqrtMagic)) * PI),
    longitude: longitude + longitudeOffset(longitude - 105, latitude - 35) * 180 /
      (A / sqrtMagic * Math.cos(radLat) * PI)
  };
}

// 高德点选坐标反算后保存为 WGS84；迭代只消除模型内误差，不代表底图定位精度。
function gcj02ToWgs84(latitude, longitude) {
  if (!wgs84ToGcj02(latitude, longitude)) return null;
  const raw = {latitude, longitude};
  for (let i = 0; i < 10; i++) {
    const projected = wgs84ToGcj02(raw.latitude, raw.longitude);
    if (!projected) return null;
    const dy = projected.latitude - latitude, dx = projected.longitude - longitude;
    raw.latitude -= dy; raw.longitude -= dx;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 1e-9) break;
  }
  return raw;
}
module.exports = { wgs84ToGcj02, gcj02ToWgs84 };
