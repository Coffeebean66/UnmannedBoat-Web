(function(root) {
'use strict';
const modules = {
"utils/boatAttitude.js": function(require, module, exports) {
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

},
"utils/boatChart.js": function(require, module, exports) {
const { prepareBoatDisplay } = require('./boatDisplay');

// 与固件一致，角差范围为 [-180, 180)，参数顺序为“目标、实际”。
function shortestAngleError(target, actual) {
  return ((target - actual + 180) % 360 + 360) % 360 - 180;
}

function validHeading(value) {
  return Number.isFinite(value) && value >= 0 && value < 360;
}

function unfoldAngle(value, previousValue, previousPlot) {
  return Number.isFinite(value) ? (Number.isFinite(previousPlot) ?
    previousPlot + shortestAngleError(value, previousValue) : value) : null;
}

// 一条历史同时记录船速和航向，切换图表只改变展示，不丢弃另一种数据。
function createBoatChartSample(frame, receivedAt, timestamp, connected, previous, maxGapMs = 1000) {
  const b = frame && frame.boat;
  const view = prepareBoatDisplay(frame, receivedAt, timestamp, connected);
  const headingTarget = view.headingMode && validHeading(b.targetHeading) ? b.targetHeading : null;
  const headingActual = view.headingMode && view.headingFresh && validHeading(b.actualHeading) ?
    b.actualHeading : null;
  // 实时流间隔达到 1 秒时重建展开基准；历史回放按服务器采样周期设置连续阈值。
  const adjacent = previous && timestamp >= previous.timestamp && timestamp - previous.timestamp < maxGapMs;
  const headingTargetPlot = unfoldAngle(headingTarget,
    adjacent ? previous.headingTarget : null, adjacent ? previous.headingTargetPlot : null);
  let headingActualPlot = unfoldAngle(headingActual,
    adjacent ? previous.headingActual : null, adjacent ? previous.headingActualPlot : null);
  if (Number.isFinite(headingActual) && (!adjacent || !Number.isFinite(previous.headingActualPlot)) &&
      Number.isFinite(headingTargetPlot)) {
    // 新的实际线段从目标附近开始，例如目标 1°、实际 359° 绘为 1°、-1°。
    headingActualPlot = headingTargetPlot + shortestAngleError(headingActual, headingTarget);
  }
  return {
    timestamp, gapMs: maxGapMs,
    target: view.current && b.speedLoop ? Math.abs(b.targetMps) : null,
    actual: view.fresh && b.speedLoop ? b.actualMps : null,
    headingTarget, headingActual, headingTargetPlot, headingActualPlot
  };
}

function prepareBoatChartSummary(latest, mode) {
  const heading = mode === 'heading';
  const target = latest && latest[heading ? 'headingTarget' : 'target'];
  const actual = latest && latest[heading ? 'headingActual' : 'actual'];
  const precision = heading ? 2 : 3;
  return {
    target: Number.isFinite(target) ? target.toFixed(precision) : '--',
    actual: Number.isFinite(actual) ? actual.toFixed(precision) : '--',
    error: Number.isFinite(target) && Number.isFinite(actual) ?
      (heading ? shortestAngleError(target, actual) : actual - target).toFixed(precision) : '--'
  };
}

function prepareBoatChart(history, mode) {
  const heading = mode === 'heading';
  const summary = prepareBoatChartSummary(history[history.length - 1], mode);
  const samples = history.map(sample => ({
    timestamp: sample.timestamp, gapMs: sample.gapMs || 1000,
    target: sample[heading ? 'headingTargetPlot' : 'target'],
    actual: sample[heading ? 'headingActualPlot' : 'actual']
  }));
  const values = [];
  samples.forEach(sample => {
    if (Number.isFinite(sample.target)) values.push(sample.target);
    if (Number.isFinite(sample.actual)) values.push(sample.actual);
  });
  let minValue = 0;
  let maxValue = heading ? 360 : 0.6;
  if (values.length && heading) {
    const low = Math.min(...values);
    const high = Math.max(...values);
    const center = (low + high) / 2;
    const halfSpan = Math.max(20, high - low) * 1.15 / 2;
    // 航向纵轴允许负角和超过 360° 的展开角，保留至少 20° 范围观察小幅修正。
    minValue = Math.floor(center - halfSpan);
    maxValue = Math.ceil(center + halfSpan);
  } else if (values.length) {
    maxValue = Math.ceil(Math.max(0.5, ...values) * 1.15 * 10) / 10;
  }
  return { summary, samples, minValue, maxValue, hasValues: values.length > 0 };
}

module.exports = { shortestAngleError, createBoatChartSample, prepareBoatChartSummary, prepareBoatChart };

},
"utils/boatDisplay.js": function(require, module, exports) {
// 同时检查 MCU 反馈年龄与手机收帧后经过的时间，断流时不显示旧船速。
function prepareBoatDisplay(frame, receivedAt, now, connected) {
  const b = frame && frame.boat;
  const elapsed = Math.max(0, now - receivedAt);
  // fresh描述控制器反馈可用性，current仅描述手机是否还在收到船体帧。
  // MCU仍周期发送旧反馈状态时，不能只靠手机最近收包时间判断速度有效。
  const fresh = !!(connected && b && b.received && b.feedbackValid &&
    b.ageMs !== null && b.ageMs + elapsed < 1000);
  const current = !!(connected && b && elapsed < 1000);
  // 新帧提供0/1/2三种模式；旧船速帧只有闭环标志，因此只能还原PWM或速度模式。
  const mode = b && b.controlMode !== undefined ? b.controlMode : b && b.speedLoop ? 1 : 0;
  const headingMode = current && mode === 2;
  // 船体帧未单列航向年龄，此处还要求船速样本年龄可用，采取保守展示条件。
  const headingFresh = !!(current && b.headingValid && b.ageMs !== null && b.ageMs + elapsed < 1000);
  // 闭环分支先展示遥控/反馈异常，再显示正常闭环；开环分支只显示开环标记。
  const status = !connected ? '未连接' : !b ? '等待船速控制数据' : !current ? '通信超时'
    : !b.speedLoop ? '开环' : !b.sbusValid ? '遥控失联' : b.controlEnabled === false ? '低档停推'
      : headingMode && !headingFresh ? '航向无效，停止推进' : !fresh ? '等待有效船速'
        : !b.motorsValid ? '电调反馈超时' : b.reversing ? '等待停稳换向'
          : headingMode ? '航向与船速闭环' : '船速闭环';
  return {
    fresh, current, status,
    modeText: current ? ['PWM 模式', '速度模式', '角度模式'][mode] : '--',
    headingMode, headingFresh,
    targetHeading: headingMode ? b.targetHeading.toFixed(2) : '--',
    actualHeading: headingMode && headingFresh ? b.actualHeading.toFixed(2) : '--',
    headingError: headingMode && headingFresh ? b.headingError.toFixed(2) : '--',
    // 目标卡显示速率幅值，正负命令另外转换为“前进/后退”；不能据此推断漂移方向。
    target: current ? Math.abs(b.targetMps).toFixed(3) : '--',
    actual: fresh ? b.actualMps.toFixed(3) : '--',
    requested: current ? Math.abs(b.requestedMps).toFixed(3) : '--',
    direction: current ? (b.targetMps < 0 ? '后退' : b.targetMps > 0 ? '前进' : '停止推进') : '--',
    common: current ? b.commonPercent.toFixed(1) : '--',
    turn: current ? b.turnPercent.toFixed(1) : '--'
  };
}
module.exports = { prepareBoatDisplay };

},
"utils/boatHistory.js": function(require, module, exports) {
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

},
"utils/boatRenderer.js": function(require, module, exports) {
/* 微信 Canvas WebGL 1 船体与程序化水面；所有网格只在初始化时上传。 */
const { DEG, identity, multiply, quaternionMatrix, perspective, lookAt } = require('./boatAttitude');

const VERTEX = `
attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat4 u_model;
uniform mat4 u_viewProjection;
varying vec3 v_position;
varying vec3 v_normal;
void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_position = world.xyz;
  v_normal = mat3(u_model) * a_normal;
  gl_Position = u_viewProjection * world;
}`;
const FRAGMENT = `
precision mediump float;
uniform vec4 u_color;
uniform vec3 u_eye;
uniform float u_unlit;
uniform float u_metallic;
uniform float u_roughness;
varying vec3 v_position;
varying vec3 v_normal;
void main() {
  vec3 normal = normalize(v_normal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 light = normalize(vec3(0.5, 0.9, 0.6));
  vec3 halfDirection = normalize(light + normalize(u_eye - v_position));
  float diffuse = max(dot(normal, light), 0.0);
  float specular = pow(max(dot(normal, halfDirection), 0.0), mix(64.0, 6.0, u_roughness));
  vec3 color = u_color.rgb * (0.38 + 0.62 * diffuse);
  color += mix(vec3(0.08), u_color.rgb, u_metallic) * specular * 0.28;
  color = pow(max(color, vec3(0.0)), vec3(0.454545));
  gl_FragColor = vec4(mix(color, u_color.rgb, u_unlit), u_color.a);
}`;

// 水面只用两个三角形，波纹/高光在着色器里计算，不额外加载纹理或模拟船体运动。
const WATER_VERTEX = `
attribute vec3 a_position;
uniform mat4 u_viewProjection;
varying vec3 v_position;
void main() {
  v_position = a_position;
  gl_Position = u_viewProjection * vec4(a_position, 1.0);
}`;
const WATER_FRAGMENT = `
precision mediump float;
uniform float u_time;
uniform vec3 u_eye;
varying vec3 v_position;
void main() {
  vec2 p = v_position.xz;
  float swellA = dot(p, vec2(3.2, 2.1)) - u_time * 1.2;
  float swellB = dot(p, vec2(-1.7, 4.4)) + u_time * 0.8;
  float rippleA = sin(dot(p, vec2(18.0, 12.0)) - u_time * 0.6);
  float rippleB = sin(dot(p, vec2(-13.0, 22.0)) + u_time * 0.4);
  vec2 slope = vec2(3.2, 2.1) * (0.018 * cos(swellA))
    + vec2(-1.7, 4.4) * (0.012 * cos(swellB));
  vec3 normal = normalize(vec3(-slope.x + 0.025 * rippleA, 1.0, -slope.y + 0.02 * rippleB));
  vec3 view = normalize(u_eye - v_position);
  vec3 light = normalize(vec3(-0.45, 0.9, 0.3));
  float fresnel = pow(1.0 - max(dot(normal, view), 0.0), 3.0);
  float shine = pow(max(dot(normal, normalize(light + view)), 0.0), 80.0);
  float wave = 0.5 + 0.25 * sin(swellA) + 0.25 * sin(swellB);
  vec3 color = mix(vec3(0.018, 0.12, 0.18), vec3(0.055, 0.30, 0.34), wave);
  color += vec3(0.08, 0.20, 0.24) * fresnel;
  color += vec3(0.45, 0.76, 0.78) * shine * 0.65;
  float streak = dot(p, vec2(12.0, 9.0)) - u_time * 0.6 + 1.3 * sin(swellB);
  float glint = pow(0.5 + 0.5 * sin(streak), 16.0);
  color += vec3(0.028, 0.07, 0.08) * glint * (0.35 + 0.65 * wave);
  vec2 underBoat = p / vec2(1.5, 0.8);
  color *= 1.0 - 0.18 * exp(-dot(underBoat, underBoat) * 2.0);
  float edge = 1.0 - smoothstep(3.5, 7.5, length(p));
  gl_FragColor = vec4(color, 0.88 * edge);
}`;

class BoatRenderer {
  constructor(canvas, model) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { antialias: true, alpha: false, depth: true });
    if (!this.gl) throw new Error('当前设备无法显示 3D 模型');
    this.buffers = [];
    this.shaders = [];
    this.programs = [];
    this.meshes = [];
    this.resetCamera();
    const gl = this.gl;
    try {
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        this.shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('3D 绘制初始化失败');
        return shader;
      };
      const link = (vertex, fragment) => {
        const program = gl.createProgram();
        this.programs.push(program);
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('3D 绘制初始化失败');
        return program;
      };
      this.program = link(VERTEX, FRAGMENT);
      this.locations = {};
      for (const name of ['model', 'viewProjection', 'color', 'eye', 'unlit', 'metallic', 'roughness'])
        this.locations[name] = gl.getUniformLocation(this.program, `u_${name}`);
      this.position = gl.getAttribLocation(this.program, 'a_position');
      this.normal = gl.getAttribLocation(this.program, 'a_normal');
      this.meshes = model.primitives.map(mesh => ({ ...mesh,
        vertices: this.buffer(gl.ARRAY_BUFFER, mesh.positions),
        normalBuffer: this.buffer(gl.ARRAY_BUFFER, mesh.normals),
        indexBuffer: this.buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices), count: mesh.indices.length
      }));
      const grid = [];
      for (let i = -6; i <= 6; i += 1) {
        const value = i * 0.3;
        grid.push(-1.8, -0.48, value, 1.8, -0.48, value, value, -0.48, -1.8, value, -0.48, 1.8);
      }
      this.grid = this.buffer(gl.ARRAY_BUFFER, new Float32Array(grid));
      this.gridCount = grid.length / 3;
      this.waterProgram = link(WATER_VERTEX, WATER_FRAGMENT);
      this.waterLocations = {};
      for (const name of ['viewProjection', 'eye', 'time'])
        this.waterLocations[name] = gl.getUniformLocation(this.waterProgram, `u_${name}`);
      this.waterPosition = gl.getAttribLocation(this.waterProgram, 'a_position');
      // 水平面固定在场景中，不乘船体姿态矩阵；略低于船体中心以展示吃水效果。
      this.water = this.buffer(gl.ARRAY_BUFFER, new Float32Array([
        -8, -0.16, -8, -8, -0.16, 8, 8, -0.16, -8,
        8, -0.16, -8, -8, -0.16, 8, 8, -0.16, 8
      ]));
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE); // 船模含双面甲板和天线，背面也要可见。
      gl.clearColor(0.027, 0.078, 0.114, 1);
    } catch (error) { this.dispose(); throw error; }
  }

  buffer(target, data) {
    const gl = this.gl, buffer = gl.createBuffer();
    if (!buffer) throw new Error('3D 显存不足');
    this.buffers.push(buffer);
    gl.bindBuffer(target, buffer); gl.bufferData(target, data, gl.STATIC_DRAW);
    return buffer;
  }

  resetCamera() { this.cameraYaw = 42; this.cameraPitch = 30; }

  orbit(dx, dy) {
    this.cameraYaw -= dx * 0.45;
    this.cameraPitch = Math.max(8, Math.min(80, this.cameraPitch + dy * 0.35));
  }

  draw(quaternion, { waterEnabled = true, time = 0 } = {}) {
    if (this.disposed) return;
    const gl = this.gl;
    if (gl.isContextLost && gl.isContextLost()) throw new Error('3D 画面已暂停，请重新加载');
    const yaw = this.cameraYaw * DEG, pitch = this.cameraPitch * DEG, distance = 4.8;
    const eye = [distance * Math.cos(pitch) * Math.cos(yaw), distance * Math.sin(pitch),
      distance * Math.cos(pitch) * Math.sin(yaw)];
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    const viewProjection = multiply(perspective(this.canvas.width / this.canvas.height), lookAt(eye));
    gl.uniformMatrix4fv(this.locations.viewProjection, false, viewProjection);
    gl.uniform3fv(this.locations.eye, eye);
    gl.enableVertexAttribArray(this.position);
    if (!waterEnabled) {
      gl.disableVertexAttribArray(this.normal);
      gl.vertexAttrib3f(this.normal, 0, 1, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.grid);
      gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(this.locations.model, false, identity());
      gl.uniform4fv(this.locations.color, [0.08, 0.22, 0.28, 1]);
      gl.uniform1f(this.locations.unlit, 1);
      gl.drawArrays(gl.LINES, 0, this.gridCount);
    }
    gl.uniform1f(this.locations.unlit, 0);
    gl.uniformMatrix4fv(this.locations.model, false, quaternionMatrix(quaternion));
    gl.enableVertexAttribArray(this.normal);
    for (const mesh of this.meshes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertices);
      gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normalBuffer);
      gl.vertexAttribPointer(this.normal, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
      gl.uniform4fv(this.locations.color, mesh.color);
      gl.uniform1f(this.locations.metallic, mesh.metallic);
      gl.uniform1f(this.locations.roughness, mesh.roughness);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    if (waterEnabled) this.drawWater(viewProjection, eye, time);
  }

  drawWater(viewProjection, eye, time) {
    const gl = this.gl;
    gl.useProgram(this.waterProgram);
    gl.uniformMatrix4fv(this.waterLocations.viewProjection, false, viewProjection);
    gl.uniform3fv(this.waterLocations.eye, eye);
    // 所有波纹速率都是 0.2 的整数倍，按共同周期回绕可避免长时间运行后的精度下降。
    gl.uniform1f(this.waterLocations.time, Number.isFinite(time) ? Math.max(0, time) % (Math.PI * 10) : 0);
    gl.disableVertexAttribArray(this.normal);
    gl.enableVertexAttribArray(this.waterPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.water);
    gl.vertexAttribPointer(this.waterPosition, 3, gl.FLOAT, false, 0, 0);
    // 先画船再叠加半透明水面；水上部件由深度测试保留，水下船体透过水面可见。
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(this.waterPosition);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.buffers) this.gl.deleteBuffer(buffer);
    for (const shader of this.shaders) this.gl.deleteShader(shader);
    for (const program of this.programs) this.gl.deleteProgram(program);
    this.buffers = []; this.shaders = []; this.programs = []; this.meshes = [];
  }
}

