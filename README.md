# 无人船监测平台 · Web

网页版源码 `v1.7.0`，项目版本 `v2.17.0`；线上仍为 `v1.6.0`，尚未部署本版。

本版将 IMU 面板改为左侧 Roll / Pitch / Yaw 读数、右侧圆形人工地平仪，带横滚和俯仰刻度，直接跟随有效 IMU 欧拉角。云端调参自 `v1.6.0` 起支持经 HTTPS → MQTT → STM32 读取/修改全部20项参数及显式保存 Flash，需项目 `v2.15.0` 或更新固件报告参数能力。管理员可调参、访客只监测。UART4 数传仍默认关闭，云端调参独立运行；需要蓝牙时先启用 `BOAT_RECEIVER_LINK_ENABLED` 并重新编译烧录。固件生成说明见[主项目固件说明](https://github.com/Coffeebean66/UnmannedBoat/blob/main/UnmannedBoat_Controller/README.md#cubemx-重新生成代码)。

独立网页工程，移植现有微信小程序的监测、调参、地图与三维姿态功能，支持“本地蓝牙”和“云端 MQTT”两个数据来源。前端使用原生 HTML/CSS/JavaScript；Node.js 提供页面、账户会话、MQTT 桥接和 SSE 实时推送，不使用 Docker。云端运行依赖 npm `mqtt`，版本由 `package-lock.json` 锁定；复制完整文件夹后执行 `npm ci --omit=dev` 即可安装。仅使用本地蓝牙时，不启用云服务就不会加载 MQTT 模块，仍需 Node 返回账户配置。

独立仓库：[Coffeebean66/UnmannedBoat-Web](https://github.com/Coffeebean66/UnmannedBoat-Web)。克隆后仓库根目录就是网页工程，完整包含前端、服务端、模型、测试及部署/删除脚本。主项目位于 [Coffeebean66/UnmannedBoat](https://github.com/Coffeebean66/UnmannedBoat)，两个仓库需要分别提交同步。

~~~bash
git clone https://github.com/Coffeebean66/UnmannedBoat-Web.git
cd UnmannedBoat-Web
npm ci --omit=dev
~~~

已部署 `v1.6.0`：[https://boat.coffeebean66.tech](https://boat.coffeebean66.tech)，已启用管理员/访客和参数主题 ACL。Ubuntu 服务器 `47.251.109.111` 上，Nginx HTTPS 代理 Node `7890`，Node 当前监听 `0.0.0.0`；独立 MQTT Broker 监听 TCP `1883`。服务器部署与 GitHub 源码同步分别记录。

2026-10-20 晚间复查，公网 TCP 1883 已可连接；服务器到 Broker 及网页 SSE 通道连续观察 55 秒稳定。当时船端已关闭，没有验证正在运行的 STM32 链路。新 Release 固件仍需用户烧录和实机测试。

2026-10-20 源码同步时的已知问题：网页约 1 秒无新鲜遥测即显示断开，服务端在线窗口为 3 秒，短暂网络延迟可能造成状态切换；当时固件 MQTT 入站回调注册顺序存在被连接初始化清空的缺陷。后续项目 `v2.16.0` 的 FreeRTOS 固件已修复回调顺序并用队列执行参数命令，但尚未烧录实机；网页 `v1.7.0` 本次只增加 IMU 仪表，历史虚拟设备测试不代表真实固件调参已验证。

## 快速开始：Windows 本机

先安装 Node.js 22/24 LTS（服务器最低支持18）。双击 **start-local.cmd**，然后用 Chrome 或 Edge 打开：

~~~text
http://127.0.0.1:8080
~~~

或者在 PowerShell 执行：

~~~powershell
cd UnmannedBoat-Web
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1
# 自定义端口
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1 -Port 8081
~~~

服务在当前终端运行，按 Ctrl+C 停止。脚本不修改系统执行策略、不安装开机启动项。首次打开为“未连接”，不会用示例数据冒充设备遥测。

点击“选择蓝牙设备”，选择 T10。设备列表由浏览器提供；为兼容不广播服务 UUID 的 T10，会显示附近可选择的蓝牙设备。连接成功后，监控数据自动更新；参数只有在点击“读取参数”后才发送。

### 使用已部署的云端监测

1. 将更新过连接配置的 Release 固件烧录到 STM32，CN14 网线接到可访问互联网、提供 DHCP 的路由器 LAN 口。
2. 打开上述 HTTPS 网站，将顶部“数据来源”从“本地蓝牙”切为“云端 MQTT”。
3. 点击“账户登录”，使用管理员或访客用户名和密码；浏览器不保存密码。
4. 点击“刷新设备”，选择 `boat-01`，再点击左侧“连接云端无人船”。没有设备时等待 STM32 连接 Broker 并上传第一条有效遥测。
5. 连接后查看电机、船速/航向曲线、RTK/IMU、地图、速度分色轨迹、闭环箭头和三维姿态；“退出登录”会关闭当前会话及其实时连接。

账户由本机私密 `web账户.txt` 指定，线上配置保存在 root 专用 `/etc/unmanned-boat-web/accounts.env`；本机忽略目录中的 `UnmannedBoat_Controller/build/cloud-deploy/网页账户信息.txt` 保存私密访问资料。设备连接资料 `云端连接信息.txt` 位于同目录，服务器副本为 `/etc/unmanned-boat-web/access.txt`；这些私密资料不随独立仓库提供。不要将账户文件、密码、本机私有固件头或服务器凭据上传 GitHub。单片机需按[固件构建说明](https://github.com/Coffeebean66/UnmannedBoat/blob/main/UnmannedBoat_Controller/README.md#构建与烧录)构建、烧录匹配账号的 Release HEX，旧的空账号镜像无法连接当前认证 Broker。

### 管理员和访客

| 角色 | 监测、地图、轨迹和动画 | 设备参数操作 | 网页更新 |
| --- | --- | --- | --- |
| 管理员 | 可用 | 蓝牙可用；云端需新版固件在线并报告参数能力 | 可检查、启动和查看结果 |
| 访客 | 可用 | 无管理入口，不发送读取/写入/Flash 请求 | 无入口，服务器拒绝管理请求 |
| 未登录 | 显示登录提示，受保护云端接口不可用 | 不可用 | 不可用 |

顶部显示当前用户名和角色，可退出后登录另一账户；退出会关闭当前云端实时会话。管理员切换为访客后，旧管理员会话失效，调参和更新权限随即撤销。密码只在登录时发送，不放进 URL、前端源码、浏览器存储或公开文档。

自建服务器可在 `/etc/unmanned-boat-web/accounts.env` 配置：

~~~text
BOAT_ACCOUNTS_ENABLED=1
BOAT_ACCOUNTS_ORIGIN=https://boat.example.com
BOAT_ADMIN_USERNAME=<管理员用户名>
BOAT_ADMIN_PASSWORD=<管理员密码>
BOAT_GUEST_USERNAME=<访客用户名>
BOAT_GUEST_PASSWORD=<访客密码>
~~~

两个用户名须不同，允许 1–64 位英文字母、数字、下划线、点和短横线；密码允许 6–256 字符，配置文件仅 root 可读。修改后重启 Web，已有登录随重启失效。密码以服务器私密配置为准，不提供网页自助注册。未启用账户模式的本机开发或旧部署继续使用原有本地蓝牙与密码流程；账户接口不可达时不会自动放开管理权限。

云端调参仅限统一账户中的管理员；未启用账户的旧密码模式保持只读。管理员可在同一设置界面读取、写入、保存 Flash 和使用预设；本地预设仍保存在浏览器。切换数据来源、设备或账户会取消当前参数等待并清理实时状态。云端使用 HTTPS，不要求访问设备支持 Web Bluetooth。

## 界面与导航

界面参考用户提供的无人船监控大屏，采用深海蓝背景、青蓝高亮和细发光边框。首次访问默认深色；右上角月亮/太阳按钮可切换浅色与深色，已保存的主题偏好继续生效，曲线背景、网格和线条同步切换。

桌面顶部横排六项航行指标，左侧保留导航与蓝牙连接摘要。中央船位地图是主要视图，右侧展示三维姿态和RTK/IMU切换面板，下方排列速度/航向控制曲线与双电机，通信诊断集中在底部。手机端改为快捷导航，各面板按屏宽排列。

- 电机卡片突出机械转速和 PWM，环形指示按 PWM 绝对值显示 0–100%，电压、电流、温度和功率并列；方向、容量等详细数据继续保留。
- 曲线下方分别展示目标、实际和误差；船速误差为实际减目标，航向误差为目标减实际的最短角差。过期读数显示 `--`。
- 地图首次未定位时显示等待提示；定位后显示船位和分色轨迹，断流后标记变淡、保留历史路径以便查看。
- RTK/IMU面板通过标签切换，完整保留各自速度、经纬度、姿态、有效状态、序号与数据年龄；标签切换不影响遥测接收。
- IMU 标签左侧竖排显示 Roll / Pitch / Yaw（°），右侧为天空/地面双色人工地平仪：固定机翼参考、外圈横滚刻度（10/20/30/45/60°）、随姿态移动的俯仰刻度（每5°一格、每10°标数）。Yaw 保留为数值，地平仪由 Roll / Pitch 驱动；下方保留三轴角速度和源状态。
- 人工地平仪沿用船体 `X前/Y左/Z上`、`Rz(yaw) × Ry(pitch) × Rx(roll)` 坐标：Roll 正值为右倾，Pitch 正值为船头向下，刻度保留原始正负值，与三维船体姿态一致。欧拉角有效即可更新，无需角速度同时有效；过期/无效时冻结最后姿态并显示原因，断连或切换设备后清除。该二维仪表独立于三维动画开关，不启动连续动画循环。
- 点击“设置”进入参数弹窗：速度闭环 10 项、航向控制 7 项、其他参数 3 项。底部固定显示读取、写入与 Flash 按钮，滚动表单时仍可操作。
- 三组预设分别显示空槽/已保存和保存时间；成功、草稿待写入、设备拒绝/超时采用不同提示色，并保留文字说明。

使用本工程原生 HTML/CSS/JS 实现，没有引入 React、Tailwind 或 UI 框架依赖。图标为本地 SVG，不依赖在线字体。地图继续使用 OSM，深色主题适当降低底图亮度，轨迹与速度箭头保留原色；3D 水面保持独立渲染。参考图中的视频、任务、天气等未接入功能不作为模拟业务展示，所有实时数值仍来自已有设备遥测。

## 数据链路与时效

~~~text
上位机 RTK/IMU → STM32 USART3
                   ├─ UART4 ↔ R10 ↔ T10 ↔ 访问设备的蓝牙 → 本地监测/调参
                   └─ CN14 → 路由器 → MQTT Broker:1883 → Node桥接 → HTTPS/SSE → 远程监测
管理员设置 → HTTPS参数API → Node → MQTT参数命令 → STM32统一参数执行器
管理员设置 ← HTTP真实参数响应 ← Node ← MQTT参数响应 ← STM32
~~~

蓝牙模式的连接发生在访问网页的电脑/手机上，该设备需位于 T10 蓝牙覆盖范围内。云端模式由 STM32 网口直接上报服务器，浏览器通过认证会话接收实时数据，无需连接 T10。路由器可使用有线宽带或能提供互联网的 4G 网络，但固件未直接集成蜂窝模组拨号。

桥接只订阅 `boats/+/telemetry` 和 `boats/+/status`。遥测必须为 176 字节，严格包含电机 64、RTK 40、船体 36、IMU 36 四帧，并逐帧校验版本、类型、长度和 CRC16；浏览器继续复用同一个 UART4 解析器。传感器源年龄和有效位原样保留，收到新网络包不代表 RTK/IMU 本身有效。

不保存或重播缓存遥测，retained 遥测被丢弃；MQTT/SSE 恢复后只接收新的当前帧。网页校准服务器与浏览器时间差，约 1 秒无新包即清空实时读数并暂停姿态，服务端 3 秒无新遥测判设备离线；Broker 断开会立即使设备离线，保留的 `online` 状态不能单独使设备上线。已有轨迹保留，恢复后分段，不补画离线期间路径。这里没有历史数据库或离线轨迹回放。

| 环境 | 说明 |
| --- | --- |
| Windows Chrome / Edge | 需要电脑蓝牙和系统权限；已验证页面及模拟外设流程 |
| Android Chrome | 支持情况取决于设备、系统和浏览器蓝牙实现；需真机检查 |
| iOS Safari / iOS 上常见浏览器、Firefox、微信内置浏览器 | 通常无法直接使用 Web Bluetooth；可尝试云端 HTTPS 监测，实际兼容性以设备测试为准 |
| http://localhost / http://127.0.0.1 | 可作为本机安全来源使用蓝牙 |
| http://服务器IP / 普通局域网 HTTP | 浏览器通常禁止蓝牙；应使用受信任的 HTTPS |

不要直接双击 public/index.html：浏览器会限制本地文件读取和蓝牙。远程服务器需使用HTTPS，仅给HTTP放行端口不能解除浏览器限制。

## 已移植功能

| 功能 | 网页行为 |
| --- | --- |
| 工作台 | 深海蓝监控大屏、六项航行指标、中央地图、右侧姿态与RTK/IMU切换、底部曲线/电机/诊断；保留侧栏/手机导航、浅色切换及主题偏好，支持320px及以上屏宽 |
| 双数据源 | 本地蓝牙与 MQTT 云端监测/调参切换；统一账户登录、设备选择、Broker/设备状态、断流清屏及恢复 |
| 角色账户 | 管理员/访客统一用户名密码登录；访客只监测，管理员可调参与维护；退出、角色切换和会话过期撤销权限 |
| 网页更新 | 管理员顶部“更新”入口、检查 main 提交、确认安装、跨服务重启查看进度、失败恢复旧版本；Linux 服务器首次需要安装可信更新组件 |
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

### 通过云端调参

1. 烧录新版 STM32 固件，网线接路由器，等待设备上传遥测和参数能力。仅升级网页无法让旧固件接收命令。
2. 用管理员登录，选择“云端 MQTT → boat-01 → 连接云端无人船”。
3. 打开“设置”，先“读取参数”，然后修改并“写入参数”；确认成功后再显式“写入 Flash”。三组预设和导出沿用原界面。
4. Flash 仍要求 CH6 低档、两路停稳且反馈正常满1秒、提交值与当前 RAM 完全一致；方向修改也继续受设备停机保护。

每台设备同时只执行一个云端参数事务。读写等待5秒，Flash等待20秒；成功只依据 STM32 返回的原参数响应，MQTT 发送成功不代表已经应用。超时、离线或切换身份后，命令可能已到达设备，页面会要求先重新读取确认，不自动重发。网络断开后不积压命令、不在恢复上线时补执行。

指令完全丢失时，STM32 在空闲且当前 token 达10秒后轮换，不必重启恢复参数能力；等待新能力后重新读取，确认设备实际值。轮换不会抢在已入队事务或待发送响应之前。

设备每秒发送能力包，服务端要求能力和遥测均在2500ms以内。一次命令使用一个令牌，设备执行后轮换；重复同一完整命令只重发上次响应，不再次写 Flash。固件检查5秒设备时基窗口、固定长度、类型和 CRC，并拒绝回调中带 RETAIN 标志的命令。Node 使用 MQTT5 / `rap:true` 拒绝实时与重播的保留消息；STM32 的 MQTT3 在线转发可能不保留该标志，因此还依靠专用 ACL、桥接固定不保留命令、token 与有效窗口约束。令牌用于关联连接与去重，访问授权由账户和 Broker ACL 提供。

| MQTT主题尾部 | 方向 | 内容 |
| --- | --- | --- |
| `parameter-capability` | STM32 → Node | 非保留 JSON `{version:1,token:"16位hex",uptimeMs:uint32}` |
| `parameter-command` | Node → STM32 | 72字节 BPC1 信封，内含原56字节 v5 读取/写入/Flash 请求 |
| `parameter-response` | STM32 → Node | 同一信封，内含原56字节 `0x90` 实际参数响应 |

三个主题均以 `boats/<设备ID>/` 开头，QoS0且不保留。原176字节遥测和 UART4 v5 格式不变。自建服务器使用新版 `deploy-cloud.sh` 时，会为已受管理的设备/桥接账号补充上述精确 ACL 并备份原 ACL、HUP 重载 Broker；保留原密码。通过日常网页按钮只更新应用不会替代这次首次 ACL 配置。

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

适用：使用 **systemd** 的 Linux（如 Ubuntu/Debian），有 sudo 权限，已安装系统级 Node.js 18+ 和 npm（建议 Node 22/24 LTS）。部署脚本用 `npm ci --omit=dev --ignore-scripts` 安装锁定的运行依赖，不使用 Docker。不要使用仅 root 可访问的 `/root/.nvm` Node 路径，Web 服务使用动态非特权用户运行。

将本文件夹传到服务器源码目录，例如 ~/UnmannedBoat_Web：

~~~bash
cd ~/UnmannedBoat_Web
sudo bash deploy.sh
# 自定义端口；可选绑定127.0.0.1或0.0.0.0
sudo bash deploy.sh 8081 127.0.0.1
~~~

复制到 `/opt/unmanned-boat-web`，创建 `unmanned-boat-web.service`，启用开机启动、失败重启，并检查 `/healthz`。先在暂存目录装依赖和检查脚本，再替换运行目录；依赖安装或启动失败会恢复已有站点。已有同名目录或服务必须带本项目标记，否则拒绝覆盖。脚本不自动安装 Node 或更改防火墙、域名、证书。

### 一键部署 MQTT 云服务

~~~bash
cd ~/UnmannedBoat_Web
# 三个参数依次为 Web 端口、Web 监听地址、公开 HTTPS 来源；来源不要带尾斜杠
sudo bash deploy-cloud.sh 7890 0.0.0.0 https://boat.coffeebean66.tech
~~~

`deploy-cloud.sh` 在 Ubuntu/Debian 上按需安装 Mosquitto，创建专用 `unmanned-boat-mqtt.service`，Broker 使用 `0.0.0.0:1883`，再调用 Web 部署脚本。它生成随机网页访问密码、设备密码和桥接密码，不把密码输出到终端。已有受管理配置再次部署会保留账号密码；若发现其他运行中的 Mosquitto 服务或别的程序占用 1883，脚本会拒绝覆盖。脚本不配置 Nginx、DNS、证书、云安全组或防火墙；当前服务器域名和 HTTPS 已配置，2026-10-20 晚间公网 TCP 1883 复查已可连接。自建服务器仍需按实际网络配置放行该端口。

| 配置/服务 | 作用 |
| --- | --- |
| `/etc/unmanned-boat-web/runtime.env` | systemd 注入的云端开关、HTTPS 来源、网页密码、桥接账号及密码，root 专用 |
| `/etc/unmanned-boat-web/accounts.env` | 管理员/访客账户与统一认证开关；可选加载，root 专用，升级保留 |
| `/etc/unmanned-boat-web/accounts-access.txt` | 启用账户后的私密登录资料，root 专用，勿公开 |
| `/etc/unmanned-boat-web/access.txt` | 网页/设备/桥接的连接资料，root 专用，勿公开 |
| 同目录 `passwd`、`acl`、`mosquitto.conf` | Broker 密码哈希、逐用户主题权限和独立监听配置 |
| `unmanned-boat-mqtt.service` | 专用 MQTT Broker，持久化位于 `/var/lib/unmanned-boat-mqtt` |
| `unmanned-boat-web.service` | Node 静态页和 MQTT/SSE 桥接，保留 `healthz.app=unmanned-boat-web` |

默认设备 ID/用户名为 `boat-01`，只允许发布自身遥测、状态、参数能力和响应，并订阅自身 `parameter-command`；`boat-web-bridge` 读取设备上报主题并发布参数命令。设备无法发布命令或访问其他船的参数。MCU 本机 `boat_network_local.h` 中的 ID、用户名和密码必须与部署资料一致，账号错误、ID 不匹配 ACL 或未烧录新镜像都会导致链路不可用。

自建环境使用以下变量；所有密码值均应自行生成，不能照抄占位文字：

~~~text
BOAT_CLOUD_ENABLED=1
BOAT_CLOUD_PASSWORD=<16到256字符的网页访问密码>
BOAT_CLOUD_ORIGIN=https://boat.example.com
BOAT_MQTT_URL=mqtt://127.0.0.1:1883
BOAT_MQTT_USERNAME=boat-web-bridge
BOAT_MQTT_PASSWORD=<桥接账号密码>
BOAT_MQTT_TOPIC_PREFIX=boats
~~~

未设置 `BOAT_CLOUD_ENABLED=1` 时保留原本机页面和蓝牙功能，不连接 Broker。公网 MQTT `1883` 使用普通 TCP，网页 HTTPS 只保护浏览器到网站的链路；当前固件无法通过改成 `8883` 自动启用 TLS。新增的是参数操作，没有远程驾驶接口。

~~~bash
systemctl status unmanned-boat-web
journalctl -u unmanned-boat-web -n 50
curl http://127.0.0.1:8080/healthz
~~~

手动更新可从新的源码目录重新运行部署脚本；首次安装更新组件后，也可使用下面的网页按钮流程。卸载：

~~~bash
sudo bash remove.sh
# 永久删除专用部署目录：
sudo bash remove.sh --purge
~~~

默认停止/禁用 Web 和本项目独立 Broker 服务，将部署目录、云端配置及服务单元移到 root 专用的恢复目录；恢复时按脚本提示放回原路径并重新启用服务。保留源码、Node、Mosquitto 软件包、Broker 持久化数据、Nginx和其他站点。`--purge` 才永久删除经过标记校验的应用和云端配置目录，包括其中的账号资料；自行添加的 HTTPS 代理配置需单独管理。

已安装更新组件时，卸载会先停队列和 worker，再备份可信 helper、更新状态、drop-in 与管理员资料。即使 `--purge` 也保留更新组件及其管理员恢复副本；专用构建账号和队列组不删除，便于恢复。此行为只用于卸载脚本，日常网页更新不停止 Broker。

新版 Linux 部署脚本已在当前 Ubuntu/systemd 服务器执行；升级回滚、拒绝覆盖非本项目目录、依赖安装失败保持旧站点和可恢复删除由模拟 Linux 环境回归覆盖。删除脚本没有用于删除当前线上站点。

## 网页一键更新

### 日常使用

1. 在本机修改 `UnmannedBoat_Web`，测试后将**这个目录的内容作为独立仓库根目录**推送到 [UnmannedBoat-Web](https://github.com/Coffeebean66/UnmannedBoat-Web) 的 `main` 分支。聚合仓库 `UnmannedBoat` 的提交不会自动同步到网页仓库。
2. 打开网站，使用**管理员账户**登录，再点击顶部“更新”。访客无更新权限。账户模式下不再使用旧的更新专用密码；未启用账户模式的旧部署保留原入口。
3. 点击“检查更新”，核对当前版本/提交和候选提交；确认后启动更新。只更新已推送到 GitHub 的代码，不会读取本机尚未上传的修改。
4. 等待下载、依赖安装、验证、重启和健康检查。重启期间页面短暂无法访问是正常现象，弹窗会继续尝试读取结果；成功后刷新页面使用新版。

请在无人船停止航行、不依赖网页实时监测时更新。网页/MQTT 桥接重启会暂时中断浏览器实时数据，但不重启 MQTT Broker，也不修改 STM32 固件或遥控控制逻辑；恢复连接后只展示新遥测，不回放旧数据。

第一次推送必须包含 `server/account-api.js`、`public/account-auth.js`、`server/update-api.js`、`public/update-panel.js`、`maintenance/`、`package-lock.json` 等新文件。可信组件在停服前验证更新接口；已启用账户的服务器还要求候选支持统一账户，防止安装旧版后失去认证。请勿只上传 `public/` 或套一层额外目录。仓库或 npm 不可达、提交在检查后发生变化、锁文件不匹配时，当前服务保持运行，重新检查并重试即可。

### 安全边界与运维

网页只向受限目录写入固定格式任务，不执行 shell，也不能传入仓库地址、分支、文件路径或服务名。仓库固定为 `https://github.com/Coffeebean66/UnmannedBoat-Web`，分支固定为 `main`，每次任务绑定已确认的完整提交 SHA，同时仅执行一个任务。

服务器首次需由管理员安装 `maintenance/install-update.sh` 提供的 systemd 更新组件。可信 worker 安装在应用目录之外，网页后续更新不会替换它；新代码的依赖安装、工具包生成和启动预检均以专用非 root 构建用户执行，下载仓库里的部署脚本不会以 root 运行。Web 仍以非特权用户运行。

在已运行新版 `deploy.sh` 的 Linux 服务器上，首次执行：

~~~bash
cd /path/to/UnmannedBoat_Web
sudo bash maintenance/install-update.sh https://boat.example.com 7890
# 本服务器的 Node 在专用目录，安装时需明确提供 PATH：
sudo env PATH="/opt/unmanned-boat-node24/bin:$PATH" bash maintenance/install-update.sh https://boat.coffeebean66.tech 7890
~~~

两个参数依次是完整网页来源（无尾斜杠）和现有 Node 端口。首次安装生成独立随机更新密钥，保存在 root 专用配置中；重复安装保留已有值。启用统一账户后，用户使用管理员账户登录，原随机更新密钥继续用于任务票据签名，不改成登录密码。安装会重启 Web 一次。本机私密备份位于 `UnmannedBoat_Controller/build/cloud-deploy/`，该目录已被 Git 忽略；不要将其中的账户或更新资料复制进公开网页仓库。

更新只替换 `/opt/unmanned-boat-web` 中的受管理应用文件；保留 `/etc/unmanned-boat-web` 私有配置、Node 运行时、端口、Nginx/证书、域名及 MQTT Broker/账号。旧应用保存在 `/opt/unmanned-boat-web.update-backup-*`，不要在排查回滚前删除。备份会占用磁盘，管理员需定期核对并清理不再需要的旧副本。

统一账户会话最长 12 小时，更新前的候选提交检查仅在 5 分钟内有效；未启用账户模式的旧更新会话最长 30 分钟。服务重启后需重新登录才能再次发起更新；当前任务使用仅能读该任务进度的短时票据跨重启跟踪，不授予新的管理权限。密码不写入 GitHub、前端、URL 或日志；登录和更新要求同源，并有登录限流。Windows 本机和纯静态托管未安装 Linux 更新组件时，会解释不可用原因。

~~~bash
systemctl status unmanned-boat-web-update.path unmanned-boat-web-update.service
journalctl -u unmanned-boat-web-update.service -n 80
~~~

首次安装及本次实际验证结果见下方修改记录。不要将服务器凭据或管理员密码上传仓库。

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
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
~~~

网页按域名根路径部署。SSE 使用 `/api/cloud/events`；代理须禁用缓冲并保留长连接，后端也返回 `X-Accel-Buffering: no`。账户登录和退出要求 `Origin` 精确匹配 `BOAT_ACCOUNTS_ORIGIN`（未设置时回退到云端/更新来源），HTTPS 使用 HttpOnly、SameSite=Strict、Secure Cookie，最长 12 小时，服务重启后失效。只有来自本机代理的 `X-Real-IP` 才用于登录限流，Nginx 应覆盖该头。云端参数 API 同样要求同源，且仅允许统一账户中的管理员操作。

也可用Node自身TLS（证书须被客户端信任）：

~~~powershell
$env:TLS_KEY = 'D:\certs\privkey.pem'
$env:TLS_CERT = 'D:\certs\fullchain.pem'
$env:HOST = '0.0.0.0'
$env:PORT = '8443'
node server.js
~~~

本版前端必须能访问 Node 的 `/api/auth/config`：账户配置未知时禁用监测连接和管理操作，单独上传 `public/` 的纯静态站点不能使用完整功能。本机开发启动 Node、保持账户功能关闭即可直接使用蓝牙。GLB 模型按二进制提供，JS/CSS 的 MIME 类型需正确。Node 静态资源仅允许 GET/HEAD，登录为 POST、退出为 DELETE；未知资源返回 404，阻止目录穿越和跨根目录符号链接。

### 云端接口

启用账户模式时，登录/退出统一使用 `/api/auth/`；旧云端密码和更新密码登录接口返回 403。

| 路径 | 方法与返回 |
| --- | --- |
| `/api/auth/config` | GET，`enabled`、`requiresLogin`、当前 `{username,role}` 或 null；不返回密码 |
| `/api/auth/login` | POST JSON `{username,password}`，同源登录并设置全站会话 Cookie |
| `/api/auth/session` | DELETE，同源退出，撤销共享会话并关闭其 SSE |
| `/api/cloud/config` | GET，`enabled`、`requiresLogin`、`serverTime`；无需登录 |
| `/api/cloud/login` | 仅旧部署：POST JSON `{password}`，要求同源 |
| `/api/cloud/session` | 仅旧部署：DELETE，退出旧云端会话，要求同源 |
| `/api/cloud/devices` | GET，需登录；`brokerConnected`、设备列表和 `serverTime` |
| `/api/cloud/parameters` | POST JSON `{deviceId,kind:"read"\|"write"\|"flash",values?}`；仅管理员同源；成功 HTTP 响应 `{frame:原56字节Base64,serverTime}`，设备拒绝状态仍在帧内 |
| `/api/cloud/events?device=boat-01` | GET，需登录；SSE `state` 和 `telemetry`，遥测含 `deviceId`、`receivedAt`、原始 payload 的 Base64 与 `ageMs:0` |

设备条目包含 `id`、`online`、`lastReceivedAt`、`status`、`lastStatusAt`。服务端限制 64 台记录设备、128 个会话、64 个 SSE 连接且每会话至多 4 个，登录每 IP 每分钟最多 8 次；慢客户端发生背压时断开，避免无限队列。网页会自动恢复实时通道，恢复不会重播旧帧。

## 代码与验证

~~~text
UnmannedBoat_Web/
├── server.js                  静态服务、TLS、健康检查与云端入口
├── server/cloud.js            MQTT遥测桥接与参数事务、在线状态和能力检查
├── server/parameter-protocol.js BPC1信封、20项范围与响应校验
├── server/cloud-api.js        同源登录、会话、设备列表和SSE
├── server/account-api.js      统一管理员/访客登录、共享会话与角色授权
├── server/update-api.js       管理员授权、固定仓库检查、任务和只读进度票据
├── maintenance/               首次安装脚本、可信更新worker及候选版本预检
├── package-lock.json          MQTT运行依赖锁定
├── public/
│   ├── index.html             监控页和设置弹窗
│   ├── account-auth.js        统一登录、角色权限、退出与会话刷新
│   ├── app.js                 遥测、曲线、地图、轨迹
│   ├── ui.js                  SVG图标、主题偏好、时钟、遥测标签和导航
│   ├── map-velocity-view.js   地图速度箭头SVG与船位跟随
│   ├── styles.css / ui.css    通用主题、组件和参数弹窗
│   ├── dashboard.css          地图主屏布局、深蓝装饰与响应式适配
│   ├── transport.js           蓝牙、分片写入、参数事务
│   ├── cloud-transport.js     云端会话/SSE、时效与双数据源切换
│   ├── update-panel.js        更新登录、提交确认、重启轮询和结果提示
│   ├── parameter-panel.js     参数、预设、导出
│   ├── attitude-view.js       3D姿态、画质、动画调度
│   ├── artificial-horizon.js / .css  IMU 圆形人工地平仪、左右布局及无效状态
│   ├── parameter-data.js      20项参数及说明快照
│   ├── utils/                 小程序工具快照、WGS84轨迹及地图速度矢量计算
│   ├── utils-bundle.js        浏览器工具包
│   ├── assets/boat_mobile.glb 船体模型
│   └── vendor/leaflet/        地图库和许可证
├── build-bundle.js            工具包生成/可选同步小程序
├── start-local.cmd/.ps1       前台本机启动
├── deploy.cmd/.ps1/.sh        Windows复制 / Linux systemd部署
├── deploy-cloud.sh            独立认证Broker、私有配置与Web云端部署
├── remove.cmd/.ps1/.sh        带目录校验的移除/卸载
└── tests/                    协议、服务器和Chrome模拟蓝牙检查
~~~

启动无需构建，工具包已生成。修改 public/utils/ 后执行 npm run build。如需重新同步旁边的小程序，执行 node build-bundle.js --sync：覆盖网页工具、模型、参数说明快照，再添加WGS84投影适配，不修改小程序。

~~~bash
npm test
npm run test:browser
node tests/update-browser.cjs
node tests/accounts-browser.cjs
node tests/cloud-parameters-browser.cjs
~~~

浏览器检查要求Node 22+及Chrome。Windows默认Chrome路径为 C:\Program Files\Google\Chrome\Application\chrome.exe，其他路径通过 CHROME_PATH 指定。测试启动临时本机服务和无界面Chrome，完成后关闭；模拟外设不连接电机。截图、临时配置及测试部署保存在已忽略的 .test-output/。

2026-10-20 17:14:38 +08:00 云端调参验证：148项Node全套串行通过，原Chrome蓝牙/WebGL/地图、账户、更新及新增1440/320px云端参数流程通过；默认并发运行曾因Git Bash模拟部署20秒进程限时出现一次超时，部署专项单独复跑及全套串行均通过。生产v1.6.0隔离虚拟设备经真实Broker/HTTP验证读取/写入/Flash拒绝及成功、游客403、旧固件/保留能力拒绝、坏CRC忽略、超时不重发；未向真实boat-01发指令。临时账号和ACL已移除并验证原SHA，原凭据及Broker进程保持。公网HTTPS双角色权限、离线设备拒绝及8个前端文件哈希通过。固件构建与宿主测试通过，未烧录实体板卡；公网1883复查仍超时，需安全组放行。

2026-10-20 14:57:28 +08:00 账户历史验证：完整 122 项 Node 回归通过；最后前端调整后 41 项关键回归和 1440/320px 真实 Chrome 账户流程通过，覆盖访客蓝牙监测、各层参数拦截、管理员读参、共享更新会话、退出/换身份/过期撤销及 SSE 关闭。原 Chrome 蓝牙/WebGL/地图与更新弹窗回归通过。

已部署 v1.5.0 并按私密文件启用两类账户。公网 HTTPS 验证管理员/访客登录及云端监测、管理员检查 GitHub、访客更新 API 拒绝、匿名/跨站/旧密码入口拒绝和退出撤销。服务器验证账户配置 root/0600、可信 worker 空队列运行，以及非 root 候选使用假账户预检；原 runtime/update/MQTT 凭据校验和 Broker PID 未变化。未从 GitHub 触发线上版本切换，未增加实体船联调。

2026-10-20 网页更新历史验证：完整 95 项 Node 回归通过；其后补充的恢复分支通过 worker 16 项专项验证。新增项覆盖管理员/同源/限流、GitHub 小型 ref 响应、原子队列、跨重启票据、前端状态机、候选兼容性、构建隔离、健康失败回滚、恢复失败保留事务及首次安装/重复安装密码保留/可恢复删除。真实服务器隔离临时目录中，更新相关 57 项通过；Windows 部署保护测试通过，原 Chrome 蓝牙/WebGL/地图回归及新增 1440/320px 更新弹窗模拟流程通过。

已在现有服务器执行首次安装；真实公网 HTTPS 验证新版页面、管理员登录/检查 GitHub/退出、匿名/跨站/云端查看密码不能更新，以及原有云端认证和 Broker 连接。升级前后校验 `runtime.env` 和 MQTT 密码文件未变化、Broker PID 未变化。此次手动部署的提交显示“未知提交”（尚未从 GitHub 安装）。当前 main 仍为 `4dee0c63c13917490460349b1c99816b88d79e0f`，本次没有从该旧候选触发线上切换；用户首次推送新代码后再使用按钮更新。

2026-10-20 11:49:35 +08:00 云端验证：完整 38 项 Node 回归通过，包括原 16 项、后端 9 项、前端云端 7 项及 Linux 模拟部署/回滚 6 项。覆盖四帧 CRC/布局、源年龄、retained 拒绝、断线/订阅失败/迟到回调、同源登录/限流、会话/SSE 数量、退出/过期、背压释放和数据源切换；既有 Chrome 模拟蓝牙回归通过。

真实公网 HTTPS 登录、远端 Broker 经临时 SSH 转发到 Node/SSE/Chrome 的云端链路通过：验证了 176 字节四帧、地图、IMU、WebGL 船模、速度/航向曲线、速度矢量、轨迹、云端只读、BLE 隔离、重连、1 秒失效、LWT 离线，以及 320/375/430/1440px 布局。真实 Broker 也验证了匿名/错误密码拒绝、设备禁止跨船写入及发送命令、桥接账号禁止发布。

公网 1883 TCP 尚未建立，待用户在阿里云安全组放行；上述 MQTT 验证通过临时 SSH 隧道进行，不能代替公网 1883 可达性验证。当前没有实体 STM32、真实 T10 或水上联调结果，测试数据不代表实船传感器测量。

2026-10-19 历史验证（以下为当时范围，Linux 部署状态已由本次更新）：

- v1.2.1的16项自动检查及网页脚本语法检查通过。Chrome模拟蓝牙验证1440/1920px地图主布局、页面ID唯一、RTK/IMU点击与方向键/Home/End切换、默认深色/浅色切换及偏好恢复；320/375/640/768/1024/1440/1920px无横向溢出，原蓝牙、参数、Flash拒绝/超时、三组预设、轨迹、速度箭头和动画检查保留并通过。375/320px滚入三维区域后可恢复船模与水面，暂停动画保持暂停；离屏停止绘制不影响实际浏览。零速断言等待实际渲染到0，避免固定等待时间读到旧状态；未新增真实T10、手机浏览器或船上验证。
- v1.2.0的16项核心检查及新增脚本语法检查通过，含东/北方向、目标斜坡与倒车、零速、独立有效位、缺失/过期数据与坐标边界。Chrome模拟蓝牙验证箭头长度比、方向、重合辨识、实际SVG尺寸与船位原点、平移/缩放锚定、隐藏按钮和刷新偏好恢复；地图特写确认两支箭头可见，1440/1024/768/640/375/320px页面及设置内容无横向溢出。
- 6项核心检查通过：CRC、拆包/粘包/坏帧恢复、源超时、WGS84轨迹/断段、航向跨0°、参数分片/响应/超时/并发、HTTP资源与路径边界。
- v1.1.0 Chrome验证通过：本地GLB与WebGL、水面、模拟蓝牙遥测、读写/Flash拒绝与超时、三组参数共20项、预设使用及刷新恢复、主题切换及刷新恢复、Canvas配色、地图等待状态、断流占位、重连单次订阅、动画冻结。
- v1.1.0 的1440/1024/768/640/375/320px页面及设置内容无横向溢出，检查了浅色、深色、实时和空数据截图；网页脚本语法检查通过。
- v1.0.0 部署脚本的PowerShell和Bash语法检查通过，本轮未修改部署脚本。
- Windows部署目录首页、模型资源和默认可恢复删除流程实测通过，测试服务均已退出。
- 当时尚未进行真实T10蓝牙联调或Linux/systemd实机部署；当前 Linux 部署状态见上方 2026-10-20 记录。

## 修改记录

| 日期 | 网页版本 | 功能 |
| --- | --- | --- |
| 2026-10-22 21:23:43 +08:00 | v1.7.0，项目 v2.17.0 | IMU 左侧竖排 Roll/Pitch/Yaw、右侧圆形人工地平仪，横滚/俯仰刻度与固定机翼参考，姿态方向沿用现有船体坐标；独立 Euler 有效判定、原始数值传递、失效冻结和断连清除；纯 SVG 无持续动画循环，适配深浅主题与手机；11项Node及完整Chrome模拟遥测检查通过，320～1920px页面、极值负角度和长超时提示无溢出，已目视桌面/手机截图，未联调实体IMU；本次仅上传网页源码，尚未部署线上服务 |
| 2026-10-20 21:19:14 +08:00 | v1.6.0，项目 v2.15.0，源码同步 | 完整同步服务端、账户、更新 worker、云端参数、锁定依赖和正式测试至独立仓库；修正文档链接和当前1883可达性，保留历史验证结果；清理临时测试产物，记录1秒遥测判定与固件MQTT回调顺序两个已知未修复问题 |
| 2026-10-20 17:14:38 +08:00 | v1.6.0，项目 v2.15.0 | 管理员云端读取/写入20项参数及显式保存Flash，复用设置/预设/导出；真实设备确认、单次token和超时不重发；MQTT5保留标志与设备隔离ACL，原凭据保留；148项Node、4类Chrome及生产隔离MQTT/公网HTTPS验证通过；新固件需烧录，公网1883待放行，未推送GitHub |
| 2026-10-20 14:57:28 +08:00 | v1.5.0，项目 v2.14.0 | 按私密文件部署管理员/访客账户，统一登录与会话、角色权限、退出与过期撤销；游客仅监测，管理员蓝牙调参/网页更新；禁用旧密码入口，账户随更新保留，候选预检防止退回无账户版本；122项回归及公网双角色验证通过，MQTT凭据和Broker保持不变 |
| 2026-10-20 14:35:25 +08:00 | v1.4.0，项目 v2.13.0 | 增加独立管理员网页更新入口、固定 main 提交检查/确认、任务进度与重启重连、兼容预检和健康失败回滚；外置可信 worker、首次安装/卸载备份与凭据保护；现有服务器已安装，真实 HTTPS 管理与原云端验证通过；尚未提交/推送，不用旧 GitHub 候选覆盖线上 |
| 2026-10-20 13:22:16 +08:00 | v1.3.0，项目 v2.11.0 | 固件改为 CubeMX 生成基础外设、业务代码独立与受控再生成流程；真实再生成、Debug/Release、OLED开启编译及宿主回归通过；同步项目文档，网页功能、部署和通信格式不变，未进行硬件实测 |
| 2026-10-20 12:52:15 +08:00 | v1.3.0 | 按用户要求更新 boat-01 设备 MQTT 密码并同步本机私有配置与固件；新密码认证成功、旧密码拒绝，独立桥接账号及网页登录正常；本次只更新部署配置，不改变网页功能或版本 |
| 2026-10-20 11:49:35 +08:00 | v1.3.0 | 增加认证 MQTT Broker、Node只读桥接、登录/会话/SSE API、蓝牙/云端选择、设备列表和实时监控；保持源数据年龄，拒绝retained与缓存重播，云端禁止设备调参；新增锁定依赖、Linux云端部署/回滚/可恢复删除，部署到现有HTTPS站点；38项回归和HTTPS/SSH隧道MQTT/Chrome链路通过，公网1883待安全组放行 |
| 2026-10-19 20:20:26 +08:00 | v1.2.1 | 参考深蓝监控大屏重排UI：六项航行指标、中央地图、右侧姿态与RTK/IMU切换、下方控制曲线/双电机、底部通信诊断；默认深色并保留浅色切换及已有主题偏好，保留全部遥测与调参操作 |
| 2026-10-19 19:46:25 +08:00 | v1.2.0 | 闭环地图叠加目标/实际速度方向箭头、共同比例长度、自适应缩放、隐藏/显示按钮与偏好保存；区分船头目标方向与RTK对地实际运动方向，失效时隐藏 |
| 2026-10-19 19:21:15 +08:00 | v1.1.0 | 重做工作台UI、侧栏/手机导航、浅深主题、本地SVG、电机PWM环形显示、曲线摘要、地图空状态、分组参数及预设卡片；浏览器验证六档宽度与现有蓝牙操作 |
| 2026-10-19 | v1.0.0 | 独立网页版、响应式UI、Web Bluetooth、20项调参/Flash/三组预设/导出、速度分色轨迹、3D姿态水面与画质控制、无Docker部署/卸载脚本与验证 |
