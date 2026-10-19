/* IMU 使用船体 X前/Y左/Z上、ZYX 欧拉角；GLB 已自带 Z-up 到 Y-up 的转换。
 * 因此只将“姿态旋转”换基，不能再给模型几何重复转 90°。 */
const DEG = Math.PI / 180;

function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// glTF 与 WebGL 均使用列主序；先执行 b，再执行 a。
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1)
    for (let row = 0; row < 4; row += 1)
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return out;
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [0, 1, 2].map(row => matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]);
}

function normalizeQuaternion(q) {
  const length = Math.hypot(...q);
  if (!Number.isFinite(length) || length < 1e-8) throw new Error('姿态四元数无效');
  return q.map(value => value / length);
}

function quaternionMatrix(input) {
  const [x, y, z, w] = normalizeQuaternion(input);
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1
  ]);
}

function nodeMatrix(node) {
  if (node.matrix) {
    if (node.matrix.length !== 16 || !node.matrix.every(Number.isFinite)) throw new Error('模型变换无效');
    return new Float32Array(node.matrix);
  }
  const matrix = quaternionMatrix(node.rotation || [0, 0, 0, 1]);
  const scale = node.scale || [1, 1, 1];
  const position = node.translation || [0, 0, 0];
  if (scale.length !== 3 || position.length !== 3 || ![...scale, ...position].every(Number.isFinite))
    throw new Error('模型位置或缩放无效');
  for (let column = 0; column < 3; column += 1)
    for (let row = 0; row < 3; row += 1) matrix[column * 4 + row] *= scale[column];
  matrix.set(position, 12);
  return matrix;
}

function poseFromDisplay(display) {
  if (!display || !display.eulerFresh) return null;
  const values = [display.roll, display.pitch, display.yaw];
  if (values.some(value => (typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value)))) return null;
  const [roll, pitch, yaw] = values.map(Number);
  if (Math.abs(roll) > 180 || Math.abs(pitch) > 90 || Math.abs(yaw) > 180) return null;
  return { roll, pitch, yaw };
}

function renderQuaternion(pose, yawOffset = 0) {
  const r = pose.roll * DEG / 2;
  const p = pose.pitch * DEG / 2;
  const y = (pose.yaw - yawOffset) * DEG / 2;
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p);
  const cy = Math.cos(y), sy = Math.sin(y);
  // 先求 Rz(yaw) * Ry(pitch) * Rx(roll)，再将轴 (x,y,z) 映射为 (x,z,-y)。
  const qx = sr * cp * cy - cr * sp * sy;
  const qy = cr * sp * cy + sr * cp * sy;
  const qz = cr * cp * sy - sr * sp * cy;
  const qw = cr * cp * cy + sr * sp * sy;
  return normalizeQuaternion([qx, qz, -qy, qw]);
}

// 四元数走最短弧，避免偏航从 +179° 到 -179° 时模型反转一整圈。
function slerp(a, b, fraction) {
  let target = b;
  let dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  if (dot < 0) { target = b.map(value => -value); dot = -dot; }
  const t = Math.max(0, Math.min(1, fraction));
  if (dot > 0.9995) return normalizeQuaternion(a.map((value, index) => value + t * (target[index] - value)));
  const angle = Math.acos(Math.min(1, dot));
  const denominator = Math.sin(angle);
  return a.map((value, index) => (value * Math.sin((1 - t) * angle) + target[index] * Math.sin(t * angle)) / denominator);
}

function rotationDistance(a, b) {
  return 1 - Math.min(1, Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0)));
}

function perspective(aspect) {
  const f = 1 / Math.tan(35 * DEG / 2), near = 0.1, far = 30;
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0,
    (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
}

function lookAt(eye) {
  const normalize = v => { const length = Math.hypot(...v); return v.map(value => value / length); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = normalize(eye), x = normalize(cross([0, 1, 0], z)), y = cross(z, x);
  const dot = a => -a.reduce((sum, value, i) => sum + value * eye[i], 0);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0, dot(x), dot(y), dot(z), 1]);
}

module.exports = { DEG, identity, multiply, transformPoint, nodeMatrix, quaternionMatrix,
  poseFromDisplay, renderQuaternion, slerp, rotationDistance, perspective, lookAt };