module.exports = { BoatRenderer };

},
"utils/boatTrack.js": function(require, module, exports) {
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

},
"utils/compassDisplay.js": function(require, module, exports) {
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

},
"utils/glbModel.js": function(require, module, exports) {
/* 加载随包附带的静态纯色 GLB 2.0。保留节点层级和材质颜色，补算法线；
 * 当前船模无纹理、动画或压缩扩展，不需要额外下载 3D 库或解码器。 */
const { identity, multiply, nodeMatrix, transformPoint } = require('./boatAttitude');

function parseGlb(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = message => { throw new Error(message); };
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546C67 || view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.length) fail('模型文件头无效');
  let document, binary;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail('模型分块不完整');
    const size = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    offset += 8;
    if (size % 4 || offset + size > bytes.length) fail('模型分块长度无效');
    if (type === 0x4E4F534A) {
      if (document) fail('模型包含重复描述');
      // 不依赖小程序运行时是否提供 TextDecoder；兼容 glTF 中的 UTF-8 名称。
      let encoded = '';
      for (const byte of bytes.subarray(offset, offset + size)) encoded += `%${byte.toString(16).padStart(2, '0')}`;
      document = JSON.parse(decodeURIComponent(encoded));
    } else if (type === 0x004E4942) {
      if (binary) fail('模型包含重复二进制数据');
      binary = bytes.subarray(offset, offset + size);
    }
    offset += size;
  }
  if (!document || !document.asset || document.asset.version !== '2.0' || !binary ||
      !document.buffers || document.buffers.length !== 1 || document.buffers[0].uri ||
      document.buffers[0].byteLength > binary.length) fail('模型不是内嵌数据的 GLB 2.0');
  if ((document.extensionsRequired || []).length) fail('模型需要额外扩展解码器');
  if ((document.textures || []).length || (document.skins || []).length || (document.animations || []).length)
    fail('当前展示器使用静态纯色船体模型');
  const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);

  function readAccessor(index, type) {
    const accessor = (document.accessors || [])[index];
    if (!accessor || accessor.type !== type || accessor.sparse || accessor.normalized) fail('模型顶点描述无效');
    const buffer = (document.bufferViews || [])[accessor.bufferView];
    const width = type === 'VEC3' ? 3 : 1;
    const componentBytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
    if (!buffer || buffer.buffer !== 0 || !componentBytes || !Number.isInteger(accessor.count) || accessor.count < 1 ||
        accessor.count > 1000000 || (type === 'VEC3' && accessor.componentType !== 5126) ||
        (type === 'SCALAR' && accessor.componentType === 5126)) fail('模型顶点格式不受支持');
    const stride = buffer.byteStride || componentBytes * width;
    const localOffset = accessor.byteOffset || 0;
    const start = (buffer.byteOffset || 0) + localOffset;
    const end = start + (accessor.count - 1) * stride + componentBytes * width;
    if (stride < componentBytes * width || stride % componentBytes || localOffset < 0 ||
        start < 0 || end > binary.length || end > (buffer.byteOffset || 0) + buffer.byteLength)
      fail('模型顶点超出数据边界');
    const values = type === 'VEC3' ? new Float32Array(accessor.count * width) : new Uint32Array(accessor.count);
    for (let i = 0; i < accessor.count; i += 1) {
      for (let j = 0; j < width; j += 1) {
        const offset = start + i * stride + j * componentBytes;
        const value = accessor.componentType === 5126 ? data.getFloat32(offset, true) :
          componentBytes === 4 ? data.getUint32(offset, true) : componentBytes === 2 ? data.getUint16(offset, true) : data.getUint8(offset);
        if (!Number.isFinite(value)) fail('模型坐标含无效值');
        values[i * width + j] = value;
      }
    }
    return values;
  }

  const primitives = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const ancestors = new Set();
  function visit(index, parent) {
    const node = (document.nodes || [])[index];
    if (!node || ancestors.has(index) || ancestors.size >= 64) fail('模型节点层级无效');
    ancestors.add(index);
    const world = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = (document.meshes || [])[node.mesh];
      if (!mesh) fail('模型网格缺失');
      for (const primitive of mesh.primitives) {
        if ((primitive.mode !== undefined && primitive.mode !== 4) || primitive.targets ||
            primitive.extensions || !primitive.attributes) fail('模型不是静态三角网格');
        const positions = readAccessor(primitive.attributes.POSITION, 'VEC3');
        const count = positions.length / 3;
        if (count > 65536) fail('模型单个网格顶点过多');
        const sourceIndices = primitive.indices === undefined ? Uint32Array.from({ length: count }, (_, i) => i) :
          readAccessor(primitive.indices, 'SCALAR');
        if (sourceIndices.length % 3 || sourceIndices.some(value => value >= count)) fail('模型三角索引无效');
        // 本船模的索引文件为 uint32，但实际均小于 65536；转 uint16 兼容 WebGL 1。
        const indices = new Uint16Array(sourceIndices);
        for (let i = 0; i < count; i += 1) {
          const point = transformPoint(world, positions.subarray(i * 3, i * 3 + 3));
          point.forEach((value, axis) => { positions[i * 3 + axis] = value; min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); });
        }
        const material = (document.materials || [])[primitive.material] || {};
        const pbr = material.pbrMetallicRoughness || {};
        const color = pbr.baseColorFactor || [1, 1, 1, 1];
        if (color.length !== 4 || !color.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) fail('模型颜色无效');
        primitives.push({ positions, indices, color, normals: computeNormals(positions, indices),
          metallic: pbr.metallicFactor === undefined ? 1 : pbr.metallicFactor,
          roughness: pbr.roughnessFactor === undefined ? 1 : pbr.roughnessFactor });
      }
    }
    for (const child of node.children || []) visit(child, world);
    ancestors.delete(index);
  }
  const scene = (document.scenes || [])[document.scene === undefined ? 0 : document.scene];
  if (!scene) fail('模型场景缺失');
  for (const node of scene.nodes || []) visit(node, identity());
  const span = Math.max(...max.map((value, axis) => value - min[axis]));
  if (!primitives.length || !Number.isFinite(span) || span < 1e-8) fail('模型没有可见几何');
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const scale = 2.7 / span;
  for (const primitive of primitives)
    for (let i = 0; i < primitive.positions.length; i += 1)
      primitive.positions[i] = (primitive.positions[i] - center[i % 3]) * scale;
  return { primitives, bounds: { min, max, center, scale } };
}

