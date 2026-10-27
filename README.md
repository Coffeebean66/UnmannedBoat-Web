# 无人船监测平台 · Web

网页版源码 `v1.25.0`，项目版本 `v2.34.0`，配套固件仍为 `v2.27.0`；通过 MQTT 云端连接无人船，并接收每艘船的 HTTP(S) 视频地址。管理员可在平台设置中为每艘船维护独立的视频 MQTT 用户名和密码，视频账号只允许写入该船的 `video` 主题，不改变船端遥测账号或设备 ID。`#fleet` 船队总览同时显示最多64艘已接入船只并可搜索/筛选；管理员可在每艘船卡片点击“调参设置”，自动选择该船并打开标有设备 ID 的参数弹窗，保持船队页面。打开弹窗不发送参数请求，点击“读取参数”后才请求；读取、写入和 Flash 保存均只针对该船，切换船只需重新读取。顶部和侧栏底部的全局调参入口已移除，当前无人船下拉保留该船的调参入口；离线船按钮禁用，访客隐藏入口，参数操作忙时防止切换调参对象。

界面参考 seabot 的后台控制台风格，包含深浅主题、统计卡片、有效定位地图、最近遥测和“工作台 / 船名 / 当前页面”面包屑。选择船只可进入单船概览、船位、姿态、曲线、推进、诊断和船载视频页面；桌面单船页面收纳在可展开菜单中，连续遥测更新会保留手动收起状态。独立“平台设置”管理用户、MQTT 设备账号、每船视频账号和地图配置。旧服务器需更新一次 MQTT 管理组件以启用新增船只及视频账号管理；网页更新不会替换 root 管理组件。视频发送端使用单独的受限发布账号，接入方法见 [视频接入教程](VIDEO_SETUP.md)。本版 `v1.25.0` 于 `2026-10-27` 发布至 [独立网页仓库 main](https://github.com/Coffeebean66/UnmannedBoat-Web/tree/main)，本次不同步主仓库，未部署服务器。

视觉参考：[bilired/seabot](https://github.com/bilired/seabot) 与其采用的 [Daymychen/art-design-pro](https://github.com/Daymychen/art-design-pro)。本平台使用现有 HTML/CSS/JS 组件重新实现相应布局与视觉风格，未引入其前端框架。

## Linux 首次部署：一条指令

适合 Ubuntu 22.04/24.04、Debian 12 及以上的 systemd 服务器，支持 x86_64 / ARM64，需要 root 或 sudo 权限。本安装入口配置 IPv4 监听：请将自己域名的 **A 记录**解析到服务器公网 IPv4，首次安装时不要保留指向 IPv6 的 AAAA 记录，以免证书验证访问到未配置的 IPv6 站点。在云安全组及本机防火墙放行 TCP **80、443、1883**：80 用于申请和续期证书，443 用于网页，1883 用于船端 MQTT。

将下面的 `boat.example.com` 和 `admin@example.com` 换成**自己的域名和证书通知邮箱**，在服务器终端执行：

~~~bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates && curl -fsSL https://raw.githubusercontent.com/Coffeebean66/UnmannedBoat-Web/main/install-linux.sh -o install-linux.sh && sudo bash install-linux.sh boat.example.com admin@example.com
~~~

上述指令会先准备下载工具，适合尚未安装 curl 的服务器。若已在 root 会话中执行，可去掉 `sudo`。

默认内部网页端口为 `7890`；需要修改时在末尾加端口，例如 `sudo bash install-linux.sh boat.example.com admin@example.com 8080`。浏览器访问 `https://boat.example.com`，不需要在公网开放内部网页端口。脚本要从 GitHub、npm、Node.js 官网、系统软件源和 Let's Encrypt 下载资源；下载或证书验证失败时会报出失败阶段。

脚本依次完成：

1. 检查首次安装条件，安装 Git、curl、Nginx、Certbot 等依赖；系统没有可用的 Node.js 18+ 和 npm 时，从官网下载并校验 Node.js 22。
2. 下载固定仓库的 `main` 源码，记录提交版本，复用项目部署脚本安装 MQTT Broker 和网页服务，启用开机启动。
3. 创建 `admin` 管理员和 `guest` 访客，分别生成随机密码；MQTT 的 `boat-01` 设备及网页桥接账号也使用独立随机密码。
4. 配置独立 Nginx 站点、申请 Let's Encrypt HTTPS 证书及续期重载，开启 SSE 实时数据转发。
5. 安装网页更新组件，之后管理员可在网页点击“更新”，检查并安装本仓库的最新提交。
6. 安装 MQTT 设备账号管理组件，管理员可在设置中管理设备接入凭据，原设备密码保持不变。

安装成功后，在服务器上查看自己的登录和设备资料：

~~~bash
sudo cat /etc/unmanned-boat-web/accounts-access.txt  # admin / guest 登录资料
sudo cat /etc/unmanned-boat-web/access.txt           # 船端 MQTT 账号及固件配置
sudo systemctl status unmanned-boat-web unmanned-boat-mqtt
~~~

这些文件属于本次部署的私密配置，不要上传 GitHub。STM32 必须使用**这台服务器的 MQTT 域名、设备 ID、账号和密码**重新配置并烧录，才会出现在网页设备列表；网页部署成功不代表船端已经接入。默认设备为 `boat-01`；1883 为普通 MQTT/TCP，当前固件没有 MQTT TLS。

首次安装脚本不覆盖已有本项目安装或同名配置，不会接管其他 MQTT Broker，不修改 DNS、云安全组或防火墙。已有其他 Nginx 站点会保留；若同域名、端口或本项目专用路径冲突，先按报错处理。安装中途失败可能已安装软件包、创建服务或生成配置，脚本会保留凭据供排查；不要直接删除 `/etc/unmanned-boat-web` 后重试。日常升级请使用网页“更新”或下文的现有部署流程。

卸载应用使用下文 `remove.sh`；首次安装额外安装的 Node、Nginx、证书、专用 Nginx 配置、续期 hook 及系统软件包需要按实际用途单独管理，`remove.sh` 不删除这些资源。详细运维步骤见[Linux 部署与卸载](#一键部署--卸载linux)和[网页一键更新](#网页一键更新)。

## 监测工作区

左侧导航与手机顶部导航直接切换页面，每次只显示当前工作区。顶部的 MQTT 设备连接、账户、设置和更新入口保持可用，换页不会重连 MQTT，也不会清空已采集轨迹和参数草稿。

| 页面 | 内容 |
| --- | --- |
| 船队总览 `#fleet` | 同时接收所有接入无人船的在线状态、速度、航向、定位和供电电压；支持按 ID 搜索、在线状态筛选并进入单船详情 |
| 船况概览 `#overview` | 六项关键船况、地图和姿态摘要，提供进入专用页面的快捷入口 |
| 船位与轨迹 `#navigation` | 放大的地图、速度方向箭头、追踪/清除/跟随、地图切换及船位信息 |
| 三维姿态 `#attitude` | 放大的三维船模、动画/水面/画质控制、RTK 与 IMU 同屏仪表 |
| 控制曲线 `#analysis` | 放大的目标/实际船速或航向曲线、误差读数、切换与清空 |
| 推进系统 `#propulsion` | 两路电机的完整遥测、PWM 输出及运行状态 |
| 通信诊断 `#diagnostics` | MQTT 链路、帧数、CRC、收帧时间与参数设置入口 |
| 船载视频 `#video` | 当前船的视频地址、接收时间与播放状态；播放 HLS、HTTP-FLV 或浏览器原生媒体 |

地址栏片段表示当前页面，例如 `https://boat.coffeebean66.tech/#navigation`；可收藏、刷新恢复，或用浏览器前进/后退切换。刷新仍是重新加载整个网页，设备监测需要重新连接。页面切换复用同一份地图、船模和传感器面板；曲线在离开页面时继续采集，返回即按当前尺寸绘制，隐藏的三维画面停止绘制。

船队页面使用一个受限的总览 SSE 同时更新所有船的摘要，主页面已有单船仪表仍只订阅当前选中的设备，不转发或缓存其他船的原始数据。船队卡片显示实际/目标速度、航向、定位、平均可用电调电压和控制模式；设备 ID 即船名。服务器与网页按源数据年龄分别判定速度、航向、位置、电压及时效，任何失效值显示 `--`；Broker、船或总览通道断开会立即清除实时值，但保留已发现设备及最后收帧时间作为离线记录。选择卡片后进入单船概览，顶部选择框也可直接切船；详情地图、曲线、轨迹及参数操作均只针对当前设备。

单船概览左侧设备栏显示船模缩略图、MQTT 标记、连接状态、有效帧数、最近更新时间及三项延迟。最近更新时间是浏览器收到有效协议帧的本地时间，断线后保留，切船时重置。转发延迟是服务器接收 MQTT 至浏览器接收的估计耗时；船→云延迟由新固件与后台自动校时后按每包遥测估算，合计为两段相加。任一所需时间信息未知或离线时显示 `--`，不将单段延迟冒充合计。柱形图标只指示连接状态，不代表实测信号强度。

实时监测面板同时显示 RTK 与 IMU，无需切换标签：顶部为定位和 IMU 状态，左侧为 Roll/Pitch/Yaw，中央为人工地平仪，右侧为 X/Y/Z 角速度及 RTK 东/北对地速度，下方为 WGS84 经纬度、对地合速及 RTK 船头航向。序号、数据年龄、时间对齐和航向更新状态收进“数据详情”。当前协议没有 GPS 星数、HDOP、固定解等级、电池电量百分比、IMU 线速度、相对高度、水温或水深，界面不填充示例值。

本版按真实高德 SDK 的请求修正服务器 CSP，并等待高德 `complete` 事件再标记底图初始化完成。15 秒未完成或收到地图错误时显示失败，可手动切换 OSM；后续高德资源若被 CSP 拦截，也会显示警告。配置和更新步骤见 [高德地图配置教程](AMAP_SETUP.md#高德空白与-csp-修复)。

地图下方新增“切换至 OSM / 切换至高德”按钮，无需连接无人船即可操作。切换成功后记住当前浏览器的选择，刷新页面继续使用；配置完整且没有选择记录时优先高德。切换会保留视野、缩放、船位、轨迹和箭头，不会重新连接遥测。高德未配置时提示管理员填写 Key；加载失败时保留当前地图，也可在地图初始化失败后主动选择 OSM。

管理员现在可以直接在“设置 → 平台地图设置”填写高德 Web端 Key 和安全密钥，保存到服务器后点击“刷新页面应用”。无需连接无人船，也无需修改源码。配置在服务重启和网页更新后保留；两项都清空再保存可停用高德，使用 OSM。船位、分色轨迹和速度箭头在高德显示时统一转为 GCJ-02，RTK 数值保留 WGS84 原值。申请、界面操作及环境变量配置见 [高德地图配置教程](AMAP_SETUP.md)。

实时监测保留 IMU Roll / Pitch / Yaw 和人工地平仪，并与 RTK 数据同屏显示。云端调参自 `v1.6.0` 起支持经 HTTPS → MQTT → STM32 读取/修改全部20项参数及显式保存 Flash，需项目 `v2.15.0` 或更新固件报告参数能力。管理员可调参、访客只监测。网页 MQTT 监测与调参不依赖固件的 UART4 数传开关；固件和微信小程序原有通信功能未随本次网页改动删除。固件生成说明见[主项目固件说明](https://github.com/Coffeebean66/UnmannedBoat/blob/main/UnmannedBoat_Controller/README.md#cubemx-重新生成代码)。

独立网页工程，提供适合浏览器工作区的监测、调参、地图、三维姿态和视频页面。前端使用原生 HTML/CSS/JavaScript；Node.js 提供页面、账户会话、MQTT 桥接和 SSE 实时推送，不使用 Docker。运行依赖 npm `mqtt`、`hls.js 1.7.3` 和 `mpegts.js 1.8.2`，由 `package-lock.json` 锁定；复制完整文件夹后执行 `npm ci --omit=dev`，再执行 `npm run build` 生成浏览器资源。播放器库随站点本地提供。设备遥测、调参和视频地址通过 MQTT 接入，视频画面本身由浏览器通过 HTTP(S) 加载；摄像头推流、RTSP/RTMP 转换和视频服务器需另行准备。需要启用云服务并配置可连接的 Broker，页面不会在 MQTT 未启用或断开时改用其他设备连接方式。

独立仓库：[Coffeebean66/UnmannedBoat-Web](https://github.com/Coffeebean66/UnmannedBoat-Web)。克隆后仓库根目录就是网页工程，完整包含前端、服务端、模型、测试及部署/删除脚本。主项目位于 [Coffeebean66/UnmannedBoat](https://github.com/Coffeebean66/UnmannedBoat)，两个仓库需要分别提交同步。

~~~bash
git clone https://github.com/Coffeebean66/UnmannedBoat-Web.git
cd UnmannedBoat-Web
npm ci --omit=dev
~~~

2026-10-23 只读核对线上为 `v1.10.0` / `32c1483`：[https://boat.coffeebean66.tech](https://boat.coffeebean66.tech)。服务器已启用管理员/访客和参数主题 ACL；Ubuntu 服务器 `47.251.109.111` 上，Nginx HTTPS 代理 Node `7890`，Node 监听 `0.0.0.0`；独立 MQTT Broker 监听 TCP `1883`。这是上次线上核对记录，不代表本次 `v1.16.0` 已部署；服务器版本与 GitHub 源码同步分别记录。

2026-10-20 晚间复查，公网 TCP 1883 已可连接；服务器到 Broker 及网页 SSE 通道连续观察 55 秒稳定。当时船端已关闭，没有验证正在运行的 STM32 链路。新 Release 固件仍需用户烧录和实机测试。

2026-10-20 源码同步时的已知问题：网页约 1 秒无新鲜遥测即显示断开，服务端在线窗口为 3 秒，短暂网络延迟可能造成状态切换；当时固件 MQTT 入站回调注册顺序存在被连接初始化清空的缺陷。后续项目 `v2.16.0` 的 FreeRTOS 固件已修复回调顺序并用队列执行参数命令，但尚未烧录实机；网页 `v1.7.0` 本次只增加 IMU 仪表，历史虚拟设备测试不代表真实固件调参已验证。

## 快速开始：Windows 本机

先安装 Node.js 22/24 LTS（服务器最低支持18），执行 `npm ci --omit=dev`，并按下方“MQTT 云服务”配置启用云端及 Broker。双击 **start-local.cmd**，然后用浏览器打开：

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

登录账户后刷新设备列表，选择已接入 MQTT 的无人船，再点击连接。连接成功后监控数据自动更新；参数只有在管理员点击“读取参数”后才发送。本机未启用 MQTT 时页面会明确提示服务器未启用云端监测；此时仍可检查页面、地图和设置入口，但不能接收船端遥测。

### 使用已部署的云端监测

1. 将更新过连接配置的 Release 固件烧录到 STM32，CN14 网线接到可访问互联网、提供 DHCP 的路由器 LAN 口。
2. 打开上述 HTTPS 网站，网页直接显示 MQTT 设备连接区。
3. 点击“账户登录”，使用管理员或访客用户名和密码；浏览器不保存密码。
4. 点击“刷新设备”，选择 `boat-01`，再点击顶部“连接无人船”。没有设备时等待 STM32 连接 Broker 并上传第一条有效遥测。
5. 连接后查看电机、船速/航向曲线、RTK/IMU、地图、速度分色轨迹、闭环箭头和三维姿态；“退出登录”会关闭当前会话及其实时连接。

首次登录账户由安装脚本或 root 专用 `/etc/unmanned-boat-web/accounts.env` 初始化；管理员通过网页修改后，以独立账户库为准，初始登录资料文件不会跟着更新。本机私密 `web账户.txt` 与忽略目录中的 `UnmannedBoat_Controller/build/cloud-deploy/网页账户信息.txt` 仅是原部署资料。设备连接资料 `云端连接信息.txt` 位于同目录，服务器副本为 `/etc/unmanned-boat-web/access.txt`；这些私密资料不随独立仓库提供。不要将账户文件、密码、本机私有固件头或服务器凭据上传 GitHub。单片机需按[固件构建说明](https://github.com/Coffeebean66/UnmannedBoat/blob/main/UnmannedBoat_Controller/README.md#构建与烧录)构建、烧录匹配账号的 Release HEX，旧的空账号镜像无法连接当前认证 Broker。

### 管理员和访客

| 角色 | 监测、地图、轨迹和动画 | 设备参数操作 | 网页更新 | 地图配置 | 用户管理 | MQTT 设备账号 |
| --- | --- | --- | --- | --- | --- | --- |
| 管理员 | 可用 | MQTT 云端可用；需新版固件在线并报告参数能力 | 可检查、启动和查看结果 | 可填写和保存高德配置，无需连船 | 新建用户、改名、重设密码和调整角色 | 管理船端账号及每船视频账号 |
| 访客 | 可用 | 无管理入口，不发送读取/写入/Flash 请求 | 无入口，服务器拒绝管理请求 | 不可修改 | 不可查看列表或修改账户 | 不可读取或修改 |
| 未登录 | 显示登录提示，受保护云端接口不可用 | 不可用 | 不可用 | 不可用 | 不可用 | 不可用 |

顶部显示当前用户名和角色，可退出后登录另一账户；退出会关闭当前云端实时会话。管理员切换为访客后，旧管理员会话失效，调参和更新权限随即撤销。密码只在登录时发送，不放进 URL、前端源码、浏览器存储或公开文档。

自建服务器可在 `/etc/unmanned-boat-web/accounts.env` 配置初始账户：

~~~text
BOAT_ACCOUNTS_ENABLED=1
BOAT_ACCOUNTS_ORIGIN=https://boat.example.com
BOAT_ADMIN_USERNAME=<管理员用户名>
BOAT_ADMIN_PASSWORD=<管理员密码>
BOAT_GUEST_USERNAME=<访客用户名>
BOAT_GUEST_PASSWORD=<访客密码>
~~~

两个初始用户名须不同，允许 1–64 位英文字母、数字、下划线、点和短横线；密码允许 6–256 字符，空格原样保留。环境配置仅用于尚无独立账户库时的初始化；有账户库后修改这些初始用户名/密码不会覆盖网页中保存的账户。未启用账户模式的旧部署可继续使用云端访问密码进行只读 MQTT 监测；账户接口不可达时不会自动放开管理权限。

### 在网页管理用户

1. 使用管理员登录，打开顶部“设置”，进入“用户与账户”。此操作不需要连接无人船。
2. 点击“新建用户”，填写用户名、角色、新密码及确认密码，再点击“保存用户”。最多64个用户；新用户即可登录，不提供开放注册。
3. 点击现有用户的“编辑”，可更改用户名、角色或重设密码。编辑时两项密码均留空可保留原密码；系统必须至少保留一个管理员。
4. 修改用户名、密码或角色后，该用户的所有旧会话失效，实时连接随即关闭。修改自己的账户会要求重新登录；修改其他账户不影响当前管理员的监测连接。

账户库保存盐化 scrypt 派生值，接口不返回密码或密码哈希，浏览器不保存密码。关闭设置、切换账户及提交后会清空密码输入。读取/保存失败会明确提示，写入请求不会自动重发；响应超时时先重新读取列表确认。首次保存会将初始管理员/访客一并迁移到独立账户库，后续重启或网页更新保留全部用户。

账户库位置可用绝对路径 `BOAT_ACCOUNTS_FILE` 指定；默认新装 systemd 服务为 `/var/lib/unmanned-boat-web/accounts.json`，没有 `StateDirectory` 的旧更新部署为 `/var/lib/unmanned-boat-web-update/requests/accounts.json`。Windows 本机默认 `%APPDATA%\unmanned-boat-web\accounts.json`，其他 Linux 本机为 `${XDG_CONFIG_HOME:-~/.config}/unmanned-boat-web/accounts.json`。升级安装更新组件时会继续读取已有库。备份该文件并限制访问；库损坏或不可读时拒绝启动，不能自动回退到旧密码。`accounts-access.txt` 只记录首次安装的密码，网页改密后不会更新它。

**已安装旧版网页更新组件的服务器，在通过网页更改账号前，需要用本版源码重新安装一次可信组件**，否则旧健康检查还会尝试初始密码，日后更新可能失败回滚。在最新源码目录执行，替换为自己的域名与内部端口；Node 不在默认 PATH 时沿用原部署的 PATH：

~~~bash
sudo bash maintenance/install-update.sh https://boat.example.com 7890
~~~

这一步升级组件并重启网页，保留账户库、原 MQTT 配置及更新签名密钥。本版的首次安装脚本已使用新组件，无需再执行。普通网页更新继续只替换应用，不会自行覆盖 root 管理的更新组件。

云端调参仅限统一账户中的管理员；未启用账户的旧密码模式保持只读。每艘船的调参入口只操作指定设备，网页通过各船独立主题 ACL 进行读写，不会广播参数到其他船。独立“平台设置”用于管理平台用户、MQTT 船只接入账号和地图配置，无需连接船只。

### 对指定无人船调参

1. 使用管理员账户登录，在船队总览找到目标船卡片，核对 MQTT 设备 ID。
2. 点击该卡片的“调参设置”。网页自动选中这艘船，保持船队页面并打开参数弹窗；弹窗顶部显示当前调参对象。已选中船也可从“当前无人船”下拉中的调参入口进入。
3. 等待该船实时连接及固件参数能力就绪，再点击“读取参数”。仅打开弹窗不会发送参数请求；读取成功后才允许修改、写入或保存 Flash。
4. 修改表单后点击“写入参数”，等待这艘船的 STM32 确认。调试完成后显式点击“写入 Flash”；停机联锁仍由固件执行。
5. 调整另一艘船时关闭弹窗，点击另一张卡片的“调参设置”。旧船的确认值会清除，必须重新读取新船，不能沿用上一艘船的确认值直接写入。

离线船的调参按钮禁用，访客不显示调参入口；当前参数操作未结束时，不允许从船卡切换调参对象。三组浏览器预设仍是当前网站来源下共享的参数模板，执行“一键使用”前会重新读取目标船参数；它们不是各船自动同步的参数备份。

### MQTT 设备账号管理

这是无人船连接 MQTT Broker 使用的账号，与平台网页登录账号独立。仅用于本项目专用 Mosquitto；每艘船需要独立设备 ID、MQTT 用户名及密码，不可共用账号。设备离线也可维护。

1. 管理员登录后打开“平台设置 → MQTT 设备账号”，点击“重新读取设备”。新增设备时，选择“新增无人船”，设置独一无二的设备 ID 和用户名，并输入、确认新密码；用户名不能与其他船只或桥接账号重复，最多64艘。设备 ID/用户名只接受1～64位英文字母、数字、下划线或短横线。
2. 点击“添加无人船”并确认。服务端仅为该设备创建固定的5条自身主题 ACL，使用 root 私有临时文件生成密码哈希，通过可恢复事务更新配置并重启专用 Broker。已有设备和桥接账号保持不变；密码不回读、不写入网页存储。
3. 按页面提示将该船 `boat_network_local.h` 中的 `BOAT_MQTT_DEVICE_ID`、`BOAT_MQTT_USERNAME`、`BOAT_MQTT_PASSWORD` 分别设为新值，重新编译烧录。每艘船必须使用自己的设备 ID 与 MQTT 账号，不能复制另一艘船的三项配置。发送到 `boats/<设备ID>/...` 的遥测会自动进入船队列表。
4. 修改已有设备时，在列表中点击“修改账号”；设备 ID 和主题只读，用户名可修改。重设密码时填写两次新密码；允许8～64位可打印 ASCII，不能包含空白或冒号。两项留空则保留原密码哈希。改名或重设密码会使旧凭据失效，须同步 STM32 的用户名/密码并重烧录。操作无需设备在线。

配置保存在 `/etc/unmanned-boat-web/passwd` 和 `acl`，服务重启与网页更新后保留。`access.txt` 中原设备密码示例会移除，防止继续使用过期资料；新密码不会写回资料文件。保存失败会尝试恢复原文件并重启原配置；若网页响应超时，先重新读取并检查连接状态，再决定是否操作，接口不会自动重发。

#### 每船视频账号

在“平台设置 → 视频 MQTT 接入账号”区域，点击目标船的“配置视频账号”或“修改视频账号”即可维护视频发布凭据。视频账号与船端遥测账号、设备 ID、参数权限完全分开；它只获得 `boats/<设备ID>/video` 的写权限，不能读写该船的遥测、状态、校时或参数主题。

首次配置时填写视频 MQTT 用户名和密码，密码须为 6～64 位可打印 ASCII，不能含空白或冒号；用户名仍只允许 1～64 位字母、数字、下划线或短横线。保存前确认目标设备 ID，不能通过视频账号表单新增第二艘船，也不能把视频用户名当作设备 ID。保存成功后，发送端使用这里的用户名和密码发布 [视频接入教程](VIDEO_SETUP.md) 中的 `boats/<设备ID>/video` 主题。

修改已有视频账号时，用户名可以更换；密码框留空表示保留原密码哈希，网页不会回读、显示或导出密码。输入新密码才会替换旧哈希；保存新用户名或密码会使原视频凭据失效，但不改变船端遥测账号和设备 ID。网页只返回视频账号是否已配置、用户名和所属设备，不返回密码或密码哈希。

首次在已有服务器启用该面板前，先在部署源码目录执行一次：

~~~bash
sudo bash maintenance/install-mqtt-device-admin.sh
~~~

网页更新只替换应用文件，不会替换 root 管理的 MQTT 组件；更新组件后网页服务和 Broker 可能按安装脚本短暂重启。保存视频账号的实际配置变更会使专用 Broker 短暂重连，事务失败会恢复原密码、ACL 和 Broker 配置。若服务器仍使用旧版 root 组件，原有无人船账号的读取、创建和修改功能继续可用，但视频账号面板会提示管理组件未启用，不能借此修改视频凭据；重新运行上面的安装脚本后再使用。

视频账号接口只允许统一账户中的管理员同源调用。`GET /api/mqtt/devices` 的设备快照可附带 `canManageVideo` 和 `videos`；`videos` 只包含已配置视频账号的设备 ID/用户名摘要。对指定设备使用 `PATCH /api/mqtt/devices/<设备ID>/video`，请求包含视频 `username`、可选 `password` 以及读取时的 `revision`；省略密码保留原哈希。接口成功后返回最新快照及 `requiresReconnect`，不返回密码。旧 CLI 仍可作为服务器维护时的备用方式，见 [视频接入教程](VIDEO_SETUP.md) 的“旧 CLI 方式”一节。

**现有服务器添加新船前，先部署本版网页，再运行一次安装脚本更新受信任管理组件。** 这会启用 `POST /api/mqtt/devices` 新设备创建能力；单纯点击网页“更新”只更新应用，不能替换 root 管理的组件。在最新完整源码目录执行：

~~~bash
sudo bash maintenance/install-mqtt-device-admin.sh
~~~

若服务器只有已部署应用、没有完整源码目录，可以临时克隆独立仓库再执行：

~~~bash
source_dir="$(mktemp -d)"
git clone --depth 1 https://github.com/Coffeebean66/UnmannedBoat-Web.git "$source_dir/UnmannedBoat-Web"
sudo bash "$source_dir/UnmannedBoat-Web/maintenance/install-mqtt-device-admin.sh"
~~~

Node 不在 sudo 的 PATH 时，按原部署路径显式配置，例如 `sudo env PATH="/opt/unmanned-boat-node22/bin:$PATH" bash maintenance/install-mqtt-device-admin.sh`。脚本验证受管理的网页、Broker 和配置，安装时保留原凭据；它会重启网页服务。新的首次安装脚本自动完成这一步。Windows 本机或自行接入外部 Broker 时会显示管理组件未启用，继续使用原监测功能。

管理组件是 `/usr/local/lib/unmanned-boat-mqtt-admin` 下的 root 文件，通过组权限保护的 `/run/unmanned-boat-mqtt-admin/control.sock` 提供固定操作；网页进程不获取密码文件写权限。组件仅操作受管理配置和固定的 `unmanned-boat-mqtt.service`，不接受命令或任意文件路径。升级组件需由服务器管理员再次运行安装脚本。卸载脚本会停止组件并将其文件与服务配置放入恢复备份。

接口仅供已启用统一账户的管理员使用，响应禁止缓存：`GET /api/mqtt/devices` 获取 ID、用户名、版本及可选的 `canCreate` 能力；`POST /api/mqtt/devices` 携带新设备 `deviceId`、`username`、`password` 和读取时的 `revision`。已有设备通过 `PATCH /api/mqtt/devices/<设备ID>` 携带 `username`、可选 `password` 和版本更新。访客/未登录拒绝访问，写请求校验同源；配置已变化时返回冲突，要求先重新读取。

## 界面与导航

界面参考 seabot 的后台控制台，采用蓝色主色、中性色面板、细边框和圆角卡片。首次访问默认深色；右上角月亮/太阳按钮可切换浅色与深色，已保存的主题偏好继续生效，曲线背景、网格和线条同步切换。

桌面左侧保留船队及单船详情导航与 MQTT 连接摘要，顶部共用连接、账户、平台设置和更新入口，设备选择位于连接区。船队页面汇总所有设备并提供搜索/在线筛选，每艘船卡片提供独立调参入口；当前无人船下拉也可打开该船参数。概览集中展示当前船的六项航行指标、地图和姿态摘要，地图、三维姿态、曲线、双电机和通信诊断分别拥有专用页面。平台设置管理用户、MQTT设备账号与地图配置。手机端使用同步快捷导航，各页按屏宽排列。

- 电机卡片突出机械转速和 PWM，环形指示按 PWM 绝对值显示 0–100%，电压、电流、温度和功率并列；方向、容量等详细数据继续保留。
- 曲线下方分别展示目标、实际和误差；船速误差为实际减目标，航向误差为目标减实际的最短角差。过期读数显示 `--`。
- 底图就绪后直接显示地图，无需连接无人船或等待定位即可平移、缩放；初次未定位时只在角落显示小提示，定位后显示船位和分色轨迹，断流后标记变淡、保留历史路径以便查看。
- RTK 与 IMU 在同一面板显示，保留速度、经纬度、姿态、独立有效状态、序号与数据年龄。
- 实时监测面板左侧竖排显示 Roll / Pitch / Yaw（°），中央为天空/地面双色人工地平仪：固定机翼参考、外圈横滚刻度（10/20/30/45/60°）、随姿态移动的俯仰刻度（每5°一格、每10°标数）。Yaw 保留为数值，地平仪由 Roll / Pitch 驱动；右侧显示三轴角速度和 RTK 东/北速度，下方显示定位数据。
- 人工地平仪沿用船体 `X前/Y左/Z上`、`Rz(yaw) × Ry(pitch) × Rx(roll)` 坐标：Roll 正值为右倾，Pitch 正值为船头向下，刻度保留原始正负值，与三维船体姿态一致。欧拉角有效即可更新，无需角速度同时有效；过期/无效时冻结最后姿态并显示原因，断连或切换设备后清除。该二维仪表独立于三维动画开关，不启动连续动画循环。
- 点击船卡中的“调参设置”进入指定船的参数弹窗；设备参数分速度闭环 10 项、航向控制 7 项、其他参数 3 项。底部固定显示读取、写入与 Flash 按钮，滚动表单时仍可操作。管理员通过独立“平台设置”保存高德配置。
- 三组预设分别显示空槽/已保存和保存时间；成功、草稿待写入、设备拒绝/超时采用不同提示色，并保留文字说明。

使用本工程原生 HTML/CSS/JS 实现，没有引入 React、Tailwind 或 UI 框架依赖。图标为本地 SVG，不依赖在线字体。地图支持高德及未配置时的 OSM，深浅主题同步切换，轨迹与速度箭头保留原色；3D 水面保持独立渲染。船载视频通过每船 MQTT 地址接入真实媒体服务；任务、天气等未接入功能不作为模拟业务展示，航行实时数值仍来自已有设备遥测。

## 数据链路与时效

~~~text
上位机 RTK/IMU → STM32 USART3
                   └─ CN14 → 路由器 → MQTT Broker:1883 → Node桥接 → HTTPS/SSE → 浏览器监测
管理员设置 → HTTPS参数API → Node → MQTT参数命令 → STM32统一参数执行器
管理员设置 ← HTTP真实参数响应 ← Node ← MQTT参数响应 ← STM32
~~~

STM32 网口直接上报 MQTT Broker，Node 桥接校验后，浏览器通过认证的 HTTPS/SSE 会话接收实时数据。浏览器不直接连接 Broker，也不连接接收机。路由器可使用有线宽带或能提供互联网的 4G 网络，但固件未直接集成蜂窝模组拨号。

桥接订阅设备遥测、在线状态、参数能力和响应主题。旧遥测为176字节，新固件为192字节 `BTL1` 封装，其中16字节记录连接会话与发布tick，内部仍严格包含电机64、RTK40、船体36、IMU36四帧。后台逐帧校验版本、类型、长度和CRC16，移除外层封装后向浏览器发送原176字节，因此浏览器及UART4解析器继续使用原格式。传感器源年龄和有效位原样保留，收到新网络包不代表RTK/IMU本身有效。

不保存或重播缓存遥测，retained 遥测被丢弃；MQTT/SSE 恢复后只接收新的当前帧。网页校准服务器与浏览器时间差，约 1 秒无新包即清空实时读数并暂停姿态，服务端 3 秒无新遥测判设备离线；Broker 断开会立即使设备离线，保留的 `online` 状态不能单独使设备上线。已有轨迹保留，恢复后分段，不补画离线期间路径。这里没有历史数据库或离线轨迹回放。

### 延迟读数与升级顺序

| 读数 | 测量范围与含义 |
| --- | --- |
| 转发延迟 | Node后台收到并校验MQTT遥测，到浏览器接收该包；网页通过API请求中点估算与服务器的时钟差 |
| 船→云延迟 | STM32调用MQTT发布前，到Node后台收到该包；包含lwIP/TCP排队、船端网络、Broker转发和后台接收调度，依赖双向校时估计 |
| 合计延迟 | 同一包的船→云估计值 + 转发估计值；两项均有效时才显示 |

后台发现新固件的连接会话后自动发起校时，每台设备最多每5秒一次。设备回传接收与实际发送tick，后台扣除设备等待时间，保留最近30秒中网络往返耗时最小的校时样本，再将每包发送tick映射到服务器单调时钟。校时请求通过既有 `parameter-command` 主题发送，响应通过 `parameter-response` 返回，使用独立 `BTS1` 报文，不读取、修改参数，不消耗参数令牌，也不写Flash；不需要新增Broker主题权限。

两段读数都是估计值。校时假设网络上下行耗时接近；4G上下行不对称、排队与浏览器调度会产生误差。合计不含RTK/IMU采样、控制任务生成快照及页面绘制耗时，不能当作严格单向测量或Ping往返。校时未完成、样本超时、会话更换、断线、旧固件或异常时间数据均使上行及合计显示 `--`。

**先更新并重启网页后台，再烧录 `v2.27.0` 固件。** 新后台继续接受旧176字节报文，旧固件只缺少上行和合计读数。旧后台严格接受176字节，无法解析新固件192字节遥测。已有参数ACL继续适用；没有参数主题权限时可接收遥测，但校时无法完成。

| 环境 | 说明 |
| --- | --- |
| 桌面 Chrome / Edge / Firefox / Safari | 使用标准 HTTP/SSE 连接；需要可访问网页服务，三维姿态另需 WebGL |
| Android / iOS 浏览器、微信内置浏览器 | 无需设备通信权限；具体页面、SSE 与 WebGL 兼容性以实际浏览器版本为准 |
| http://localhost / http://127.0.0.1 | 可用于本机 Node 与 MQTT 桥接开发；仍需启用和配置 MQTT |
| 服务器域名 / 远程访问 | 使用受信任的 HTTPS，保持登录会话与 SSE 长连接可用 |

不要直接双击 public/index.html：监测、登录、配置与参数操作均依赖 Node 的同源 API。远程服务器应使用 HTTPS，并让代理保留 SSE 长连接。

## 当前功能

| 功能 | 网页行为 |
| --- | --- |
| 船队总览 | `#fleet` 同时汇总最多64艘已接入船只的在线状态、速度、航向、位置、电压与控制模式；支持按设备ID搜索、在线筛选并进入单船详情 |
| 船队看板 | 显示总船数、在线、离线和航行中统计；船队位置图使用稳定颜色标记有效定位，最近遥测按服务器收帧时间排序；卡片、地图标记和最近遥测行均可选择对应船只 |
| 工作台 | 船队总览加概览/地图/姿态/曲线/推进/诊断六个单船页面；选择船只后桌面侧栏将六个单船页面收纳到下拉菜单，手机导航继续提供快捷入口；支持地址直达、前进后退、深浅主题及320px以上屏宽；地图/船模共享实例，切页保留连接与采集数据 |
| MQTT 连接 | 统一账户登录、MQTT 设备选择、Broker/设备状态、断流清屏及恢复；总览摘要流与所选船详情流隔离，只保留云端链路 |
| 当前设备 | 所选船的船模缩略图、MQTT设备ID、连接状态、有效帧数、本地最近收帧时间、转发/船→云/合计延迟；切船清除旧统计 |
| 角色账户 | 管理员/访客统一用户名密码登录；访客只监测，管理员可调参与维护；退出、角色切换和会话过期撤销权限 |
| 用户管理 | 管理员在设置中新建用户、修改用户名/密码/角色；最多64人、至少一名管理员；服务器保存密码派生值，修改后目标账户旧会话撤销 |
| MQTT 设备账号 | 管理员可新增独立船只设备ID/用户名/密码，或修改已有设备账号；每艘船仅获自身主题权限，密码不回读；平台设置还可单独维护每船视频账号；独立组件持久化并重启Broker，需同步更新对应船端凭据 |
| 船载视频 | 每船 MQTT 视频地址、HLS/HTTP-FLV/原生媒体播放、接收时间与播放器状态；专用视频账号仅写所属船视频主题，媒体服务需自行准备 |
| 设置分离 | “平台设置”管理用户、船只MQTT账号和地图配置；每船卡片中的“调参设置”自动选中该船，只操作它的电控参数与Flash |
| 网页更新 | 管理员顶部“更新”入口、检查 main 提交、确认安装、跨服务重启查看进度、失败恢复旧版本；Linux 服务器首次需要安装可信更新组件 |
| 双电机 | 电压、电流、温度、机械/电气转速、PWM、方向、功率、容量、反馈年龄、序号 |
| 船体控制 | PWM/速度/角度模式、目标/实际/请求船速、方向、共同推进、差速、目标/实际航向及角差 |
| RTK | 东西/南北速度、合速度、经纬度、船头航向、定位状态、时间对齐、序号与年龄 |
| IMU | 三轴角速度、Roll/Pitch/Yaw、有效状态、航向新值/保持、序号与年龄 |
| 控制曲线 | 最近12秒船速/航向切换、目标/实际双线、清空；航向跨0°连续展开 |
| 地图轨迹 | 按钮切换高德/OSM并记住浏览器选择，保留视野和覆盖物；原始WGS84船位、高德显示转GCJ-02、跟随/回到船位、开始/停止/清除；0–3 m/s按每0.5 m/s分六色，速度无效灰色 |
| 闭环速度箭头 | 速度/角度模式显示目标橙色虚线、实际青绿色实线，箭头长度按同一比例表示速率；可一键隐藏/显示并保存偏好 |
| 轨迹容量 | 每秒最多一点、至少移动1米；最多1000点/64段；停追、无效定位或断流会断开线段 |
| 参数设置 | 每船管理员调参入口、明确设备ID的独立弹窗、切船需重读；速度/航向/其他三组共20项参数、固定操作栏、范围校验、说明与调参教程、2.5 m/s建议草稿 |
| 参数交互 | 经 MQTT 读取、临时写入、显式写入 Flash；云端读写等待5秒、Flash等待20秒，浏览器保留网络响应余量；以STM32响应确认结果 |
| 本地预设 | 三个共享模板槽，保存当前表单、一键使用；保存在当前浏览器的当前网站来源下，使用前重新读取目标船参数 |
| 导出 | 下载带中文注释的 .txt 或复制到剪贴板，可用于修改固件初始宏 |
| 3D姿态 | 本地GLB船模、动态水面、拖动视角、视角复位、偏航归零/恢复、模型重载 |
| 动画质量 | 动画/水面独立开关、低/中/高画质，限制像素倍率与刷新频率；偏好本地保存 |
| 节能和过期 | 3D离屏或网页后台停止绘制；关闭动画冻结画面，重新打开显示最新姿态；过期数据不显示为零 |

地图由独立的 `map-view.js` 统一管理。管理员在设置中保存配置，或服务器同时设置 `BOAT_AMAP_KEY` 和 `BOAT_AMAP_SECURITY_CODE` 时，加载高德官方 JS API 2.0；没有配置时使用本地 Leaflet 1.9.4 和在线 OpenStreetMap，并提示“高德未配置”。界面保存优先于环境变量，保存后刷新网页即可应用；修改环境变量仍需重启 Node。地图设置独立于船端参数和 Flash 保存，详见 [高德地图配置教程](AMAP_SETUP.md)。

船位、轨迹与箭头输入始终保存 WGS84，地图门面仅在高德显示入口统一转换为 GCJ-02；OSM 使用原始坐标。数值经纬度始终是 RTK 原值，不把偏移结果用于单片机控制。近似换算和底图精度不代表 RTK 精度。地图固定二维、北向朝上，支持缩放、跟随、回到船位及深浅主题。

地图底图的显示不依赖 RTK 定位或设备连接：首次打开时使用默认区域（约北纬 31.23°、东经 121.47°，缩放 5），可直接拖动和缩放；角落提示等待有效定位。收到有效定位且启用“跟随船位”后，地图转到无人船位置。手动拖动会取消跟随；定位过期或断连时继续保留地图视图和已有轨迹，不使用默认区域冒充船位。

配置请求、高德 SDK 或底图渲染初始化失败会显示原因，已配置的高德不会悄悄回退到另一坐标系；其他仪表仍可使用。高德收到 `complete` 才标记初始化完成，15 秒超时允许切换 OSM；后续地图资源被 CSP 拦截时显示警告，初始化完成不等于之后每个瓦片请求都会成功。真实联网验证与模拟 SDK 测试分别记录在下方。Leaflet 许可证随 `public/vendor/leaflet/LICENSE` 保存。

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

1. 用管理员账户登录，选择 MQTT 无人船并连接，点击“设置 → 读取参数”。
2. 修改后点击“写入参数”；收到设备成功响应才算生效。
3. “保存当前”保存表单到浏览器预设，包括未写入的草稿；“一键使用”发送预设并等待STM32确认。
4. 调好以后，将 CH6 切到低档，等待两路停稳且反馈正常满1秒，再点击“写入 Flash”。设备联锁由STM32执行。
5. 表单有尚未生效的修改时，网页会阻止直接写入 Flash。方向修改同样需要设备满足停机条件。
6. 导出文件标明“与最近一次设备响应一致”或“未写入草稿”；导出不证明Flash已经保存。

### 通过云端调参

1. 烧录新版 STM32 固件，网线接路由器，等待设备上传遥测和参数能力。仅升级网页无法让旧固件接收命令。
2. 用管理员登录，在 MQTT 设备列表中选择 `boat-01`，再连接无人船。
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

三个主题均以 `boats/<设备ID>/` 开头，QoS0且不保留。遥测内部原176字节和UART4 v5格式保留，新增16字节BTL1只作用于MQTT外层。自建服务器使用新版 `deploy-cloud.sh` 时，会为已受管理的设备/桥接账号补充上述精确ACL并备份原ACL、HUP重载Broker，保留原密码；BTS1复用这些既有权限。通过日常网页按钮只更新应用不会替代首次ACL配置。

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

默认仅监听127.0.0.1。Windows部署用于当前终端会话，运行前仍需配置 MQTT 连接环境变量。长期Windows服务器应保留 Node 服务，并用 IIS 等反向代理提供 HTTPS 和 SSE；仅托管 public/ 静态文件不能完成监测与调参。需要监听所有网卡时指定 -ListenAddress 0.0.0.0。

先在服务窗口按 Ctrl+C 停止，再双击 **remove.cmd**（删除默认部署），或者：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\remove.ps1 -TargetPath D:\services\UnmannedBoat_Web
# 确定不需要恢复副本时才永久删除：
powershell -NoProfile -ExecutionPolicy Bypass -File .\remove.ps1 -TargetPath D:\services\UnmannedBoat_Web -Purge
~~~

删除只接受部署脚本生成的、路径匹配的专用标记目录；拒绝源码目录、祖先目录、系统/磁盘根目录和符号链接。默认将部署目录改名为“原目录.removed-时间戳”，改回原名即可恢复；-Purge 才是永久删除。不会删除小程序、STM32源码、Node.js或浏览器预设。Windows删除/升级会查询部署的Node进程，若仍运行则要求先停止，不结束无关进程。

## 一键部署 / 卸载：Linux

空白服务器推荐使用本文开头的[首次安装指令](#linux-首次部署一条指令)，自动完成依赖、账户及 HTTPS。以下是已准备好运行环境后的分步部署方式。

适用：使用 **systemd** 的 Linux（如 Ubuntu/Debian），有 sudo 权限，已安装系统级 Node.js 18+ 和 npm（建议 Node 22/24 LTS）。部署脚本用 `npm ci --omit=dev --ignore-scripts` 安装锁定的运行依赖，不使用 Docker。不要使用仅 root 可访问的 `/root/.nvm` Node 路径，Web 服务使用动态非特权用户运行。

从 GitHub 克隆，或将本文件夹传到服务器源码目录，例如 ~/UnmannedBoat_Web：

~~~bash
git clone https://github.com/Coffeebean66/UnmannedBoat-Web.git ~/UnmannedBoat_Web
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
| `/etc/unmanned-boat-web/accounts.env` | 初始管理员/访客及统一认证开关；独立账户库存在后，不覆盖已保存的用户 |
| `/etc/unmanned-boat-web/accounts-access.txt` | 首次启用账户时的私密登录资料，网页改密后不会更新，root 专用，勿公开 |
| `/var/lib/unmanned-boat-web/accounts.json` | 新装服务的持久化用户库，保存盐化密码派生值；旧更新部署可能在 requests 目录，详见用户管理说明 |
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

未设置 `BOAT_CLOUD_ENABLED=1` 时不连接 Broker，网页显示“服务器尚未启用 MQTT 云端监测”，不能接收遥测或操作设备参数。开启后还需配置可访问的 Broker 与匹配的桥接账号。公网 MQTT `1883` 使用普通 TCP，网页 HTTPS 只保护浏览器到网站的链路；当前固件无法通过改成 `8883` 自动启用 TLS。网页提供监测和参数操作，没有远程驾驶接口。

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

默认停止/禁用 Web 和本项目独立 Broker 服务，将部署目录、云端配置及服务单元移到 root 专用的恢复目录；恢复时按脚本提示放回原路径并重新启用服务。保留源码、Node、Mosquitto 软件包、Broker 持久化数据、Nginx和其他站点。`--purge` 才永久删除经过标记校验的应用和云端配置目录，包括其中的初始账号资料；自行添加的 HTTPS 代理配置需单独管理。

独立的 `/var/lib/unmanned-boat-web` 地图设置与账户库会保留；旧部署位于更新组件 `requests` 中的账户库随更新状态移入恢复副本。`--purge` 同样保留这些数据，不能用它重置网页用户。

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

本版前端必须能访问 Node 的 `/api/auth/config` 与 `/api/cloud/`：账户配置未知时禁用监测连接和管理操作，单独上传 `public/` 的纯静态站点不能使用完整功能。本机开发也需启动 Node 并配置 MQTT；未启用统一账户时，旧云端访问密码模式只支持监测。GLB 模型按二进制提供，JS/CSS 的 MIME 类型需正确。Node 静态资源仅允许 GET/HEAD，登录为 POST、退出为 DELETE；未知资源返回 404，阻止目录穿越和跨根目录符号链接。

### 云端接口

启用账户模式时，登录/退出统一使用 `/api/auth/`；旧云端密码和更新密码登录接口返回 403。

| 路径 | 方法与返回 |
| --- | --- |
| `/api/auth/config` | GET，`enabled`、`requiresLogin`、当前 `{username,role}` 或 null；不返回密码 |
| `/api/auth/login` | POST JSON `{username,password}`，同源登录并设置全站会话 Cookie |
| `/api/auth/session` | DELETE，同源退出，撤销共享会话并关闭其 SSE |
| `/api/auth/users` | GET，管理员读取 `{users:[{id,username,role}],currentUserId}`；POST 同源 JSON `{username,password,role}` 新建用户，成功返回 201 |
| `/api/auth/users/<id>` | PATCH，管理员同源 JSON `{username,role,password?}`；省略密码可保留原密码，返回 `reauthenticate` 表示当前用户是否需要重新登录 |
| `/api/map/config` | GET/HEAD，浏览器地图配置；只返回 Web端 Key、安全密钥及启用状态，不接受写入 |
| `/api/map/settings` | GET/PUT，需启用账户并登录管理员；PUT 同源 JSON `{key,securityJsCode}`，两项为 32 位十六进制或同时为空；成功后配置持久化并供刷新后的地图使用 |
| `/api/mqtt/devices` | GET，仅管理员；返回 `{enabled,devices:[{deviceId,username}],revision,canCreate?,canManageVideo?,videos:[{deviceId,username}]}`，管理组件未启用时返回 `{enabled:false,reason}`；POST 同源管理员 JSON `{deviceId,username,password,revision}` 可新增一船，成功返回设备列表、版本与 Broker 重连状态；不返回密码 |
| `/api/mqtt/devices/<设备ID>` | PATCH，仅管理员同源；JSON `{username,password?,revision}`，成功返回最新设备列表、配置版本及 `requiresReconnect`，不接受设备 ID 变更 |
| `/api/mqtt/devices/<设备ID>/video` | PATCH，仅管理员同源；JSON `{username,password?,revision}`，首次配置密码需6～64位可打印 ASCII，省略密码保留原哈希；仅维护该船 `video` 写权限，成功返回视频账号摘要、最新快照及 `requiresReconnect`，不返回密码 |
| `/api/cloud/config` | GET，`enabled`、`requiresLogin`、`serverTime`；无需登录 |
| `/api/cloud/login` | 仅旧部署：POST JSON `{password}`，要求同源 |
| `/api/cloud/session` | 仅旧部署：DELETE，退出旧云端会话，要求同源 |
| `/api/cloud/devices` | GET，需登录；`brokerConnected`、设备列表和 `serverTime` |
| `/api/cloud/fleet` | GET，需登录；船队总览的设备摘要快照，源测量 `validUntil` 分别给出服务端毫秒失效时间 |
| `/api/cloud/fleet/events` | GET，需登录；SSE `fleet` / `fleet-device` 更新最多64艘设备的安全摘要；与单船详情流共用 SSE 客户端上限 |
| `/api/cloud/parameters` | POST JSON `{deviceId,kind:"read"\|"write"\|"flash",values?}`；仅管理员同源；成功 HTTP 响应 `{frame:原56字节Base64,serverTime}`，设备拒绝状态仍在帧内 |
| `/api/cloud/events?device=boat-01` | GET，需登录；SSE `state` 和 `telemetry`，遥测含 `deviceId`、`receivedAt`、原始 payload 的 Base64 与 `ageMs:0` |

`telemetry` 在上行校时有效时另带 `uplinkDelayMs`、`uplinkRttMs`、`uplinkUncertaintyMs`，单位毫秒；未知时省略。`receivedAt` 始终是Node收到遥测的时间，`ageMs`保持原语义。校时响应不会延长设备在线时间或传感器有效期。报文实现见 [latency-protocol.js](server/latency-protocol.js)：BTL1为magic4 + 会话8 + 发送tick4 + 原176字节；BTS1请求为magic4 + 会话8 + 挑战8，响应再追加接收/发送tick各4字节，整数均为小端。

设备条目包含 `id`、`online`、`lastReceivedAt`、`status`、`lastStatusAt` 和 `video`。`video` 为平铺对象 `{version,url,format,title,receivedAt,retained}`，未设置或禁用时为 `null`；随单船 `state` 更新，不增加独立视频 SSE。视频消息不延长设备在线时间，保留地址不代表画面在线。格式及权限说明见 [视频接入教程](VIDEO_SETUP.md)。服务端限制 64 台记录设备、128 个会话、64 个 SSE 连接且每会话至多 4 个，登录每 IP 每分钟最多 8 次；慢客户端发生背压时断开，避免无限队列。网页会自动恢复实时通道，恢复不会重播旧帧。

## 代码与验证

2026-10-27 09:09:08 +08:00，Web `v1.25.0` 源码发布：将管理员按船配置、改名和修改视频 MQTT 接入密码的功能发布至 [Coffeebean66/UnmannedBoat-Web main](https://github.com/Coffeebean66/UnmannedBoat-Web/tree/main)，同步修正视频账号设置入口说明。发布前构建、完整 Node 回归386项及 Chrome 视频专项通过，主监控烟测通过。仅发布独立 Web 仓库，不同步主仓库，未部署服务器或创建生产视频账号；私密配置、账号资料、依赖与本机测试/部署产物不上传。

2026-10-26 21:23:18 +08:00，Web `v1.25.0` / 配套主项目版本仍为 `v2.34.0`：新增管理员在“平台设置 → MQTT 设备接入 → 视频账号”中按船设置、改名和保留/重设视频 MQTT 密码的入口；视频凭据只获得所属船 `video` 主题写权限，不改变遥测账号或设备 ID。设备快照增加 `canManageVideo`/`videos` 摘要，新增 `/api/mqtt/devices/<设备ID>/video` 管理接口；保存时 Broker 短暂重连，事务失败回滚。已有服务器需重新运行 root 管理组件安装脚本，网页更新不会替换该组件；旧组件继续支持原设备账号但禁用视频管理。旧 CLI 方式保留。`npm.cmd run build`、视频管理/API/协议/云端及现有船队导航相关 Node 检查通过，Chrome 主监控烟测通过（含8个工作页、320～1920px布局）；尚未上传、部署或创建生产视频账号，未读取实船/私密配置。

2026-10-26 20:55:17 +08:00，Web `v1.24.0` 源码发布：将每船独立调参入口、单船视频地址接入与播放器、专用视频账号配置脚本及接入教程发布至 [Coffeebean66/UnmannedBoat-Web main](https://github.com/Coffeebean66/UnmannedBoat-Web/tree/main)。沿用下方本轮构建、Node 与 Chrome 验证结果；本次仅发布独立网页仓库，不同步主仓库，未部署服务器，也未创建生产视频账号。私密配置、账号资料及 `.test-output/` 等本机临时产物不进入发布。

2026-10-26 20:29:14 +08:00，Web `v1.24.0` / 项目 `v2.34.0`：新增按船接收 MQTT 视频地址与 `#video` 播放页面，支持 HLS、HTTP-FLV 和浏览器原生 HTTP(S) 媒体；地址、播放状态与电控遥测在线状态独立。新增受限视频发布账号配置脚本、Broker 限制升级及事务回滚、精确媒体来源 CSP 配置和 [VIDEO_SETUP.md](VIDEO_SETUP.md)。视频订阅独立处理，旧 Broker 拒绝视频主题时不影响原遥测、调参或更新健康检查。`npm.cmd run build`、369项全量 Node 检查及最终36项相关复核、Chrome 主烟测、船队、云端调参和视频专项全部通过。视频专项通过真实本机 HTTP/SSE 接收模拟 MQTT 地址，并使用 ffmpeg 生成的 MP4、HLS 和 HTTP-FLV 实际解码播放，验证多船隔离、访客观看、重复地址不重建、停止/重连/切船/导航/退出释放、未授权来源不发媒体请求、错误与清空恢复；播放器单测另覆盖隐藏页面释放及旧播放器回调隔离。监控回归覆盖320～1920px，视频覆盖1440/375/320px深浅主题，已查看桌面和320px截图。尚未连接真实摄像头、实船或生产 Broker；源码已于 `2026-10-26` 发布至独立网页仓库 `main`，本次主仓库不同步，未部署服务器，也未创建生产视频账号。

2026-10-26 20:04:57 +08:00，Web `v1.23.0` / 项目 `v2.33.0`：将管理员调参入口放入每艘船卡片，点击后自动选择该船并保持船队页面，当前无人船下拉保留该船入口；移除顶部和底部全局调参按钮。参数仍仅在点击“读取参数”后请求，读取、写入与 Flash 按设备隔离，切船须重读；旧请求的迟到错误不能恢复新船草稿；增加离线、访客和忙态入口限制，保留三组共享浏览器预设模板。`npm.cmd run build`、47项相关 Node 检查及 Chrome 主烟测、船队、账户、云端参数专项通过，覆盖三船并行、两船分别读取/写入/Flash、快速选船、打开不自动读取、草稿隔离和权限限制，以及320～1920px深浅布局。验证使用本机服务与模拟船端，未连接实船；本版尚未上传或部署服务器。

2026-10-26 19:42:14 +08:00，Web `v1.22.0` / 项目 `v2.32.0` 源码发布：将累计多船实时总览、船队地图与最近遥测、单船数据/参数隔离、平台设置与调参设置分离、独立 MQTT 设备账号创建、seabot 风格后台界面及选船下拉导航同步至 [Coffeebean66/UnmannedBoat main](https://github.com/Coffeebean66/UnmannedBoat/tree/main) 和 [Coffeebean66/UnmannedBoat-Web main](https://github.com/Coffeebean66/UnmannedBoat-Web/tree/main)。沿用下方已完成的本机构建、Node 与 Chrome 验证；本次仅发布源码，未部署服务器或烧录开发板。本机固件私密网络配置、私密环境变量、账号资料及构建/测试产物不上传；旧版本记录保留开发当时状态。

2026-10-25 20:48:22 +08:00，Web `v1.22.0` / 项目 `v2.32.0`：参考 seabot/Art Design Pro 统一后台控制台布局、统计卡片、蓝色选中态和深浅主题，增加页面面包屑；保留选船下拉导航并修复遥测更新重新展开菜单的问题。`npm.cmd run build` 通过；Node 回归300项通过（含7项导航测试，不含部署/Linux安装测试）；Chrome 主烟测、船队、账户管理和 MQTT 设备设置专项通过，覆盖7个独立工作页、320～1920px、深浅主题，以及参数/MQTT/地图/IMU。未连接实船或部署生产服务器；源码于 `2026-10-26` 发布，详见上方发布记录。

2026-10-25 18:04:04 +08:00，Web `v1.21.0` / 项目 `v2.31.0`：选择无人船后，将桌面侧栏的六个单船页面收纳到可展开下拉菜单，保留原有 URL、选中状态、键盘访问和手机快捷导航；未选择船只时自动隐藏，返回船队总览时收起。`npm.cmd run build`、15项相关 Node 测试、Chrome 主烟测及 Chrome 船队专项通过；完整337项 Node 回归属于下方 v1.20.0 的历史验证结果。当前未部署真实 Mosquitto、实船或生产服务器，本版尚未上传或部署。

2026-10-25 17:09:12 +08:00，Web `v1.20.0` / 项目 `v2.30.0`：按参考界面优化船队运营看板，加入在线/离线/航行统计、双列船卡、有效定位地图、稳定颜色图例和最近遥测；卡片、地图标记及最近遥测均可进入对应单船详情。补充三船地图标记和 Leaflet 标记点击的 Chrome 断言。`npm.cmd run build`、完整 Node 回归337项、账户/地图/船队专项25项、Chrome 主烟测及 Chrome 船队专项全部通过；当前未部署真实 Mosquitto、实船或生产服务器，本版尚未上传或部署。

2026-10-25 16:27:39 +08:00，Web `v1.19.0` / 项目 `v2.29.0`：新增最多64艘船的实时摘要总览、设备筛选和单船详情选择；新增船只 MQTT 账号创建与主题 ACL 隔离；平台设置与单船调参设置分离。船队摘要不转发其他船的原始遥测，参数命令仍只发往当前选中的设备，固件及176字节遥测协议不变。`npm.cmd run build` 通过；完整 Node 回归330项中328项通过，2项 Linux 部署脚本集成测试在 Windows Bash 运行器达到20秒超时，未完成。Chrome 主烟测、账户管理、三船并行/详情隔离及设备账号创建专项通过，覆盖分项数据过期/断线恢复、权限、设置分离和320～1920px布局。当前未部署真实 Mosquitto、实船或生产服务器，本版尚未上传或部署。

2026-10-25 15:26:23 +08:00，Web `v1.18.0`：工具包构建、完整293项Node串行回归通过，零失败、零跳过；安装状态误报修正后的补充测试单独通过。新增覆盖管理员/访客/未登录与同源权限、密码不回传、版本冲突、超时不重发、退出后迟到请求隔离，以及真实本机HTTP→Unix socket/Windows命名管道→worker→文件的改名持久化。管理组件验证哈希/桥接账号保留、私有文件哈希工具参数、ACL限制、并发锁、事务失败回滚与进程中断恢复；安装/重装/卸载事务在隔离目录验证，包含“socket正常、网页失败”不能误报安装成功。

Chrome MQTT 设备设置专项与完整监控烟测通过：实际本机账户/API、离线设备改名、保留/重设密码、原生确认框、冲突/缺组件、访客403、关闭/切身份清理和320～1920px深浅布局；已目视桌面与320px截图。浏览器模拟管理端和Linux脚本适配器没有操作生产服务；当前Windows环境未安装真实Mosquitto，尚未在真实Linux/systemd上执行设备凭据轮换。本版源码于2026-10-25发布，本次未部署或改写任何实船配置。

2026-10-25 11:51:17 +08:00，Web `v1.17.0`：工具包生成、完整251项Node串行检查（零失败/跳过）、脚本语法及差异检查通过。新专项覆盖BTL1/BTS1精确格式、旧176兼容、单调校时、设备等待扣除、最低RTT/30秒过期、tick回绕、设备/会话/挑战隔离、retained拒绝、断线和迟到回调，以及参数事务独立性；真实C编码向量经后台解包和计算兼容检查通过。

完整Chrome监控烟测及延迟设备卡专项通过，覆盖原地图/三维/参数/Flash/预设/账户与六页导航，以及新增上行/合计、旧固件未知、非法值、断开/切船清理；320～1920px布局通过，手机“通信诊断”可查看延迟，已查看桌面和320px浅色截图。测试使用真实本机HTTP/SSE与模拟元数据，地图网络隔离；未连接生产Broker或实船，不代表真实网络单向计时精度。固件Debug/Release与完整宿主回归通过，尚未烧录；本轮源码未上传或部署。

2026-10-25 10:49:32 +08:00，Web `v1.16.0`：工具包生成、完整239项Node串行检查及脚本语法、差异检查通过，零失败、零跳过。覆盖新建用户、用户名/密码/角色修改、至少一名管理员、64用户上限、盐化账户库与重启保留、失败与并发写入、会话撤销、访客拒绝、前端超时/迟到响应和旧更新组件兼容。

Chrome用户管理专项通过：使用真实本机认证、持久化账户库及HTTP/SSE，验证新建管理员/访客、确认密码错误不提交、修改他人不重连当前监测、自改后撤销会话并重新登录、旧密码拒绝与新密码可用、新用户刷新后登录及访客403；1440/375/320px深浅布局无横向溢出，已查看桌面和手机截图，并修正本面板浅色按钮文字对比度。地图请求隔离，Linux安装/更新使用隔离替身，未连接生产Broker或实船。源码发布单独记录，现有服务器未部署本版。

2026-10-24 20:39:38 +08:00，Web `v1.15.0`：工具包生成、16项版本/账户/核心检查、Bash语法与差异检查通过。新增首次安装器9项隔离分支分别通过，覆盖参数/端口/已有安装冲突、完整安装配置与随机账户、Node归档下载和真实SHA256校验、坏校验阻止解压/部署、私有目录Node拒绝及证书失败后保留凭据。测试中的apt、Git下载、systemd、Nginx与Certbot均为隔离替身；未在全新Linux实机执行安装或真实申请证书。上一版仅MQTT功能的199项及六类浏览器结果见下方；本次同时发布这些源码，未重部署现有服务器。

2026-10-24 19:54:11 +08:00，Web `v1.14.0`：完整199项Node串行检查、脚本语法与差异检查通过；Chrome监控烟测、账户、云端参数、设备卡片、高德地图及地图设置六类检查通过。覆盖没有 `navigator.bluetooth` 时登录和连接、六页切换保留连接、完整176字节遥测、断流重连、参数读写/Flash/超时、管理员与访客权限、地图切换与Key配置持久化，以及320～1920px布局；已查看桌面、手机及设置截图。

浏览器通过真实本机账户API、HTTP/SSE和参数接口接收模拟船端数据；未连接生产Broker或实船。高德使用隔离的模拟SDK，真实OSM瓦片被屏蔽，结果不代表在线地图鉴权或真实底图验证。本轮没有上传GitHub或部署服务器。

~~~text
UnmannedBoat_Web/
├── server.js                  静态服务、TLS、健康检查与云端入口
├── server/cloud.js            MQTT遥测桥接与参数事务、在线状态和能力检查
├── server/latency-protocol.js  BTL1解包、BTS1校时、上行耗时估计与失效清理
├── server/video-protocol.js    按船校验视频地址、格式和停用消息
├── server/parameter-protocol.js BPC1信封、20项范围与响应校验
├── server/cloud-api.js        同源登录、会话、设备列表和SSE
├── server/account-api.js      统一管理员/访客登录、共享会话与角色授权
├── server/account-store.js    独立账户库、scrypt密码派生与原子保存
├── server/update-api.js       管理员授权、固定仓库检查、任务和只读进度票据
├── server/map-config.js       高德配置读取、管理员保存、持久化与地图资源 CSP
├── AMAP_SETUP.md              高德 Key 申请及本机/systemd 配置教程
├── VIDEO_SETUP.md             视频主题、专用账号、媒体来源及发布教程
├── .env.example               地图环境变量模板（不会自动载入）
├── maintenance/               首次安装脚本、可信更新worker及候选版本预检
│   └── configure-video-access.cjs  root命令行配置受限视频发布账号与Broker限制
├── package-lock.json          MQTT与浏览器播放器依赖锁定
├── public/
│   ├── index.html             监控页和设置弹窗
│   ├── account-auth.js        统一登录、角色权限、退出与会话刷新
│   ├── user-management.js / .css 管理员用户列表、新建/改名/改密及角色管理
│   ├── app.js                 遥测、曲线、地图、轨迹
│   ├── ui.js                  SVG图标、主题偏好、时钟及设置弹窗交互
│   ├── workspace-navigation.js 船队与七个单船页面导航、URL/历史及共享面板管理
│   ├── workspace.css          专用页面尺寸、布局及手机适配
│   ├── map-velocity-view.js   地图速度箭头SVG与船位跟随
│   ├── map-view.js / .css     高德/OSM地图门面、坐标投影和缩放控件
│   ├── map-settings.js / .css 管理员地图表单、独立保存与刷新应用
│   ├── styles.css / ui.css    通用主题、组件和参数弹窗
│   ├── dashboard.css          地图主屏基础布局与响应式适配
│   ├── console.css            seabot 风格后台控制台、面包屑及深浅主题
│   ├── cloud-transport.js     MQTT云端会话/SSE、时效和管理员参数事务
│   ├── fleet-transport.js     船队摘要SSE、设备列表和认证状态同步
│   ├── fleet-view.js          船队筛选、在线摘要、设备卡片和单船选择
│   ├── fleet.css              船队卡片、计数与响应式样式
│   ├── settings-layout.css    平台设置与单船调参设置布局
│   ├── update-panel.js        更新登录、提交确认、重启轮询和结果提示
│   ├── parameter-panel.js     参数、预设、导出
│   ├── video-view.js / video.css 按船播放、状态提示及播放器生命周期管理
│   ├── attitude-view.js       3D姿态、画质、动画调度
│   ├── artificial-horizon.js / .css  IMU 圆形人工地平仪、左右布局及无效状态
│   ├── parameter-data.js      20项参数及说明快照
│   ├── utils/                 小程序工具快照、WGS84轨迹及地图速度矢量计算
│   ├── utils-bundle.js        浏览器工具包
│   ├── assets/boat_mobile.glb 船体模型
│   ├── assets/boat-preview.png 设备卡片静态船模缩略图
│   └── vendor/leaflet/        地图库和许可证
├── build-bundle.js            工具包生成/可选同步小程序
├── install-linux.sh           首次安装依赖、MQTT、账户、HTTPS和网页更新
├── start-local.cmd/.ps1       前台本机启动
├── deploy.cmd/.ps1/.sh        Windows复制 / Linux systemd部署
├── deploy-cloud.sh            独立认证Broker、私有配置与Web云端部署
├── remove.cmd/.ps1/.sh        带目录校验的移除/卸载
└── tests/                    协议、服务器和Chrome本机MQTT桥接检查
~~~

首次运行先执行 `npm ci --omit=dev` 和 `npm run build`，准备锁定依赖及浏览器播放器资源。修改 public/utils/ 后也执行 npm run build。如需重新同步旁边的小程序，执行 node build-bundle.js --sync：覆盖网页工具、模型、参数说明快照，再添加WGS84投影适配，不修改小程序。

~~~bash
npm test
npm run test:browser
npm run test:amap:browser
node tests/update-browser.cjs
node tests/accounts-browser.cjs
node tests/user-management-browser.cjs
node tests/cloud-parameters-browser.cjs
node tests/device-card-browser.cjs
~~~

浏览器检查要求Node 22+及Chrome。Windows默认Chrome路径为 C:\Program Files\Google\Chrome\Application\chrome.exe，其他路径通过 CHROME_PATH 指定。测试启动临时本机服务和无界面Chrome，以内存设备通过 HTTP/SSE 模拟 MQTT 桥接，完成后关闭，不连接生产无人船。截图、临时配置及测试部署保存在已忽略的 .test-output/。下方较早版本的测试和修改记录保留当时的功能与验证范围。

2026-10-24 19:25:43 +08:00 独立页面验证：31 项相关 Node 检查、脚本语法检查、完整 `node tests/browser-smoke.cjs` 及 `node tests/amap-browser.cjs --map-only` 通过。覆盖六页互斥、地址直达、前进后退、直接刷新 `#navigation` 后仍位于页面顶部、非法片段回退、键盘焦点、导航高亮、地图/三维/解析器/轨迹实例保留及 BLE 连接不重建；检查地图尺寸恢复、曲线继续采集、隐藏三维停止与返回恢复，原遥测/调参/预设/主题功能正常。320/375/640/768/1024/1440/1920px 布局通过，已目视六个桌面页和深浅主题/手机截图；修正窄屏三维画幅过高造成的船体裁切，最终复跑确认 320/375px 整船完整显示。高德使用模拟 SDK 验证同一地图/轨迹实例及既有地图切换、错误、超时流程；尚未上传或部署。

2026-10-23 22:20:45 +08:00 设备卡片验证：28 项相关 Node 检查、脚本语法检查、完整 `node tests/browser-smoke.cjs` 和本机 `node tests/device-card-browser.cjs` 通过。覆盖 BLE 名称及 MQTT 设备 ID、64 字符名称换行、有效帧计数、最近更新时间、校时后的转发延迟及未知值、断开保留更新时间、切船清除旧统计和旧连接数据隔离；本机云端测试使用内存设备与真实 HTTP 登录/SSE，不连接生产 MQTT。原监测/调参/地图/姿态流程及 320/375/640/768/1024/1440/1920px 布局通过，已查看深浅主题、长 ID 及桌面卡片截图；测试取样先同步刷新 UI，避免 200ms 渲染周期造成时间断言竞争。尚未上传或部署。

2026-10-23 21:37:51 +08:00 RTK/IMU 同屏验证：32 项相关 Node 检查、前端脚本语法检查及完整 `node tests/browser-smoke.cjs` 通过。覆盖两类数据同时可见、姿态/角速度独立有效、欧拉角失效/过期保持和断开复位，以及原蓝牙、参数、Flash、预设、轨迹、速度箭头、地图、主题和动画功能。320/375/640/768/1024/1440/1920px 无横向溢出，320/375px 的极值角度和单位可完整显示；已查看桌面深浅主题和手机合并面板截图。修正窄屏容器收缩，并将 620px 及以下的右侧面板改为单列排列；本轮未联调真实传感器，未上传或部署。

2026-10-23 17:44:55 +08:00 高德空白修复验证：浏览器工具包构建、71 项相关 Node 检查、完整 Chrome 监控烟测和 `node tests/amap-browser.cjs --map-only` 通过。覆盖地图延迟完成、15 秒超时、错误、销毁、切换失败回滚、偏好保存时机及 CSP 警告；原蓝牙/参数/Flash/预设/轨迹/箭头/IMU/动画及 320～1920px 布局通过。

另在本机真实 Chrome 中，仅将线上页面的响应头和地图/应用脚本替换成本地修复，使用真实官方 SDK 和地图请求验证：无定位时默认区域可见，放大至上海 zoom11 可见街道，地图 `complete` 约 8.2 秒到达；最终 CSP 违规、网络失败、JavaScript 异常及 WebGL 错误均为 0，已目视默认区域及街区截图。未绕过 CSP、未修改线上配置或发送设备命令；本机响应替换的实测不代表线上已经修复。本轮尚未上传 GitHub 或部署。

2026-10-23 16:57:37 +08:00 主动切换地图验证：构建、65 项相关 Node 检查、完整 Chrome 监控烟测及 `node tests/amap-browser.cjs --map-only` 通过；最后更新设置提示和页面版本后，21 项相关账户/设置界面检查通过。覆盖高德↔OSM、船位透明度/分色轨迹/箭头保留、手动平移与缩放保留、刷新记忆、加载失败保留旧地图并可重试、无 Key 提示、初始配置/SDK失败后主动恢复OSM，以及320/375/1440px按钮布局；查看手机截图。烟测过期断言改为等待实际状态，避免1秒超时与200ms渲染周期竞争。高德仍为模拟SDK，未使用真实Key验证在线底图；未上传/部署。

2026-10-23 13:18:26 +08:00 无定位底图验证：18 项账户界面/地图门面 Node 检查、完整 `node tests/browser-smoke.cjs` 和 `node tests/amap-browser.cjs --map-only` 通过。覆盖首次无设备/无定位时底图无遮罩、角落提示不挡手势、无虚假船位/箭头、平移和缩放、无效 RTK 帧、有效定位恢复、过期/断开保留视图和轨迹，以及加载失败继续显示错误。原监控与参数功能、320～1920px 布局通过，已查看等待态截图。本轮仍隔离在线瓦片并模拟高德 SDK，未增加真实底图网络验证；未上传/部署。

2026-10-23 13:08:57 +08:00 管理员地图设置验证：构建及完整 `node --test --test-concurrency=1 tests/*.test.cjs` 共 184 项全部通过，包含 9 项新增 HTTP/持久化测试和 10 项界面状态测试；部署升级/回滚、账户/云端/更新等既有回归通过。原 Chrome 完整烟测及完整高德浏览器专项通过，覆盖无船读取/保存、非法输入拦截、保存失败不误报、显式刷新应用、保存不中断遥测、访客拒绝、重启保留和未启用账户提示。1440/320px 管理设置截图已目视确认，原监控页 320～1920px 无横向溢出。高德 SDK 使用模拟接口，真实 Key 的鉴权及底图仍需联网验证；未部署或推送。

2026-10-23 12:46:46 +08:00 高德接入验证：`npm run build`、12 项地图门面/配置单测、原 Chrome 完整烟测及 `npm run test:amap:browser` 通过。覆盖无 Key 的 OSM 提示、安全密钥先于 SDK 注入、WGS84 原值保留、船位/轨迹/箭头统一转换一次、跟随/缩放/平移、主题、隐藏偏好、过期数据及配置/SDK 失败隔离；桌面和手机截图已目视检查。高德专项在真实 Chrome 中拦截 SDK 请求并模拟公开接口，画面标注“模拟测试 · 非真实底图”，未使用真实 Key，不能替代高德鉴权与在线底图验证。

Node 全套串行首轮共 165 项、163 项通过：旧账户界面测试仍断言历史版本号，已改为读取包版本，相关 16 项复核通过；Windows Git Bash 下 Linux 启动失败回滚模拟首次超过 20 秒限时，单项复跑通过。本轮未改部署脚本，未上传 GitHub 或修改线上服务。

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
| 2026-10-27 09:09:08 +08:00 | v1.25.0，源码发布 | 将管理员按船配置视频 MQTT 用户名和密码的功能发布至独立 `UnmannedBoat-Web` 仓库 `main`；修正教程入口，构建和386项 Node 回归及 Chrome 视频专项通过；不同步主仓库，未部署服务器或创建生产视频账号 |
| 2026-10-26 21:23:18 +08:00 | v1.25.0，项目v2.34.0 | 管理员可在平台设置按船维护视频 MQTT 用户名和密码：首次密码6～64位ASCII，已有账号可改名并留空密码保留哈希；仅授予所属 `video` 主题写权限，不改变遥测账号/设备ID；新增视频账号 API、快照摘要及 root 管理组件升级提示；本地修改，尚未上传、部署或创建生产视频账号 |
| 2026-10-26 20:55:17 +08:00 | v1.24.0，源码发布 | 将每船独立调参入口、MQTT 视频地址接入与播放、视频账号配置脚本及接入教程发布至 `Coffeebean66/UnmannedBoat-Web` 的 `main`；本次不同步主仓库，未部署服务器，也未创建生产视频账号 |
| 2026-10-26 20:29:14 +08:00 | v1.24.0，项目v2.34.0 | 新增单船视频页及 MQTT 视频地址协议，支持 HLS/HTTP-FLV/原生媒体；切船、退出和隐藏页面释放播放器；专用发布账号及主题隔离、Broker 限制升级与回滚、媒体来源 CSP 和接入教程；源码于2026-10-26发布至独立网页仓库main，本次主仓库不同步，未部署服务器或创建生产视频账号 |
| 2026-10-26 20:04:57 +08:00 | v1.23.0，项目v2.33.0 | 每船卡片增加管理员“调参设置”，自动选择目标船并保持总览，弹窗标明设备ID；当前船下拉保留入口，移除全局调参；点击读取才请求、读写/Flash设备隔离、切船需重读，离线/访客/忙态限制；保留三组共享预设；本地修改，尚未上传或部署 |
| 2026-10-26 19:42:14 +08:00 | v1.22.0，源码发布 | 将累计多船总览、船队地图、单船详情/参数隔离、平台设置与调参设置分离、MQTT 设备账号创建、seabot 风格界面和选船下拉导航发布至主仓库与独立网页仓库 `main`；项目版本保持 v2.32.0；本次未部署服务器，本机固件私密网络配置不上传 |
| 2026-10-25 20:48:22 +08:00 | v1.22.0，项目v2.32.0 | 参考 seabot/Art Design Pro 统一顶部栏、侧栏、统计卡片、中性色面板及深浅主题，增加工作台/船名/页面面包屑；保留选船下拉菜单并修复遥测更新重新展开菜单的问题；现有组件实现，固件和协议不变；源码于2026-10-26发布，本次未部署服务器 |
| 2026-10-25 18:04:04 +08:00 | v1.21.0，项目v2.31.0 | 选择无人船后，桌面侧栏六个单船页面改为可展开下拉菜单；未选择船只时隐藏，回到船队总览时收起；保留原 URL、路由、键盘访问和手机快捷导航；本地修改，尚未上传或部署 |
| 2026-10-25 17:09:12 +08:00 | v1.20.0，项目v2.30.0 | 按参考图优化船队运营看板，新增在线/离线/航行统计、双列船卡、有效定位地图、稳定颜色图例和最近遥测；卡片、地图标记及遥测行均可进入对应单船详情；补充三船地图标记和地图点击浏览器断言；本地修改，尚未上传或部署 |
| 2026-10-25 16:27:39 +08:00 | v1.19.0，项目v2.29.0 | 新增64艘以内实时船队总览、在线/离线/航行计数、ID搜索和筛选；可选择单船进入原详情页；管理员新增独立 MQTT 船只账号与主题 ACL；平台设置和单船调参设置分离；固件遥测及参数协议不变；本地修改，尚未上传或部署 |
| 2026-10-25 15:11:51 +08:00 | v1.18.0，项目v2.28.0 | 新增管理员 MQTT 设备账号管理：读取已有设备、修改账号或重设密码；受限 Unix socket 管理组件、凭据/ACL 事务恢复、Broker 重启及首次安装/卸载集成；设备 ID 与固件协议保持原样；源码发布至主仓库与独立网页仓库 main，本次未部署或修改真实凭据 |
| 2026-10-25 13:40:11 +08:00 | v1.17.0，源码发布 | 将船→云延迟估计、合计延迟和配套测试发布到独立网页仓库 `main`，提交 `7a4f8ea`；完整251项Node检查及Chrome专项通过；仅发布源码，未部署服务器 |
| 2026-10-25 11:40:50 +08:00 | v1.17.0，项目/固件v2.27.0 | 新增STM32→云端逐包延迟估计及与转发延迟的合计；BTL1发送时间、BTS1双向校时、回绕/连接隔离及旧176字节兼容；先更新后台再烧录新固件；源码已发布，尚未部署服务器 |
| 2026-10-25 10:51:45 +08:00 | v1.16.0，源码发布 | 将管理员用户管理、持久化账户库、会话撤销及部署/更新兼容修改同步至独立网页仓库 main；包含完整239项Node和本机Chrome用户管理专项验证及说明，修正浅色按钮对比度；本次仅发布源码，未部署现有服务器；旧更新组件需按账户管理教程升级一次 |
| 2026-10-25 10:34:06 +08:00 | v1.16.0，项目 v2.26.0 | 新增管理员用户管理，支持新建管理员/访客、改名、重设密码和调整角色；独立scrypt账户库原子持久化，保留至少一名管理员、修改后撤销目标旧会话；同步改密后的部署/更新健康检查及候选账户兼容预检；本地修改，尚未上传或部署 |
| 2026-10-24 20:20:38 +08:00 | v1.15.0，项目 v2.25.0 | 新增 Ubuntu/Debian 首次安装入口，自动准备 Node/依赖、MQTT、网页、管理员/访客随机账户、Nginx HTTPS 与证书续期、网页更新组件；README 提供可复制的一条安装指令、DNS/端口前提、凭据路径和维护说明；连同仅 MQTT 的网页功能同步独立仓库，未对现有服务器执行部署 |
| 2026-10-24 19:37:33 +08:00 | v1.14.0，项目 v2.24.0 | 删除网页蓝牙连接入口、Web Bluetooth 传输和双源切换，仅使用 MQTT；保留设备选择、六页监测、云端参数/Flash、账户权限、预设、地图与三维姿态；更新本机/部署/浏览器说明；本地修改，尚未上传或部署 |
| 2026-10-24 19:29:20 +08:00 | v1.13.0，源码发布 | 将六页工作区、RTK/IMU 同屏仪表、按 MQTT 设备 ID 命名的设备卡片，以及相关资源、测试和说明同步至独立网页仓库 main；沿用上文已通过的31项相关Node、完整监控烟测和高德地图专项结果；本次仅上传源码，未部署服务器 |
| 2026-10-24 19:18:51 +08:00 | v1.13.0，项目 v2.23.0 | 左侧与手机导航改为概览/地图/姿态/曲线/推进/诊断六个独立页面；共享地图/船模/仪表，切页保留连接与数据；支持URL直达、历史/刷新恢复、键盘焦点与专用大视图，隐藏画面暂停绘制；31项相关Node、完整监控烟测及高德地图专项通过，手机画幅修复后复核整船显示；本地修改，尚未上传/部署 |
| 2026-10-23 22:06:37 +08:00 | v1.12.0，项目 v2.22.0 | 参考图更新当前设备卡片，加入静态船模、MQTT/BLE、连接状态、有效帧数、本地更新时间及估计转发延迟；船名跟随 MQTT 设备 ID，断开保留时间、切船清除旧统计；相关 Node 及本机 Chrome 检查通过；本地修改，尚未上传/部署 |
| 2026-10-23 21:23:55 +08:00 | v1.11.0，项目 v2.21.0 | 参考传感器面板合并 RTK/IMU：定位/IMU 状态、左侧欧拉角、中间人工地平仪、右侧角速度和 RTK 东/北对地速度，下方经纬度/合速/船头航向；详细源信息折叠，保留各字段独立有效/超时判断及深浅主题，移除互斥标签；本地修改，尚未上传/部署 |
| 2026-10-23 20:57:19 +08:00 | v1.10.1，源码发布 | 将高德 CSP 兼容修复、真实地图加载判断、超时/错误/回滚及警告、切换后遥测刷新、相关测试和配置教程同步至独立网页仓库 main；本次仅发布源码，未更新线上服务；验证记录见上文 |
| 2026-10-23 17:44:55 +08:00 | v1.10.1，项目 v2.20.1 | 修正 CSP 对真实高德 SDK 及资源的拦截，等待 `complete` 才标记地图初始化完成；增加 15 秒超时、地图错误/回滚/销毁及持续 CSP 警告，切换后恢复最新船位；构建、71 项 Node、完整监控烟测和地图专项通过，真实 SDK 默认无定位及上海街区可见；本地修改，尚未上传/部署 |
| 2026-10-23 16:59:16 +08:00 | v1.10.0，源码发布 | 将地图主动切换、浏览器选择记忆、失败恢复、配置说明与回归检查同步至独立网页仓库 main；本次仅发布源码，未更新线上服务；验证记录见上文 |
| 2026-10-23 16:51:37 +08:00 | v1.10.0，项目 v2.20.0 | 地图下方新增高德/OSM切换按钮，成功选择保存在当前浏览器；保留手动平移视野、缩放、船位透明度、轨迹和速度箭头，切换不打断遥测；未配置/加载失败给出提示并保留旧地图，初始化失败可手动恢复OSM；忙时禁用重复操作；本地修改，尚未上传/部署 |
| 2026-10-23 13:21:09 +08:00 | v1.9.1，源码发布 | 将高德官方接入、管理员配置保存、无定位显示地图及完整教程/测试同步到独立网页仓库 main；本次只发布源码，未升级线上服务；构建与验证记录见上文 |
| 2026-10-23 13:16:19 +08:00 | v1.9.1，项目 v2.19.1 | 底图加载与船位有效性分开判断，无设备/无定位也可显示、平移和缩放地图；等待定位改成角落提示，定位失效保留底图，加载失败仍明确报错；18 项相关 Node、完整 Chrome 烟测及高德地图专项通过；尚未上传/部署 |
| 2026-10-23 13:03:08 +08:00 | v1.9.0，项目 v2.19.0 | 设置内新增管理员高德 Key/安全密钥填写、配置来源、保存及刷新应用；无需连船，两空停用；服务端原子持久化覆盖环境变量、重启及更新后保留，兼容既有更新目录与新装 StateDirectory；管理员同源授权、退出/降权清理及请求限制；同步申请/配置教程；构建、184 项 Node 和原烟测/高德浏览器专项通过；无真实 Key，尚未上传/部署 |
| 2026-10-23 12:31:59 +08:00 | v1.8.0，项目 v2.18.0 | 高德官方JS API 2.0可配置接入，缺Key时保留OSM并提示；统一船位/轨迹/速度箭头坐标转换、原始RTK数值保留；地图加载异常隔离、生命周期取消、深浅主题与缩放；新增配置接口、地图门面及本机/Linux配置教程；无真实Key，尚未上传/部署 |
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
