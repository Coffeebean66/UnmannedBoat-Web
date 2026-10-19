# 无人船监测平台 · Web

网页版 v1.2.1，项目版本 v2.8.1，2026-10-19。

独立网页工程，移植现有微信小程序的监测、调参、地图与三维姿态功能。原生 HTML/CSS/JavaScript + 零依赖 Node.js 静态服务器，不使用 Docker，不需要 npm install。复制整个 UnmannedBoat_Web 文件夹即可独立使用。

## 快速开始：Windows 本机

先安装 Node.js 22/24 LTS（服务器最低支持18）。双击 **start-local.cmd**，然后用 Chrome 或 Edge 打开：

~~~text
http://127.0.0.1:8080
~~~

或者在 PowerShell 执行：

~~~powershell
cd D:\stm32\test\UnmannedBoat_Web
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1
# 自定义端口
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1 -Port 8081
~~~

服务在当前终端运行，按 Ctrl+C 停止。脚本不修改系统执行策略、不安装开机启动项。首次打开为“未连接”，不会用示例数据冒充设备遥测。

点击“选择蓝牙设备”，选择 T10。设备列表由浏览器提供；为兼容不广播服务 UUID 的 T10，会显示附近可选择的蓝牙设备。连接成功后，监控数据自动更新；参数只有在点击“读取参数”后才发送。

## 界面与导航

界面参考用户提供的无人船监控大屏，采用深海蓝背景、青蓝高亮和细发光边框。首次访问默认深色；右上角月亮/太阳按钮可切换浅色与深色，已保存的主题偏好继续生效，曲线背景、网格和线条同步切换。

桌面顶部横排六项航行指标，左侧保留导航与蓝牙连接摘要。中央船位地图是主要视图，右侧展示三维姿态和RTK/IMU切换面板，下方排列速度/航向控制曲线与双电机，通信诊断集中在底部。手机端改为快捷导航，各面板按屏宽排列。

- 电机卡片突出机械转速和 PWM，环形指示按 PWM 绝对值显示 0–100%，电压、电流、温度和功率并列；方向、容量等详细数据继续保留。
- 曲线下方分别展示目标、实际和误差；船速误差为实际减目标，航向误差为目标减实际的最短角差。过期读数显示 `--`。
- 地图首次未定位时显示等待提示；定位后显示船位和分色轨迹，断流后标记变淡、保留历史路径以便查看。
- RTK/IMU面板通过标签切换，完整保留各自速度、经纬度、姿态、有效状态、序号与数据年龄；标签切换不影响遥测接收。
- 点击“设置”进入参数弹窗：速度闭环 10 项、航向控制 7 项、其他参数 3 项。底部固定显示读取、写入与 Flash 按钮，滚动表单时仍可操作。
- 三组预设分别显示空槽/已保存和保存时间；成功、草稿待写入、设备拒绝/超时采用不同提示色，并保留文字说明。

使用本工程原生 HTML/CSS/JS 实现，没有引入 React、Tailwind 或 UI 框架依赖。图标为本地 SVG，不依赖在线字体。地图继续使用 OSM，深色主题适当降低底图亮度，轨迹与速度箭头保留原色；3D 水面保持独立渲染。参考图中的视频、任务、天气等未接入功能不作为模拟业务展示，所有实时数值仍来自已有设备遥测。

## 与服务器的关系

~~~text
上位机 RTK/IMU → STM32 USART3 → UART4 ↔ R10 ↔ T10 ↔ 浏览器所在电脑/手机的蓝牙
                                                        ↑
                                          服务器提供网页、脚本和船模
~~~

**服务器托管网页，蓝牙连接发生在访问网页的电脑/手机上。** 该设备仍需在 T10 蓝牙覆盖范围内。此版本没有向服务器上传遥测、远程透传控制、多用户共享或4G接入；将网页放在云服务器上不会自动把蓝牙变成远程链路。后续4G上云需要增加数据入口、鉴权和 WebSocket/MQTT 等转发通道。