function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const u = [0, 1, 2].map(axis => positions[b + axis] - positions[a + axis]);
    const v = [0, 1, 2].map(axis => positions[c + axis] - positions[a + axis]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const index of [a, b, c]) normal.forEach((value, axis) => { normals[index + axis] += value; });
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (length < 1e-10) normals[i + 1] = 1;
    else for (let j = 0; j < 3; j += 1) normals[i + j] /= length;
  }
  return normals;
}

module.exports = { parseGlb };

},
"utils/headingParameters.js": function(require, module, exports) {
// 与固件 heading_control.h 对齐。增益用 X100 整数输入，保留0.01的调节分辨率。
// 七项顺序与UART4参数区末尾一致：协议编码、设置表单和范围校验共同引用此表。
// name/range/unit/description/advice同时用于整组说明和每项独立的“说明”弹窗。
const HEADING_PARAMETER_HELP = [
  { key: 'headingKpX100', name: '航向 KP', min: 0, max: 10000,
    range: '0 - 10000，默认 200', unit: 'X100：200 = 2 X2/度 = 1% PWM/度',
    description: '按目标与实测航向的最短角差产生差速。359°到1°按+2°修正，不会绕大圈。P越大，转向越有力。',
    advice: '先用默认200和较小差速上限低速测试，每次增减20～50；来回摆头时降低。速度KP只控制前后推进，与此项独立。' },
  { key: 'headingKiX100', name: '航向 KI', min: 0, max: 10000,
    range: '0 - 10000，默认 0', unit: 'X100：100 = 1 X2/(度·秒)',
    description: '累积持续航向偏差，用于抵消风流或两侧推力不一致。仅新反馈样本积分，混控受限或换向等待时停止同向积累。',
    advice: '先保持0。P稳定后仍有持续偏差，再从5～10小步增加；缓慢来回摆头时降低，并检查积分限幅。' },
  { key: 'headingKdX100', name: '航向 KD', min: 0, max: 10000,
    range: '0 - 10000，默认 0', unit: 'X100：100 = 1 X2/(度/秒)',
    description: '按实际航向角速度产生阻尼，跨0°取短角差；旋转目标旋钮不会直接产生微分冲击。',
    advice: '先保持0；存在可重复过冲且航向稳定时从10小步增加。航向噪声大时D会放大抖动，优先降低。' },
  { key: 'headingIntegralLimitX2', name: '航向积分限幅', min: 0, max: 200,
    range: '0 - 200 X2，默认 30', unit: '2 X2 = 1% PWM；默认15%',
    description: '限制航向I项累积的最大差速贡献。KI为0时此项不会产生额外推力。',
    advice: '先保持30；不要靠很大的积分弥补错误的转向方向。进入误差死区、关闭控制或反馈失效时积分清零。' },
  { key: 'headingOutputLimitX2', name: '自动转向输出上限', min: 1, max: 200,
    range: '1 - 200 X2，默认 60', unit: '每侧差速上限；60 X2 = 30% PWM',
    description: '航向PID最多产生的差速。电机1=共同推进+差速，电机2=共同推进−差速；混合后仍受总输出上限及PWM步长限制。',
    advice: '先在低速确认方向。这个上限太小会转弯慢，太大会急转甚至触发电机换向等待；不受人工“满速差速比例”控制。' },
  { key: 'headingDeadbandCdeg', name: '航向误差死区', min: 0, max: 3000,
    range: '0 - 3000（0～30°），默认 200', unit: '0.01°；200 = 2°',
    description: '绝对航向误差不超过此值时，航向PID输出和积分归零，降低测量噪声引起的左右抖动；实际PWM仍按步长回落。',
    advice: '先试2°；船头抖动可增加到3～5°，确认航向反馈精度后再缩小。设为0可能持续微调。' },
  { key: 'headingReversed', name: '自动转向方向', min: 0, max: 1,
    range: '正常 / 反向，默认正常', unit: '只反转航向PID产生的差速',
    description: '正常时正角差增大电机1、减小电机2；反向时相反。用于适配左右电机布局和上位机航向角增加的方向，不改变人工左右杆。',
    advice: 'CH6低档停稳后才能修改。首次低速测试小角差，若越修正偏差越大，应立即CH6低档停推，再反转本项；不要靠增大P纠正方向。' }
];
// 从单一字段表生成键名和范围，避免新增字段只在界面显示、却未进入读写校验。
const HEADING_PARAMETER_KEYS = HEADING_PARAMETER_HELP.map(item => item.key);
const HEADING_PARAMETER_RANGES = {};
HEADING_PARAMETER_HELP.forEach(item => { HEADING_PARAMETER_RANGES[item.key] = [item.min, item.max]; });
module.exports = { HEADING_PARAMETER_KEYS, HEADING_PARAMETER_HELP, HEADING_PARAMETER_RANGES };

},
"utils/imuDisplay.js": function(require, module, exports) {
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

},
"utils/mapCoordinates.js": function(require, module, exports) {
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

},
"utils/mapVelocity.js": function(require, module, exports) {
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

},
"utils/missionNavigation.js": function(require, module, exports) {
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

},
"utils/parameterExport.js": function(require, module, exports) {
/* 导出当前表单的20项已校验参数，按固件实际默认值定义的位置分组。
 * 保留原始整数单位，方向0/1转换为对应宏，避免手工换算或字段顺序错位。 */
// 每行依次为：小程序字段名、C结构体成员名、导出注释；不按界面排序推断字段。
const BOAT_FIELDS = [
  ['feedforwardX2PerMps', 'feedforward_x2_per_m_s', '船速前馈，X2/(m/s)'],
  ['kpX2PerMps', 'kp_x2_per_m_s', '船速P，X2/(m/s)'],
  ['kiX2PerMpsS', 'ki_x2_per_m_s_s', '船速I，X2/((m/s)·s)'],
  ['kdX2PerMps2', 'kd_x2_per_m_s2', '船速D，X2/(m/s²)'],
  ['integralLimitX2', 'integral_limit_x2', '船速积分限幅，X2'],
  ['correctionLimitX2', 'correction_limit_x2', '船速修正限幅，X2'],
  ['outputLimitX2', 'output_limit_x2', '每侧总输出限幅，X2'],
  ['outputSlewStepX2', 'output_slew_step_x2', 'PWM步长，X2/20 ms']
];
// 航向字段导出为指定成员初始化，即使C结构体成员调整顺序也便于人工核对。
const HEADING_FIELDS = [
  ['headingKpX100', 'kp_x100', '航向P，X100'],
  ['headingKiX100', 'ki_x100', '航向I，X100'],
  ['headingKdX100', 'kd_x100', '航向D，X100'],
  ['headingIntegralLimitX2', 'integral_limit_x2', '航向积分限幅，X2'],
  ['headingOutputLimitX2', 'output_limit_x2', '自动转向上限，X2'],
  ['headingDeadbandCdeg', 'deadband_cdeg', '航向死区，0.01度'],
  ['headingReversed', 'reversed', '自动转向方向，0正常/1反向']
];

// 每行末尾生成C宏续行符，结束花括号不续行；字段注释放在续行符之前。
function initializer(name, entries) {
  const continuation = ' \\';
  return [`#define ${name} {${continuation}`]
    .concat(entries.map(([field, value, note]) =>
      `    .${field} = ${value}, /* ${note} */${continuation}`), ['}']).join('\n');
}

// values由首页共用校验器验证后传入；这里只生成文本，不发送命令或修改参数。
// matchesDevice仅表示与最近一次设备响应一致，不代表已存Flash或刚完成重新读取。
// exportedAt可由检查程序传入固定时间，默认取本次导出的UTC时间。
function formatParameterExport(values, matchesDevice, exportedAt = new Date()) {
  const boat = BOAT_FIELDS.map(([key, field, note]) => [field, `${values[key]}U`, note]);
  // 这两项默认值定义在头文件，初始化表沿用宏名，避免同一参数出现两处数字副本。
  boat.push(['max_target_mm_s', 'BOAT_SPEED_DEFAULT_TARGET_MM_S', '最大目标船速，见头文件']);
  boat.push(['target_slew_step_mm_s', 'BOAT_SPEED_DEFAULT_TARGET_SLEW_STEP_MM_S', '目标步长，见头文件']);
  const heading = HEADING_FIELDS.map(([key, field, note]) => [field, `${values[key]}U`, note]);
  // 手机方向采用0/1协议值；C安装方向宏展开为+1/-1，不能直接把0/1写回方向宏。
  const direction = value => value === 1 ? 'MOTOR_DIRECTION_REVERSE' : 'MOTOR_DIRECTION_FORWARD';
  return [
    '/* 无人船监控平台 · 参数导出（20项，参数协议v5）',
    ` * 导出时间：${exportedAt.toISOString()}（UTC）`,
    ' * 来源：当前表单。',
    matchesDevice
      ? ' * 状态：与最近一次设备响应确认的参数一致；此操作不确认Flash是否已保存。'
      : ' * 状态：包含未写入设备的表单修改（草稿），请确认已完成调试后再用于默认值。',
    ' * 按下列文件路径替换原有同名宏；多行宏需从#define到结束的}完整替换。',
    ' * 单位：2 X2=1% PWM；1000 mm/s=1 m/s；航向增益X100；100 cdeg=1度。',
    ' * 已有合法Flash存档优先于编译默认值；修改代码并烧录后，旧存档仍可能生效。',
    ' * 如需设备采用这组值，请在小程序写入参数，调试确认后显式写入Flash。',
    ' */',
    '',
    '/* 1. Core/Inc/motor_control_config.h：分别替换以下3个宏 */',
    `#define MOTOR1_DIRECTION_SIGN ${direction(values.motor1Reversed)}`,
    `#define MOTOR2_DIRECTION_SIGN ${direction(values.motor2Reversed)}`,
    `#define MOTOR_REMOTE_TURN_AT_FULL_SPEED_PERCENT ${values.turnAtFullSpeedPercent}U`,
    '',
    '/* 2. Core/Inc/boat_speed_control.h：替换最大船速和目标变化步长 */',
    `#define BOAT_SPEED_DEFAULT_TARGET_MM_S ${values.maxTargetMmS}U`,
    `#define BOAT_SPEED_DEFAULT_TARGET_SLEW_STEP_MM_S ${values.targetSlewStepMmS}U`,
    '',
    '/* 3. Core/Src/boat_speed_control.c：完整替换BOAT_SPEED_DEFAULT_PARAMS */',
    initializer('BOAT_SPEED_DEFAULT_PARAMS', boat),
    '',
    '/* 4. Core/Src/heading_control.c：完整替换HEADING_DEFAULTS */',
    initializer('HEADING_DEFAULTS', heading),
    ''
  ].join('\n');
}

module.exports = { formatParameterExport };

},
"utils/uart4Protocol.js": function(require, module, exports) {
/*
 * UART4 状态帧解包器。
 *
 * 固定帧格式来自 STM32 工程的 uart4_telemetry.h：
 *   0..1   A5 5A 帧头
 *   2      version
 *   3      message type（状态帧 = 1）
 *   4      length（固定 64）
 *   5      全局状态位
 *   6..9   发送序号，小端 uint32
 *   10..13 HAL tick，小端 uint32
 *   14..37 电机 1，24 字节
 *   38..61 电机 2，24 字节
 *   62..63 CRC-16/CCITT-FALSE，小端
 *
 * 输入字节可能包含一帧或多帧，因此使用滑动缓冲区依次解析；云端
 * MQTT 遥测每包携带四类帧，复用同一协议校验与字段解码。
 * 参数读写使用同一帧头和 CRC，独立版本 v5 / 56 字节：读取请求 0x10、
 * 临时写入 0x11、保存 Flash 0x12、响应 0x90；20 个 uint16 位于 14..53，CRC 位于 54..55；
 * 参数响应不会参与状态帧序号统计。
 * RTK 使用 0x02 / v2 / 40 字节帧，兼容旧 v1/28 字节速度帧。
 * 原始 IMU 使用 0x04 / v1 / 36 字节，独立携带三轴角速度、欧拉角与源标志。
 */

const { HEADING_PARAMETER_KEYS } = require('./headingParameters');

const UART4 = {
  SYNC0: 0xA5,
  SYNC1: 0x5A,
  VERSION: 1,
  MESSAGE_STATUS: 1,
  MESSAGE_VELOCITY: 0x02,
  MESSAGE_BOAT: 0x03,
  MESSAGE_IMU: 0x04,
  MESSAGE_PARAMETER_READ_REQUEST: 0x10,
  MESSAGE_PARAMETER_WRITE_REQUEST: 0x11,
  MESSAGE_PARAMETER_SAVE_REQUEST: 0x12,
  MESSAGE_PARAMETER_RESPONSE: 0x90,
  FRAME_SIZE: 64,
  BOAT_VERSION: 2,
  BOAT_FRAME_SIZE: 36,
  IMU_VERSION: 1,
  IMU_FRAME_SIZE: 36,
  VELOCITY_FRAME_SIZE: 28,
  RTK_VERSION: 2,
  RTK_FRAME_SIZE: 40,
  PARAMETER_VERSION: 5,
  PARAMETER_FRAME_SIZE: 56,
  PARAMETER_COUNT: 20,
  MOTOR1_OFFSET: 14,
  MOTOR2_OFFSET: 38,
  MOTOR_SIZE: 24,
  UNKNOWN_AGE: 0xFFFF
};

// 计算 CRC-16/CCITT-FALSE；start/length 允许直接校验帧中的业务区间。
function crc16CcittFalse(bytes, start = 0, length = bytes.length - start) {
  if (!bytes || start < 0 || length < 0 || start + length > bytes.length) {
    return 0;
  }

  let crc = 0xFFFF;
  for (let i = start; i < start + length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

// 协议全部采用小端序。带符号 16 位字段需手动执行补码还原。
function readU16LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readI16LE(bytes, offset) {
  const value = readU16LE(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function readU32LE(bytes, offset) {
  // 最高字节使用乘法而不是左移，避免 JavaScript 有符号 32 位移位产生符号扩展。
  return (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] * 0x1000000)) >>> 0;
}

// 写入函数只保留目标位宽，调用方负责在编码前做业务范围校验。
function writeU16LE(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
}

function writeU32LE(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
  bytes[offset + 2] = (value >>> 16) & 0xFF;
  bytes[offset + 3] = (value >>> 24) & 0xFF;
}

// 网络数据与测试可传入不同缓冲区类型；统一为只读字节视图。
function normalizeBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (input && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }
  return new Uint8Array(0);
}

// 将一条固定 24 字节电机记录转换为页面使用的工程单位。
function decodeMotor(bytes, base) {
  const motorFlags = bytes[base];
  const feedbackAgeMs = readU16LE(bytes, base + 20);
  return {
    statusFlags: motorFlags,
    received: (motorFlags & 0x01) !== 0,
    displayValid: (motorFlags & 0x02) !== 0,
    feedbackFresh: (motorFlags & 0x04) !== 0,
    reverse: (motorFlags & 0x08) !== 0,
    temperatureC: bytes[base + 1],
    voltageV: readU16LE(bytes, base + 2) / 100,
    currentA: readU16LE(bytes, base + 4) / 100,
    capacityMah: readU16LE(bytes, base + 6),
    electricalRpm: readU32LE(bytes, base + 8),
    mechanicalRpm: readU32LE(bytes, base + 12),
    targetRpm: readI16LE(bytes, base + 16),
    appliedPwmX2: readI16LE(bytes, base + 18),
    appliedPwmPercent: readI16LE(bytes, base + 18) / 2,
    feedbackAgeMs: feedbackAgeMs === UART4.UNKNOWN_AGE ? null : feedbackAgeMs,
    telemetrySequence: readU16LE(bytes, base + 22)
  };
}

// 解码独立的 64 字节状态帧；帧头、版本、类型、长度和 CRC 必须全部通过。
function decodeFrame(bytes) {
  const data = normalizeBytes(bytes);
  if (data.length !== UART4.FRAME_SIZE) {
    return null;
  }

  // 对外暴露的解码入口也做完整校验，避免调用方误用未验证的字节。
  if (data[0] !== UART4.SYNC0 ||
      data[1] !== UART4.SYNC1 ||
      data[2] !== UART4.VERSION ||
      data[3] !== UART4.MESSAGE_STATUS ||
      data[4] !== UART4.FRAME_SIZE) {
    return null;
  }
  const expectedCrc = readU16LE(data, 62);
  if (expectedCrc !== crc16CcittFalse(data, 2, 60)) {
    return null;
  }

  return {
    version: data[2],
    messageType: data[3],
    length: data[4],
    statusFlags: data[5],
    sbusLinkValid: (data[5] & 0x01) !== 0,
    speedLoop: (data[5] & 0x02) !== 0,
    sbusFrameLost: (data[5] & 0x04) !== 0,
    sbusFailsafe: (data[5] & 0x08) !== 0,
    motor1Received: (data[5] & 0x10) !== 0,
    motor2Received: (data[5] & 0x20) !== 0,
    motor1Fresh: (data[5] & 0x40) !== 0,
    motor2Fresh: (data[5] & 0x80) !== 0,
    sequence: readU32LE(data, 6),
    timestampMs: readU32LE(data, 10),
    motors: [
      decodeMotor(data, UART4.MOTOR1_OFFSET),
      decodeMotor(data, UART4.MOTOR2_OFFSET)
    ]
  };
}

// 按协议字段顺序输出数组，确保写入帧的 20 个 uint16 不会错位。
function normalizeParameterValues(parameters) {
  const values = parameters || {};
  const names = [
    'feedforwardX2PerMps',
    'kpX2PerMps',
    'kiX2PerMpsS',
    'kdX2PerMps2',
    'integralLimitX2',
    'correctionLimitX2',
    'outputLimitX2',
    'outputSlewStepX2',
    'turnAtFullSpeedPercent',
    'motor1Reversed',
    'motor2Reversed',
    'maxTargetMmS',
    'targetSlewStepMmS',
    ...HEADING_PARAMETER_KEYS
  ];
  return names.map((name) => {
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) {
      throw new Error(`参数 ${name} 必须是 0 到 65535 的整数`);
    }
    if ((name === 'motor1Reversed' || name === 'motor2Reversed' || name === 'headingReversed') && value > 1) {
      throw new Error('方向只能为 0（正向）或 1（反向）');
    }
    return value;
  });
}

// 构造参数读取请求。未使用的状态/时间戳/参数字节保持为 0。
function encodeParameterReadRequest(requestSequence = 0) {
  const bytes = new Uint8Array(UART4.PARAMETER_FRAME_SIZE);
  bytes[0] = UART4.SYNC0;
  bytes[1] = UART4.SYNC1;
  bytes[2] = UART4.PARAMETER_VERSION;
  bytes[3] = UART4.MESSAGE_PARAMETER_READ_REQUEST;
  bytes[4] = UART4.PARAMETER_FRAME_SIZE;
  writeU32LE(bytes, 6, requestSequence >>> 0);
  const crcOffset = UART4.PARAMETER_FRAME_SIZE - 2;
  writeU16LE(bytes, crcOffset,
    crc16CcittFalse(bytes, 2, UART4.PARAMETER_FRAME_SIZE - 4));
  return bytes;
}

// 构造参数写入请求；STM32 仍会对每项执行更严格的业务安全范围校验。
function encodeParameterWriteRequest(requestSequence, parameters) {
  const bytes = new Uint8Array(UART4.PARAMETER_FRAME_SIZE);
  const values = normalizeParameterValues(parameters);
  bytes[0] = UART4.SYNC0;
  bytes[1] = UART4.SYNC1;
  bytes[2] = UART4.PARAMETER_VERSION;
  bytes[3] = UART4.MESSAGE_PARAMETER_WRITE_REQUEST;
  bytes[4] = UART4.PARAMETER_FRAME_SIZE;
  writeU32LE(bytes, 6, requestSequence >>> 0);
  values.forEach((value, index) => writeU16LE(bytes, 14 + index * 2, value));
  const crcOffset = UART4.PARAMETER_FRAME_SIZE - 2;
  writeU16LE(bytes, crcOffset,
    crc16CcittFalse(bytes, 2, UART4.PARAMETER_FRAME_SIZE - 4));
  return bytes;
}

// 保存命令只持久化设备当前生效值；附带整组预期值供 STM32 比对，不隐式调参。
function encodeParameterSaveRequest(requestSequence, parameters) {
  const bytes = encodeParameterWriteRequest(requestSequence, parameters);
  bytes[3] = UART4.MESSAGE_PARAMETER_SAVE_REQUEST;
  writeU16LE(bytes, bytes.length - 2, crc16CcittFalse(bytes, 2, bytes.length - 4));
  return bytes;
}

// 参数响应与请求使用相同的 v5 / 56 字节布局，status 位于偏移 5。
function decodeParameterFrame(bytes) {
  const data = normalizeBytes(bytes);
  if (data.length !== UART4.PARAMETER_FRAME_SIZE ||
      data[0] !== UART4.SYNC0 ||
      data[1] !== UART4.SYNC1 ||
      data[2] !== UART4.PARAMETER_VERSION ||
      data[3] !== UART4.MESSAGE_PARAMETER_RESPONSE ||
      data[4] !== UART4.PARAMETER_FRAME_SIZE) {
    return null;
  }
  const crcOffset = UART4.PARAMETER_FRAME_SIZE - 2;
  if (readU16LE(data, crcOffset) !==
      crc16CcittFalse(data, 2, UART4.PARAMETER_FRAME_SIZE - 4)) {
    return null;
  }
  const values = [
    'feedforwardX2PerMps',
    'kpX2PerMps',
    'kiX2PerMpsS',
    'kdX2PerMps2',
    'integralLimitX2',
    'correctionLimitX2',
    'outputLimitX2',
    'outputSlewStepX2',
    'turnAtFullSpeedPercent',
    'motor1Reversed',
    'motor2Reversed',
    'maxTargetMmS',
    'targetSlewStepMmS',
    ...HEADING_PARAMETER_KEYS
  ];
  const parameters = {};
  values.forEach((name, index) => {
    parameters[name] = readU16LE(data, 14 + index * 2);
  });
  return {
    version: data[2],
    messageType: data[3],
    length: data[4],
    status: data[5],
    requestSequence: readU32LE(data, 6),
    timestampMs: readU32LE(data, 10),
    parameters
  };
}

// v2 保留旧速度/年龄偏移，26..37 新增经纬度、航向、有效位；Z 不再使用。
function decodeVelocityFrame(bytes) {
  const data = normalizeBytes(bytes);
  const hasNavigation = data.length === UART4.RTK_FRAME_SIZE && data[2] === UART4.RTK_VERSION;
  const legacy = data.length === UART4.VELOCITY_FRAME_SIZE && data[2] === UART4.VERSION;
  if ((!hasNavigation && !legacy) ||
      data[0] !== UART4.SYNC0 || data[1] !== UART4.SYNC1 ||
      data[3] !== UART4.MESSAGE_VELOCITY || data[4] !== data.length ||
      readU16LE(data, data.length - 2) !== crc16CcittFalse(data, 2, data.length - 4)) {
    return null;
  }
  const age = readU16LE(data, 20);
  const result = {
    version: data[2],
    messageType: data[3],
    sequence: readU32LE(data, 6),
    timestampMs: readU32LE(data, 10),
    velocity: {
      received: !!(data[5] & 0x01),
      fresh: (data[5] & 0x03) === 0x03,
      xMps: readI16LE(data, 14) / 1000,
      yMps: readI16LE(data, 16) / 1000,
      zRadps: readI16LE(data, 18) / 1000,
      ageMs: age === UART4.UNKNOWN_AGE ? null : age,
      receivedMs: readU32LE(data, 22)
    }
  };
  if (hasNavigation) {
    // 位运算显式恢复有符号 int32；uint16 航向才能表示大于 327.67 度的值。
    const latitude = (readU32LE(data, 26) | 0) / 1e7;
    const longitude = (readU32LE(data, 30) | 0) / 1e7;
    const headingDegrees = readU16LE(data, 34) / 100;
    Object.assign(result.velocity, {
      hasNavigation: true, zRadps: null, latitude, longitude, headingDegrees,
      sourceFlags: data[36],
      fixValid: !!(data[36] & 1) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180,
      velocityValid: !!(data[36] & 2),
      headingValid: !!(data[36] & 4) && headingDegrees < 360,
      timeAligned: !!(data[36] & 8)
    });
  }
  return result;
}

// 船体遥测独立于原始RTK帧：船速曲线使用PID实际采用的三点中值合速率。
// v1/28只有船速信息，v2/36追加航向及三模式；必须同时检查版本、类型和长度。
function decodeBoatFrame(bytes) {
  const data = normalizeBytes(bytes);
  const hasHeading = data.length === UART4.BOAT_FRAME_SIZE && data[2] === UART4.BOAT_VERSION;
  const legacy = data.length === 28 && data[2] === UART4.VERSION;
  if ((!hasHeading && !legacy) || data[0] !== UART4.SYNC0 || data[1] !== UART4.SYNC1 ||
      data[3] !== UART4.MESSAGE_BOAT || data[4] !== data.length ||
      readU16LE(data, data.length - 2) !== crc16CcittFalse(data, 2, data.length - 4)) return null;
  // 模式/目标角非法时丢弃整帧；实测航向非法只清有效位，仍可显示模式与其他状态。
  if (hasHeading && (data[32] > 2 || readU16LE(data, 26) >= 36000)) return null;
  return {
    version: data[2], messageType: data[3],
    sequence: readU32LE(data, 6), timestampMs: readU32LE(data, 10),
    boat: {
      speedLoop: hasHeading ? data[32] !== 0 : !!(data[5] & 1), feedbackValid: !!(data[5] & 2),
      controlMode: hasHeading ? data[32] : (data[5] & 1 ? 1 : 0),
      hasHeading,
      headingValid: hasHeading && !!(data[33] & 1) && readU16LE(data, 28) < 36000,
      controlEnabled: hasHeading ? !!(data[33] & 2) : null,
      // cdeg转为度；角差必须按int16还原，才能正确显示向另一方向修正的负角差。
      targetHeading: hasHeading ? readU16LE(data, 26) / 100 : null,
      actualHeading: hasHeading ? readU16LE(data, 28) / 100 : null,
      headingError: hasHeading ? readI16LE(data, 30) / 100 : null,
      sbusValid: !!(data[5] & 4), motorsValid: !!(data[5] & 8),
      reversing: !!(data[5] & 16), received: !!(data[5] & 32),
      targetMps: readI16LE(data, 14) / 1000,
      actualMps: readU16LE(data, 16) / 1000,
      commonPercent: readI16LE(data, 18) / 2,
      ageMs: readU16LE(data, 20) === UART4.UNKNOWN_AGE ? null : readU16LE(data, 20),
      requestedMps: readI16LE(data, 22) / 1000,
      turnPercent: readI16LE(data, 24) / 2
    }
  };
}

// 原始IMU保持自身局部yaw，不与船体帧中的融合罗盘航向混用。
function decodeImuFrame(bytes) {
  const data = normalizeBytes(bytes);
  if (data.length !== UART4.IMU_FRAME_SIZE || data[0] !== UART4.SYNC0 || data[1] !== UART4.SYNC1 ||
      data[2] !== UART4.IMU_VERSION || data[3] !== UART4.MESSAGE_IMU || data[4] !== data.length ||
      readU16LE(data, 34) !== crc16CcittFalse(data, 2, 32)) return null;
  const gyroRadps = [14, 16, 18].map(offset => readI16LE(data, offset) / 1000);
  const eulerDegrees = [20, 22, 24].map(offset => readI16LE(data, offset) / 100);
  const sourceFlags = data[32] & 0x7F;
  const age = readU16LE(data, 26);
  return {
    version: data[2], messageType: data[3], sequence: readU32LE(data, 6), timestampMs: readU32LE(data, 10),
    imu: {
      received: !!(data[5] & 1), fresh: (data[5] & 3) === 3,
      gyroRadps, rollDegrees: eulerDegrees[0], pitchDegrees: eulerDegrees[1], yawDegrees: eulerDegrees[2],
      ageMs: age === UART4.UNKNOWN_AGE ? null : age, receivedMs: readU32LE(data, 28), sourceFlags,
      gyroValid: !!(sourceFlags & 0x20) && gyroRadps.every(value => Math.abs(value) <= 20),
      eulerValid: !!(sourceFlags & 0x40) && Math.abs(eulerDegrees[0]) <= 180 &&
        Math.abs(eulerDegrees[1]) <= 90 && Math.abs(eulerDegrees[2]) <= 180,
      timeAligned: !!(sourceFlags & 8), headingAvailable: !!(sourceFlags & 4),
      headingFresh: (sourceFlags & 0x14) === 0x14
    }
  };
}

/*
 * 遥测字节流解析器。
 * 输入可能拆包、粘包或从半帧开始，因此实例长期保留未消费字节；每次 push
 * 可以返回 0 到多帧。坏头或坏 CRC 只丢一个字节，再从下一字节继续同步。
 */
class UART4StreamParser {
  constructor() {
    this.buffer = [];
    this.resetStats();
  }

  resetStats() {
    // lastSequence 只跟踪周期状态帧，按需参数响应不会造成“序号跳变”。
    this.stats = {
      bytesReceived: 0,
      framesReceived: 0,
      syncHits: 0,
      crcErrors: 0,
      invalidHeaders: 0,
      droppedBytes: 0,
      sequenceGaps: 0,
      lastSequence: null
    };
  }

  reset() {
    // 主动断开或清除页面数据时，同时清理半帧和诊断计数。
    this.buffer = [];
    this.resetStats();
  }

  push(input) {
    const bytes = normalizeBytes(input);
    const frames = [];
    this.stats.bytesReceived += bytes.length;
    // 统计输入流中真实出现过的 A5 5A，避免把“没有帧头”和“帧头存在但 CRC 错误”混为一谈。
    for (let i = 1; i < bytes.length; i += 1) {
      if (bytes[i - 1] === UART4.SYNC0 && bytes[i] === UART4.SYNC1) {
        this.stats.syncHits += 1;
      }
    }
    // 先完整追加本次通知，随后循环提取其中可能包含的多帧数据。
    for (let i = 0; i < bytes.length; i += 1) {
      this.buffer.push(bytes[i]);
    }

    while (this.buffer.length >= 2) {
      let syncIndex = -1;
      for (let i = 0; i < this.buffer.length - 1; i += 1) {
        if (this.buffer[i] === UART4.SYNC0 &&
            this.buffer[i + 1] === UART4.SYNC1) {
          syncIndex = i;
          break;
        }
      }

      if (syncIndex < 0) {
        // 保留末尾 A5，避免帧头被拆在两次输入之间时丢失。
        const keepLast = this.buffer[this.buffer.length - 1] === UART4.SYNC0 ? 1 : 0;
        this.stats.droppedBytes += this.buffer.length - keepLast;
        this.buffer = keepLast ? [UART4.SYNC0] : [];
        break;
      }

      if (syncIndex > 0) {
        this.stats.droppedBytes += syncIndex;
        this.buffer.splice(0, syncIndex);
      }

      if (this.buffer.length < 5) {
        break;
      }

      // 电机、参数、新旧RTK、船体与IMU帧均可混合拆包/粘包接收。
      const frameSize = this.buffer[4];
      if (frameSize !== UART4.FRAME_SIZE &&
          frameSize !== UART4.PARAMETER_FRAME_SIZE && frameSize !== UART4.BOAT_FRAME_SIZE &&
          frameSize !== UART4.IMU_FRAME_SIZE &&
          frameSize !== UART4.VELOCITY_FRAME_SIZE && frameSize !== UART4.RTK_FRAME_SIZE) {
        this.stats.invalidHeaders += 1;
        this.stats.droppedBytes += 1;
        this.buffer.shift();
        continue;
      }

      if (this.buffer.length < frameSize) {
        break;
      }

      const candidate = new Uint8Array(this.buffer.slice(0, frameSize));
      const validHeader =
        (candidate[2] === UART4.IMU_VERSION && frameSize === UART4.IMU_FRAME_SIZE &&
         candidate[3] === UART4.MESSAGE_IMU) ||
        (candidate[2] === UART4.BOAT_VERSION && frameSize === UART4.BOAT_FRAME_SIZE &&
         candidate[3] === UART4.MESSAGE_BOAT) ||
        (candidate[2] === UART4.RTK_VERSION && frameSize === UART4.RTK_FRAME_SIZE &&
         candidate[3] === UART4.MESSAGE_VELOCITY) ||
        (candidate[2] === UART4.PARAMETER_VERSION &&
         frameSize === UART4.PARAMETER_FRAME_SIZE &&
         candidate[3] === UART4.MESSAGE_PARAMETER_RESPONSE) ||
        (candidate[2] === UART4.VERSION &&
        ((frameSize === UART4.FRAME_SIZE && candidate[3] === UART4.MESSAGE_STATUS) ||
         (frameSize === UART4.VELOCITY_FRAME_SIZE &&
          (candidate[3] === UART4.MESSAGE_VELOCITY || candidate[3] === UART4.MESSAGE_BOAT))));
      const crcOffset = frameSize - 2;
      const expectedCrc = readU16LE(candidate, crcOffset);
      const actualCrc = crc16CcittFalse(candidate, 2, frameSize - 4);
      if (!validHeader || expectedCrc !== actualCrc) {
        if (!validHeader) {
          this.stats.invalidHeaders += 1;
        } else {
          this.stats.crcErrors += 1;
        }
        // 只丢一个字节再找帧头，兼容坏帧内部恰好出现 A5 5A 的情况。
        this.stats.droppedBytes += 1;
        this.buffer.shift();
        continue;
      }

      // 到这里头部和 CRC 已验证，具体解码函数再返回结构化对象。
      const frame = candidate[3] === UART4.MESSAGE_IMU ? decodeImuFrame(candidate) : frameSize === UART4.FRAME_SIZE
        ? decodeFrame(candidate)
        : frameSize === UART4.VELOCITY_FRAME_SIZE || frameSize === UART4.RTK_FRAME_SIZE || frameSize === UART4.BOAT_FRAME_SIZE
          ? (candidate[3] === UART4.MESSAGE_BOAT ? decodeBoatFrame(candidate) : decodeVelocityFrame(candidate))
          : decodeParameterFrame(candidate);
      if (frame) {
        if (frame.messageType === UART4.MESSAGE_STATUS) {
          if (this.stats.lastSequence !== null) {
            const expected = (this.stats.lastSequence + 1) >>> 0;
            if (frame.sequence !== expected) {
              this.stats.sequenceGaps += 1;
            }
          }
          this.stats.lastSequence = frame.sequence;
        }
        this.stats.framesReceived += 1;
        frames.push(frame);
      }
      this.buffer.splice(0, frameSize);
    }

    return frames;
  }

  getStats() {
    // bufferedBytes 用于判断字节流是否长期停在半帧或持续收到不完整数据。
    return { ...this.stats, bufferedBytes: this.buffer.length };
  }
}

module.exports = {
  UART4,
  crc16CcittFalse,
  decodeFrame,
  encodeParameterReadRequest,
  encodeParameterWriteRequest,
  encodeParameterSaveRequest,
  decodeParameterFrame,
  decodeVelocityFrame,
  decodeBoatFrame,
  decodeImuFrame,
  UART4StreamParser
};

},
"utils/velocityDisplay.js": function(require, module, exports) {
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

}
};
const cache = Object.create(null);
function normalize(from, request) {
 const parts = request.startsWith('.') ? from.split('/').slice(0, -1).concat(request.split('/')) : request.split('/');
 const result = []; for (const part of parts) { if (!part || part === '.') continue; if (part === '..') result.pop(); else result.push(part); }
 let id = result.join('/'); if (!id.endsWith('.js')) id += '.js'; return id;
}
function load(id) {
 if (cache[id]) return cache[id].exports; if (!modules[id]) throw new Error('找不到模块: ' + id);
 const module = { exports: {} }; cache[id] = module; modules[id](request => load(normalize(id, request)), module, module.exports); return module.exports;
}
root.BoatModules = Object.fromEntries(Object.keys(modules).map(id => [id.split('/').pop().replace('.js', ''), load(id)]));
})(window);
