# 网页船模与缩略图

Web 使用 `boat_ros1_jnu_motors_v6` 的暨南大学双推进器船模。三维姿态、单船概览和驾驶页的三维预览复用同一 GLB；设备卡片使用该模型实际渲染的透明 PNG。

## 已包含的资源

- `public/assets/boat_jnu_motors_v6.glb`：约 3 MB，22 个独立网格、26 个装配实例，实际绘制约 18.7 万个三角形。保留深蓝船身、两侧校标、双 RTK、雷达、IMU、设备支架、电池和双推进器。
- `public/assets/boat-jnu-preview.png`：640 × 280 透明缩略图。
- `tools/convert-ros-boat.py`、`tools/simplify-boat-mesh.mjs`：离线转换工具。
- `tools/render-boat-preview.cjs`：通过实际 WebGL 渲染器生成缩略图。

普通部署直接使用已转换的文件，执行 `npm ci --omit=dev` 和 `npm run build` 即可，服务器不需要 ROS、Python、减面工具或 Chrome。

## 重新生成

在网页工程目录运行。需要 Python 3、NumPy、Node.js 和转换后的原始 ROS 包；只生成缩略图时还需要本机 Chrome。

```powershell
python -m pip install numpy
npm.cmd install --prefix .test-output/model-tools --no-audit --no-fund --ignore-scripts --save-exact meshoptimizer@1.3.0
python tools/convert-ros-boat.py --urdf ../boat_ros1_jnu_motors_v6/boat_description/urdf/boat.urdf
npm.cmd run build
node tools/render-boat-preview.cjs
```

Linux 使用 `python3`、`npm` 替换以上命令。原始 ROS 包不属于 Web 运行依赖，需要自行放到相邻目录，或通过 `--urdf` 指定位置。转换器依据 URDF 的材质、visual、固定关节和 mesh scale 装配，读取同目录中与 DAE 同名的二进制 STL；不会导入碰撞体、惯性框或 Gazebo 插件。

减面依赖安装在被 Git 忽略的 `.test-output/model-tools`，不会加入服务器运行依赖。其他位置可使用 `--meshoptimizer /path/to/meshoptimizer/index.js`。转换器会打印各部件的源/目标面数与减面误差，并将报告写入 GLB 元数据。

默认 Chrome 路径为 Windows 常用安装位置；不同路径可设置 `CHROME_PATH`。例如 Linux：

```bash
CHROME_PATH=/usr/bin/google-chrome node tools/render-boat-preview.cjs
```

可用 `node tools/render-boat-preview.cjs 125 20 .test-output/boat-preview.png` 指定相机方位角、俯角和输出位置。脚本仅临时监听本机随机端口，结束后退出服务及 Chrome。

## 坐标与显示

URDF 使用米，STL 使用毫米；严格按 `scale="0.001 0.001 0.001"` 缩放。船体坐标为 X 向船头、Y 向左舷、Z 向上；GLB 根节点一次性变换为 `(X,Z,-Y)`，与现有 IMU 姿态换基一致。船长 2.8 m，含校标最大宽约 1.4556 m；推进器按原装配位置安装，中心间距 0.484 m。

在指定误差内减面，校标为 0.04 mm、船体大网格为 0.35 mm、设备及推进器为 0.15 mm；这些是减面算法的误差阈值，不是实际加工或测量精度。几何保留硬边与曲面平滑；单个 primitive 不超过 65536 个顶点，使用 uint16 索引适配 WebGL 1，无需压缩解码器或额外 3D 库。

`asset.extras.waterlineY` 为 glTF 世界坐标中的显示水面高度，本模型设为 0.05 m。加载器随包围盒归一化水线，水面保持水平、船体跟随 IMU 旋转。该数值仅用于视觉吃水效果，不代表实测吃水或浮力仿真。无水线元数据的旧模型沿用原默认位置。

`node build-bundle.js --sync` 仅同步共享工具及参数快照；网页专属模型、缩略图、`glbModel.js` 与 `boatRenderer.js` 独立维护，避免再次被小程序旧模型覆盖。

```bash
node --test tests/boat-model.test.cjs tests/core.test.cjs
npm run test:browser
```
