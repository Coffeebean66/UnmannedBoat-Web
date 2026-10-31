const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseGlb } = require('../public/utils/glbModel');
const { identity, multiply, nodeMatrix, transformPoint, quaternionMatrix, renderQuaternion } = require('../public/utils/boatAttitude');

const file = fs.readFileSync(path.join(__dirname, '../public/assets/boat_jnu_motors_v6.glb'));
const jsonLength = file.readUInt32LE(12);
const document = JSON.parse(file.subarray(20, 20 + jsonLength));
const near = (value, expected, tolerance = 1e-5) => assert.ok(Math.abs(value - expected) < tolerance, `${value} ≈ ${expected}`);
const model = parseGlb(file);

test('JNU 船模保留完整装配，尺寸为米且适配 WebGL 1', () => {
  assert.equal(document.asset.extras.linkCount, 16);
  assert.equal(document.nodes.filter(node => node.mesh !== undefined).length, 26);
  assert.equal(document.meshes.length, 22);
  assert.equal(model.primitives.length, 26);
  near(model.bounds.max[0] - model.bounds.min[0], 2.8);
  near(model.bounds.max[2] - model.bounds.min[2], 1.4556);
  near(model.bounds.max[1], 0.571);
  for (const mesh of model.primitives) {
    assert.ok(mesh.positions.length / 3 <= 65536);
    assert.ok(mesh.indices instanceof Uint16Array);
    assert.ok(mesh.positions.every(Number.isFinite) && mesh.normals.every(Number.isFinite));
    assert.ok(mesh.indices.every(index => index < mesh.positions.length / 3));
  }
  // 限制实际实例渲染成本，避免后续误打包原始百万面 STL。
  assert.ok(model.primitives.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0) < 200000);
  assert.ok(file.length < 4 * 1024 * 1024);
});

test('双推进器位于船尾水下，复用同一几何且中心间距 484 mm', () => {
  const nodes = new Map();
  function visit(index, parent) {
    const node = document.nodes[index];
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.name.endsWith('_link')) nodes.set(node.name, { node, matrix });
    for (const child of node.children || []) visit(child, matrix);
  }
  visit(0, identity());
  const left = nodes.get('motor_left_link'), right = nodes.get('motor_right_link');
  const lp = transformPoint(left.matrix, [0, 0, 0]), rp = transformPoint(right.matrix, [0, 0, 0]);
  for (const point of [lp, rp]) { near(point[0], -1.13975); near(point[1], -0.2667); }
  near(lp[2], -0.242); near(rp[2], 0.242);
  near(Math.hypot(...lp.map((value, axis) => value - rp[axis])), 0.484);
  assert.equal(document.nodes[left.node.children[0]].mesh, document.nodes[right.node.children[0]].mesh);
});

test('保留深蓝船身、双侧校标和设备部件', () => {
  const names = new Set(document.meshes.map(mesh => mesh.name));
  for (const name of ['jnu_port_backing', 'jnu_port_ink', 'jnu_starboard_backing', 'jnu_starboard_ink',
    'rtk_left', 'rtk_right', 'lidar', 'imu', 'battery_case', 'stern_mount', 'stern_thruster']) assert.ok(names.has(name), name);
  const material = document.materials.find(item => item.name === 'boat_red');
  const rgb = material.pbrMetallicRoughness.baseColorFactor.slice(0, 3).map(value =>
    Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055)));
  assert.deepEqual(rgb, [0x29, 0x46, 0x5b]);
});

function replaceMetadata(change) {
  const copy = structuredClone(document); change(copy);
  let json = Buffer.from(JSON.stringify(copy));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const binary = file.subarray(20 + jsonLength), header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json, binary]);
}

test('水线与船模统一归一化，无元数据时兼容旧模型，拒绝异常高度', () => {
  near(model.waterLevel / model.bounds.scale + model.bounds.center[1], 0.05);
  assert.equal(parseGlb(replaceMetadata(copy => delete copy.asset.extras)).waterLevel, -0.16);
  assert.equal(parseGlb(replaceMetadata(copy => { copy.asset.extras = null; })).waterLevel, -0.16);
  for (const value of [10, -10, '0.05', null])
    assert.throws(() => parseGlb(replaceMetadata(copy => { copy.asset.extras.waterlineY = value; })), /水线/);
});

test('新模型与 IMU 共用船体坐标，偏航、俯仰和横滚方向一致', () => {
  const axes = document.nodes[0].matrix;
  assert.deepEqual(transformPoint(axes, [0, 0, 1]), [0, 1, 0]);
  const rotate = (pose, point) => transformPoint(quaternionMatrix(renderQuaternion(pose)), transformPoint(axes, point));
  const yaw = rotate({ roll: 0, pitch: 0, yaw: 90 }, [1, 0, 0]);
  near(yaw[0], 0); near(yaw[2], -1);
  const pitch = rotate({ roll: 0, pitch: 30, yaw: 0 }, [1, 0, 0]);
  near(pitch[1], -0.5);
  const roll = rotate({ roll: 30, pitch: 0, yaw: 0 }, [0, 1, 0]);
  near(roll[1], 0.5);
});