| 环境 | 说明 |
| --- | --- |
| Windows Chrome / Edge | 需要电脑蓝牙和系统权限；已验证页面及模拟外设流程 |
| Android Chrome | 支持情况取决于设备、系统和浏览器蓝牙实现；需真机检查 |
| iOS Safari / iOS 上常见浏览器、Firefox、微信内置浏览器 | 通常不提供所需的 Web Bluetooth；页面可打开但无法直接连接 |
| http://localhost / http://127.0.0.1 | 可作为本机安全来源使用蓝牙 |
| http://服务器IP / 普通局域网 HTTP | 浏览器通常禁止蓝牙；应使用受信任的 HTTPS |

不要直接双击 public/index.html：浏览器会限制本地文件读取和蓝牙。远程服务器需使用HTTPS，仅给HTTP放行端口不能解除浏览器限制。

## 已移植功能

| 功能 | 网页行为 |
| --- | --- |
| 工作台 | 深海蓝监控大屏、六项航行指标、中央地图、右侧姿态与RTK/IMU切换、底部曲线/电机/诊断；保留侧栏/手机导航、浅色切换及主题偏好，支持320px及以上屏宽 |
| 双电机 | 电压、电流、温度、机械/电气转速、PWM、方向、功率、容量、反馈年龄、序号 |
| 船体控制 | PWM/速度/角度模式、目标/实际/请求船速、方向、共同推进、差速、目标/实际航向及角差 |
| RTK | 东西/南北速度、合速度、经纬度、船头航向、定位状态、时间对齐、序号与年龄 |
| IMU | 三轴角速度、Roll/Pitch/Yaw、有效状态、航向新值/保持、序号与年龄 |
| 控制曲线 | 最近12秒船速/航向切换、目标/实际双线、清空；航向跨0°连续展开 |
| 地图轨迹 | WGS84船位、跟随/回到船位、开始/停止/清除；0–3 m/s按每0.5 m/s分六色，速度无效灰色 |
| 闭环速度箭头 | 速度/角度模式显示目标橙色虚线、实际青绿色实线，箭头长度按同一比例表示速率；可一键隐藏/显示并保存偏好 |
| 轨迹容量 | 每秒最多一点、至少移动1米；最多1000点/64段；停追、无效定位或断流会断开线段 |
| 参数设置 | 独立设置弹窗、速度/航向/其他三组共20项参数、固定操作栏、范围校验、说明与调参教程、2.5 m/s建议草稿 |
| 参数交互 | 读取、临时写入、显式写入 Flash；匹配请求序号并检查STM32状态；普通操作3秒超时、Flash 15秒 |
| 本地预设 | 三个固定槽，保存当前表单、一键使用；保存在当前浏览器的当前网站来源下 |
| 导出 | 下载带中文注释的 .txt 或复制到剪贴板，可用于修改固件初始宏 |
| 3D姿态 | 本地GLB船模、动态水面、拖动视角、视角复位、偏航归零/恢复、模型重载 |
| 动画质量 | 动画/水面独立开关、低/中/高画质，限制像素倍率与刷新频率；偏好本地保存 |
| 节能和过期 | 3D离屏或网页后台停止绘制；关闭动画冻结画面，重新打开显示最新姿态；过期数据不显示为零 |

地图使用本地 Leaflet 1.9.4 和在线 OpenStreetMap 图块。只加载当前视野，不做离线批量下载。网络不可用时底图可能空白，经纬度、轨迹几何及其他仪表继续工作。服务规模扩大时应按图块服务条款配置合适的供应商；国内网络可达性需实测。许可证随 public/vendor/leaflet/LICENSE 保存。

OSM采用WGS84，网页轨迹不应用微信地图的GCJ-02偏移。数值经纬度始终是RTK原始坐标，底图精度不代表RTK精度。

### 闭环地图速度与方向

连接设备并切到“速度”或“角度”闭环后，只要定位和相应速度/方向仍有效、新鲜，地图就从船位显示两组箭头。橙色虚线表示目标，青绿色实线表示实际；地图旁的隐藏/显示按钮同时控制两者，偏好保存在当前浏览器的当前网站来源下。PWM开环、断连或定位过期时不显示箭头。

