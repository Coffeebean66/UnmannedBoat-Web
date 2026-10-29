/* 将纯工具包装为浏览器包，并从锁定的 npm 依赖复制本地播放器及许可证。 */
const fs = require('fs');
const path = require('path');
// 播放器与站点同源发布；部署先 npm ci，再 build，不依赖外部脚本 CDN。
const playerAssets = [
  { packageName: 'hls.js', directory: 'hls', files: ['dist/hls.min.js', 'LICENSE'] },
  { packageName: 'mpegts.js', directory: 'mpegts', files: ['dist/mpegts.js', 'dist/mpegts.js.LICENSE.txt', 'LICENSE'] }
];
for (const player of playerAssets) {
  const packageDirectory = path.join(__dirname, 'node_modules', player.packageName);
  const destination = path.join(__dirname, 'public', 'vendor', player.directory);
  for (const file of player.files) {
    if (!fs.existsSync(path.join(packageDirectory, file))) {
      throw new Error(`缺少 ${player.packageName}/${file}，请先运行 npm ci --omit=dev`);
    }
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const file of player.files) {
    fs.copyFileSync(path.join(packageDirectory, file), path.join(destination, path.basename(file)));
  }
}
// 可选同步将小程序纯工具和参数说明复制为快照；部署不依赖相邻工程。
if (process.argv.includes('--sync')) {
  const vm = require('vm');
  const monitor = path.join(__dirname, '..', 'UnmannedBoat_Monitor');
  const utils = path.join(__dirname, 'public', 'utils');
  fs.mkdirSync(utils, { recursive: true });
  for (const file of fs.readdirSync(path.join(monitor, 'utils'))) {
    if (file.endsWith('.js')) fs.copyFileSync(path.join(monitor, 'utils', file), path.join(utils, file));
  }
  fs.copyFileSync(path.join(monitor, 'assets/models/boat_mobile.glb'), path.join(__dirname, 'public/assets/boat_mobile.glb'));
  const index = fs.readFileSync(path.join(monitor, 'pages/index/index.js'), 'utf8');
  const context = { ...require(path.join(utils, 'headingParameters.js')) };
  vm.createContext(context);
  const start = index.indexOf('const PARAMETER_RANGES =');
  const end = index.indexOf('// 参数预设只保存在');
  if (start < 0 || end < start) throw new Error('参数源格式已变化，请人工核对同步范围');
  vm.runInContext(index.slice(start, end) + '\nthis.config = { ranges: PARAMETER_RANGES, labels: PARAMETER_LABELS, tuning: BOAT_2500_TUNING, help: PARAMETER_HELP_ITEMS, steps: PARAMETER_TUNING_STEPS };', context);
  fs.writeFileSync(path.join(__dirname, 'public/parameter-data.js'),
    '// 来自小程序的参数和说明快照，由 build-bundle.js --sync 生成。\nwindow.BoatParameters = ' + JSON.stringify(context.config, null, 2) + ';\n');
}
// 网页轨迹允许传入地图投影；OSM 使用原始 WGS84，小程序继续使用 GCJ-02。
const trackPath = path.join(__dirname, 'public/utils/boatTrack.js');
let trackSource = fs.readFileSync(trackPath, 'utf8');
if (!trackSource.includes('this.project')) {
  trackSource = trackSource.replace('constructor() {', 'constructor(project = wgs84ToGcj02) {\n    this.project = project;')
    .replace('raw && wgs84ToGcj02(raw.latitude, raw.longitude)', 'raw && this.project(raw.latitude, raw.longitude)');
  if (!trackSource.includes('this.project(raw.latitude')) throw new Error('轨迹模块格式发生变化，请人工核对投影适配');
  fs.writeFileSync(trackPath, trackSource);
}
const source = path.join(__dirname, 'public', 'utils');
const files = fs.readdirSync(source).filter(name => name.endsWith('.js')).sort();
const modules = files.map(name => `${JSON.stringify('utils/' + name)}: function(require, module, exports) {\n${fs.readFileSync(path.join(source, name), 'utf8')}\n}`).join(',\n');
const bundle = `(function(root) {\n'use strict';\nconst modules = {\n${modules}\n};\nconst cache = Object.create(null);\nfunction normalize(from, request) {\n const parts = request.startsWith('.') ? from.split('/').slice(0, -1).concat(request.split('/')) : request.split('/');\n const result = []; for (const part of parts) { if (!part || part === '.') continue; if (part === '..') result.pop(); else result.push(part); }\n let id = result.join('/'); if (!id.endsWith('.js')) id += '.js'; return id;\n}\nfunction load(id) {\n if (cache[id]) return cache[id].exports; if (!modules[id]) throw new Error('找不到模块: ' + id);\n const module = { exports: {} }; cache[id] = module; modules[id](request => load(normalize(id, request)), module, module.exports); return module.exports;\n}\nroot.BoatModules = Object.fromEntries(Object.keys(modules).map(id => [id.split('/').pop().replace('.js', ''), load(id)]));\n})(window);\n`;
fs.writeFileSync(path.join(__dirname, 'public', 'utils-bundle.js'), bundle, 'utf8');
console.log(`已生成 ${files.length} 个浏览器模块`);
console.log('已复制 HLS / HTTP-FLV 播放器与许可证至 public/vendor');
