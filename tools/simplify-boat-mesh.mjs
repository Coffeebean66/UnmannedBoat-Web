// 仅在离线生成船模时使用；浏览器和服务器运行时不依赖 meshoptimizer。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [modulePath, directory, target, maxError] = process.argv.slice(2);
const { MeshoptSimplifier } = await import(pathToFileURL(modulePath).href);
await MeshoptSimplifier.ready;
const read = (name, Type) => {
  const bytes = fs.readFileSync(`${directory}/${name}`);
  return new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const positions = read('positions.bin', Float32Array);
const indices = read('indices.bin', Uint32Array);
// 在拓扑约束和指定误差内化简曲面/轮廓，误差单位为源 STL 的毫米。
const [result, error] = MeshoptSimplifier.simplify(
  indices, positions, 3, Number(target) * 3, Number(maxError), ['ErrorAbsolute']
);
fs.writeFileSync(`${directory}/simplified.bin`, new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
process.stdout.write(JSON.stringify({ errorMm: error, triangles: result.length / 3 }));