| 箭头 | 速度 | 方向 |
| --- | --- | --- |
| 目标 | 经过目标斜坡后的船速绝对值，不是原始摇杆请求值 | 角度模式沿目标罗盘航向；速度模式沿当前融合船头航向，不可用时回退新鲜RTK船头航向；负目标表示倒车，方向转180° |
| 实际 | 原始RTK东/北速度的 `hypot(东, 北)` | `atan2(东, 北)` 得到对地运动方向，正北0°、顺时针增加 |

实际箭头表示对地运动矢量；船速仪表与PID曲线采用三点中值滤波后的标量船速，数值可能略有不同。侧滑或水流影响下，实际运动方向也可能与船头朝向不同。当前速度模式没有独立地理方向设定，目标箭头以当前船头朝向辅助观察。

两箭头使用同一线性长度比例，通常为28 px/(m/s)。窄屏或速度较大时共同缩小比例，因此相同速率仍等长，长度比仍表示速度比。这是屏幕上的速度示意，不表示船将移动多少米；地图缩放不会改变箭头所代表的物理含义。地图平移、缩放时箭头继续锚定船位，拖动/点击可穿透箭头操作地图。

零速仅显示原点，不人为指定方向。某组速度或必要方向无效、缺失、过期时，隐藏相应箭头；即使没有可用航向，明确有效的零速仍可显示原点。闭环状态、定位或连接失效时，移除两组箭头。

## 参数操作

1. 连接 T10，点击“设置 → 读取参数”。
2. 修改后点击“写入参数”；收到设备成功响应才算生效。
3. “保存当前”保存表单到浏览器预设，包括未写入的草稿；“一键使用”发送预设并等待STM32确认。
4. 调好以后，将 CH6 切到低档，等待两路停稳且反馈正常满1秒，再点击“写入 Flash”。设备联锁由STM32执行。
5. 表单有尚未生效的修改时，网页会阻止直接写入 Flash。方向修改同样需要设备满足停机条件。
6. 导出文件标明“与最近一次设备响应一致”或“未写入草稿”；导出不证明Flash已经保存。

浏览器与微信小程序预设互相独立。localhost、127.0.0.1、不同端口或域名各有自己的存储；清除网站数据会删除该来源下的预设。轨迹仅保留在本次页面会话中。

## 一键部署 / 删除：Windows

双击 **deploy.cmd**，默认复制到本工程下的 deployments\UnmannedBoat_Web，然后在当前窗口启动服务：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
# 指定部署目录，只复制不启动
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1 -TargetPath D:\services\UnmannedBoat_Web -NoStart
# 指定端口并运行
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1 -TargetPath D:\services\UnmannedBoat_Web -Port 8081
~~~

默认仅监听127.0.0.1。Windows部署用于当前终端会话；长期Windows服务器运行可把 public/ 交由IIS等HTTPS静态站点托管。需要监听所有网卡时指定 -ListenAddress 0.0.0.0，远程蓝牙仍需HTTPS。

先在服务窗口按 Ctrl+C 停止，再双击 **remove.cmd**（删除默认部署），或者：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\remove.ps1 -TargetPath D:\services\UnmannedBoat_Web
# 确定不需要恢复副本时才永久删除：
powershell -NoProfile -ExecutionPolicy Bypass -File .\remove.ps1 -TargetPath D:\services\UnmannedBoat_Web -Purge
~~~

删除只接受部署脚本生成的、路径匹配的专用标记目录；拒绝源码目录、祖先目录、系统/磁盘根目录和符号链接。默认将部署目录改名为“原目录.removed-时间戳”，改回原名即可恢复；-Purge 才是永久删除。不会删除小程序、STM32源码、Node.js或浏览器预设。Windows删除/升级会查询部署的Node进程，若仍运行则要求先停止，不结束无关进程。

## 一键部署 / 卸载：Linux

适用：使用 **systemd** 的 Linux（如 Ubuntu/Debian），有sudo权限，已安装系统级 Node.js 18+（建议22/24 LTS）。无需npm依赖，不使用Docker。不要使用仅root可访问的 /root/.nvm Node路径，服务使用动态非特权用户运行。

