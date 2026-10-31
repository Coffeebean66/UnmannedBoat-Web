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
  // 模型的显示水线以 glTF 世界坐标米为单位，随几何一起归一化。
  // 新船模包含水下推进器，不能再用旧船模中心下方的固定偏移。
  const waterline = document.asset.extras?.waterlineY;
  if (waterline !== undefined && (!Number.isFinite(waterline) || waterline < min[1] || waterline > max[1]))
    fail('模型水线高度无效');
  const waterLevel = waterline === undefined ? -0.16 : (waterline - center[1]) * scale;
  for (const primitive of primitives)
    for (let i = 0; i < primitive.positions.length; i += 1)
      primitive.positions[i] = (primitive.positions[i] - center[i % 3]) * scale;
  return { primitives, bounds: { min, max, center, scale }, waterLevel };
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