将本文件夹传到服务器源码目录，例如 ~/UnmannedBoat_Web：

~~~bash
cd ~/UnmannedBoat_Web
sudo bash deploy.sh
# 自定义端口；可选绑定127.0.0.1或0.0.0.0
sudo bash deploy.sh 8081 127.0.0.1
~~~

复制到 /opt/unmanned-boat-web，创建 unmanned-boat-web.service，启用开机启动、失败重启，并检查 /healthz。脚本不自动装Node或改防火墙、域名、证书。已有同名目录或服务必须带本项目标记，否则拒绝覆盖。

~~~bash
systemctl status unmanned-boat-web
journalctl -u unmanned-boat-web -n 50
curl http://127.0.0.1:8080/healthz
~~~

更新时从新的源码目录重新运行部署脚本。卸载：

~~~bash
sudo bash remove.sh
# 永久删除专用部署目录：
sudo bash remove.sh --purge
~~~

默认停止/禁用服务、删除本项目systemd单元，将部署目录移到带时间戳的恢复目录。保留源码、Node、Nginx和其他站点；自行添加的HTTPS代理配置也需自行移除。--purge 才永久删除部署目录。

Linux脚本已进行Bash语法检查，本次环境为Windows，尚未在真实Linux/systemd服务器上执行。

## HTTPS 部署

推荐绑定127.0.0.1:8080，通过已有Nginx/Caddy反向代理到受信任HTTPS域名。以下Nginx示例需替换域名、证书路径；代码不包含凭据或自动申请证书。

~~~nginx
server {
    listen 443 ssl;
    server_name boat.example.com;
    ssl_certificate     /etc/letsencrypt/live/boat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/boat.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
~~~

网页按域名根路径部署。服务器只提供静态文件，没有设备上传或可远程调用的调参API。若加Basic Auth等访问控制，应覆盖所有静态资源路径。

也可用Node自身TLS（证书须被客户端信任）：

~~~powershell
$env:TLS_KEY = 'D:\certs\privkey.pem'
$env:TLS_CERT = 'D:\certs\fullchain.pem'
$env:HOST = '0.0.0.0'
$env:PORT = '8443'
node server.js
~~~

只需静态部署时，把 public/ 上传到HTTPS静态站点根目录即可，不必运行Node。GLB模型按二进制提供，JS/CSS的MIME类型需正确。Node服务器仅允许GET/HEAD，未知资源返回404，阻止目录穿越和跨根目录符号链接。

## 代码与验证

~~~text
UnmannedBoat_Web/
├── server.js                  静态服务、TLS、健康检查
├── public/
│   ├── index.html             监控页和设置弹窗
│   ├── app.js                 遥测、曲线、地图、轨迹
│   ├── ui.js                  SVG图标、主题偏好、时钟、遥测标签和导航
│   ├── map-velocity-view.js   地图速度箭头SVG与船位跟随
│   ├── styles.css / ui.css    通用主题、组件和参数弹窗
│   ├── dashboard.css          地图主屏布局、深蓝装饰与响应式适配
│   ├── transport.js           蓝牙、分片写入、参数事务
│   ├── parameter-panel.js     参数、预设、导出
│   ├── attitude-view.js       3D姿态、画质、动画调度
│   ├── parameter-data.js      20项参数及说明快照
│   ├── utils/                 小程序工具快照、WGS84轨迹及地图速度矢量计算
│   ├── utils-bundle.js        浏览器工具包
│   ├── assets/boat_mobile.glb 船体模型
│   └── vendor/leaflet/        地图库和许可证
├── build-bundle.js            工具包生成/可选同步小程序
├── start-local.cmd/.ps1       前台本机启动
├── deploy.cmd/.ps1/.sh        Windows复制 / Linux systemd部署
├── remove.cmd/.ps1/.sh        带目录校验的移除/卸载
└── tests/                    协议、服务器和Chrome模拟蓝牙检查
~~~

启动无需构建，工具包已生成。修改 public/utils/ 后执行 npm run build。如需重新同步旁边的小程序，执行 node build-bundle.js --sync：覆盖网页工具、模型、参数说明快照，再添加WGS84投影适配，不修改小程序。

~~~bash
npm test
npm run test:browser
~~~

浏览器检查要求Node 22+及Chrome。Windows默认Chrome路径为 C:\Program Files\Google\Chrome\Application\chrome.exe，其他路径通过 CHROME_PATH 指定。测试启动临时本机服务和无界面Chrome，完成后关闭；模拟外设不连接电机。截图、临时配置及测试部署保存在已忽略的 .test-output/。

2026-10-19验证：

- v1.2.1的16项自动检查及网页脚本语法检查通过。Chrome模拟蓝牙验证1440/1920px地图主布局、页面ID唯一、RTK/IMU点击与方向键/Home/End切换、默认深色/浅色切换及偏好恢复；320/375/640/768/1024/1440/1920px无横向溢出，原蓝牙、参数、Flash拒绝/超时、三组预设、轨迹、速度箭头和动画检查保留并通过。375/320px滚入三维区域后可恢复船模与水面，暂停动画保持暂停；离屏停止绘制不影响实际浏览。零速断言等待实际渲染到0，避免固定等待时间读到旧状态；未新增真实T10、手机浏览器或船上验证。
- v1.2.0的16项核心检查及新增脚本语法检查通过，含东/北方向、目标斜坡与倒车、零速、独立有效位、缺失/过期数据与坐标边界。Chrome模拟蓝牙验证箭头长度比、方向、重合辨识、实际SVG尺寸与船位原点、平移/缩放锚定、隐藏按钮和刷新偏好恢复；地图特写确认两支箭头可见，1440/1024/768/640/375/320px页面及设置内容无横向溢出。
- 6项核心检查通过：CRC、拆包/粘包/坏帧恢复、源超时、WGS84轨迹/断段、航向跨0°、参数分片/响应/超时/并发、HTTP资源与路径边界。
- v1.1.0 Chrome验证通过：本地GLB与WebGL、水面、模拟蓝牙遥测、读写/Flash拒绝与超时、三组参数共20项、预设使用及刷新恢复、主题切换及刷新恢复、Canvas配色、地图等待状态、断流占位、重连单次订阅、动画冻结。
- v1.1.0 的1440/1024/768/640/375/320px页面及设置内容无横向溢出，检查了浅色、深色、实时和空数据截图；网页脚本语法检查通过。
- v1.0.0 部署脚本的PowerShell和Bash语法检查通过，本轮未修改部署脚本。
- Windows部署目录首页、模型资源和默认可恢复删除流程实测通过，测试服务均已退出。
- 尚未进行真实T10蓝牙联调或Linux/systemd实机部署。

## 修改记录

| 日期 | 网页版本 | 功能 |
| --- | --- | --- |
| 2026-10-19 20:20:26 +08:00 | v1.2.1 | 参考深蓝监控大屏重排UI：六项航行指标、中央地图、右侧姿态与RTK/IMU切换、下方控制曲线/双电机、底部通信诊断；默认深色并保留浅色切换及已有主题偏好，保留全部遥测与调参操作 |
| 2026-10-19 19:46:25 +08:00 | v1.2.0 | 闭环地图叠加目标/实际速度方向箭头、共同比例长度、自适应缩放、隐藏/显示按钮与偏好保存；区分船头目标方向与RTK对地实际运动方向，失效时隐藏 |
| 2026-10-19 19:21:15 +08:00 | v1.1.0 | 重做工作台UI、侧栏/手机导航、浅深主题、本地SVG、电机PWM环形显示、曲线摘要、地图空状态、分组参数及预设卡片；浏览器验证六档宽度与现有蓝牙操作 |
| 2026-10-19 | v1.0.0 | 独立网页版、响应式UI、Web Bluetooth、20项调参/Flash/三组预设/导出、速度分色轨迹、3D姿态水面与画质控制、无Docker部署/卸载脚本与验证 |
