# WVP / GB28181 图传、云台与语音接入（Web v1.72.0）

平台支持按船在原 SRT / UDP 输入和 WVP-GB28181-Pro + ZLMediaKit 输入之间切换。选择保存在服务器，所有用户的图传页、驾驶页和录像使用同一来源。切换仅重连视频，不修改遥测和船端控制协议。

视频链路为 `摄像头 → GB28181 → WVP / ZLMediaKit → 本机 RTSP → MediaMTX → WebRTC → 浏览器`。MediaMTX 负责服务器录像；浏览器关闭后仍按已保存的录像开关继续工作。云台指令由 Web 转给 WVP，通过 GB28181 发给摄像头；语音使用浏览器与 ZLMediaKit 的 G.711A WebRTC，再由 WVP 对接国标语音。服务均原生运行，不使用 Docker；语音需要 ZLMediaKit 编译启用 WebRTC。

## 服务器准备

1. 部署本版 Web，按 [VIDEO_UDP_SETUP.md](VIDEO_UDP_SETUP.md) 启用现有 MediaMTX 视频组件。
2. WVP、ZLMediaKit 与 Web 运行在同一服务器；WVP 的 HTTP 接口和 ZLM 的 RTSP 接口允许回环访问。
3. 摄像头先注册到 WVP，确认 WVP 中设备与通道存在。推荐 H.264 视频；浏览器是否支持 H.265 取决于浏览器、系统及硬件，平台不会自动转码。
4. 使用 WVP 自己的登录账号和密码。ZLM 的 `api.secret` 是另一套凭据，不能用于登录 WVP。

本次接入服务器的端口如下，可通过环境变量调整：

| 服务 | 本机地址 | 用途 |
| --- | --- | --- |
| WVP HTTP | `127.0.0.1:18978` | 登录、设备列表、主动点播 |
| ZLM HTTP | `127.0.0.1:10080` | 媒体状态检查、WHIP / WHEP 语音信令 |
| ZLM RTSP | `127.0.0.1:10004` | MediaMTX 通过 TCP 拉流 |
| ZLM WebRTC | `10005/UDP`、`10005/TCP` | 浏览器对讲、喊话音频 |
| MediaMTX API | `127.0.0.1:9997` | 按船切换来源、录像管理 |
| MediaMTX WHEP | `127.0.0.1:8889` | 平台鉴权的 WebRTC 信令 |

视频信令访问本站 `/api/video/media/...`，云台和语音信令访问 `/api/video/camera/boats/<船ID>/...`。无需公开 WVP/ZLM 管理接口、配置额外浏览器跨域或在前端填密码。GB28181 的 SIP/RTP 端口按已有 WVP 配置开放，视频 WebRTC 沿用 MediaMTX 端口；语音额外使用 ZLM WebRTC 的 TCP / UDP 端口。

## 私密配置

在服务器新建 `/etc/unmanned-boat-video/wvp.env`，权限设为 `root:root 0600`，内容参照下方示例。替换空值；不要把此文件上传到 GitHub。

```ini
BOAT_VIDEO_WVP_ENABLED=1
BOAT_VIDEO_WVP_PORT=18978
BOAT_VIDEO_WVP_USERNAME=admin
BOAT_VIDEO_WVP_PASSWORD_MD5=
BOAT_VIDEO_ZLM_HTTP_PORT=10080
BOAT_VIDEO_ZLM_RTSP_PORT=10004
BOAT_VIDEO_ZLM_SECRET=
BOAT_VIDEO_SOURCE_FILE=/var/lib/unmanned-boat-web/video-sources.json
```

`BOAT_VIDEO_WVP_PASSWORD_MD5` 填 WVP 登录密码的 32 位 MD5。也可以改用 `BOAT_VIDEO_WVP_PASSWORD` 保存明文密码；MD5 本身也可用于 WVP 登录，须视为密码保管。ZLM 密钥来自其 `config.ini` 的 `[api] secret`；留空时跳过 ZLM 流数检查并禁用语音，不影响 WVP 视频点播与云台。Node 不会自动读取 `.env`，必须由 systemd 注入。

创建 `/etc/systemd/system/unmanned-boat-web.service.d/46-wvp-video.conf`：

```ini
[Service]
EnvironmentFile=/etc/unmanned-boat-video/wvp.env
```

然后执行：

```bash
sudo chmod 600 /etc/unmanned-boat-video/wvp.env
sudo systemctl daemon-reload
sudo systemctl restart unmanned-boat-web.service
sudo systemctl status unmanned-boat-web.service --no-pager
```

状态文件的父目录需允许 Web 服务写入；标准安装使用现有 `StateDirectory`。配置和状态都位于代码目录外，网页更新不会覆盖。修改凭据或端口后需重启 Web 服务，网页切换来源不需要重启服务。

## 在平台切换

1. 用管理员登录，打开 **平台设置 → 图传接收通道**。
2. 点击“重新读取设备与通道”，选择要配置的无人船。
3. 选择“WVP / GB28181 + ZLMediaKit”，再选择 WVP 设备和摄像头通道。
4. 点击“保存并切换通道”。服务器会主动点播，已有播放页通常在 5 秒内读取到来源变化并重新连接；摄像头建立视频流可能需要更长时间。
5. 切回时选择“原通道 · SRT / UDP”并保存。原 UDP 地址、SDP、录像目录和录像开关会保留；其他船不受影响。

游客、驾驶员可以查看所选视频，但不能修改平台通道设置。切换来源会使当前录像分段结束；已录文件保留，新片段继续写入同一艘船的录像目录。录像仍需在视频页单独点击开始。

设备离线时可以保存已存在的 WVP 通道，平台显示“已保存，等待接收”，后台约每 15 秒重试。此时不会自动回退至原 UDP 画面，避免把错误来源显示或录成当前摄像头。服务器重启后恢复选择；用户手动停止的视频不会被来源轮询重新打开。切换不会调用 WVP 的停止点播接口，以免中断其他 WVP 用户正在观看的同一摄像头；本平台停止拉流后由原 WVP 无读者策略清理。

## 云台、对讲与喊话

管理员先按上节为船绑定 WVP 摄像头。管理员或驾驶员选中该船，在**视频监控**或**驾驶操控**点击“云台 / 对讲”。访客没有此入口，后台也拒绝访客指令；不要求 STM32 或 MQTT 遥测在线。

- **云台**：按住方向键移动，松开即发送停止；支持八方向、变焦加 / 减以及 1—255 移动速度。可聚焦按钮后按住空格 / Enter。摄像头须有云台或电动镜头，并支持对应的 GB28181 指令。
- **驾驶手柄**（v1.71.0 起）：驾驶页选择 Xbox 标准手柄，图传为主画面时用十字键控制八方向云台，松开停止；沿用面板速度，收起面板后也可用，无需接管船体或按住 RB。v1.72.0 增加按住 **RT 放大、A＋RT 缩小**，发送摄像头真实变焦指令，变焦优先于十字键方向；镜头需支持变焦。地图为主画面时十字键浏览地图，RT / A＋RT 缩放地图，单独 A 松开恢复跟随。切换主画面、切船、失焦、离页或断开后先松键再操作，详见[RT 缩放教程](DRIVING_SETUP.md#rt-缩放地图与摄像头web-v1720)与[手柄云台教程](DRIVING_SETUP.md#十字键控制图传云台web-v1710)。
- **双向对讲**：选择模式，点击“开始对讲”并授权麦克风；平台发送电脑声音，同时播放摄像头回传声音。“关闭麦克风”只静音上行，“结束通话”释放整段会话。
- **单向喊话**：只把电脑麦克风传到摄像头扬声器，适合不支持双向回传的设备。点击“监听画面声音”可在未通话时打开原视频音轨；进入语音后暂停原视频声音以避免重复回音。
- **释放**：关闭面板、离开视频 / 驾驶页、切船、浏览器失焦、切到后台或退出登录时停止云台并关闭麦克风。云台租约 1.4 秒、语音租约 7 秒；后台在失联后尝试停止，失败继续重试。同一物理摄像头只允许一个窗口操作云台和一个窗口语音，绑定到不同船也共用此限制。

麦克风仅在 HTTPS 或本机 `localhost` 安全环境可用，且必须由用户点击授权。浏览器使用 **PCMA / G.711A、8 kHz、单声道**；摄像头需支持 GB28181 对讲 / 广播并接好麦克风和扬声器。摄像头是否接受对讲、能否同时收发，由型号、固件与音频配置决定，平台不会把不支持的设备自动转成双向。

**先确认摄像头的播放端已接好扬声器。** 摄像头有麦克风、能回传现场声音，并不代表能播放电脑传过去的声音。使用外接扬声器时，检查摄像头音频输出接线、扬声器供电 / 功放及两端音量；摄像头为线路电平输出时应接相应的有源扬声器或功放。`2026-11-11` 用户在服务器配置修正后确认遗漏外接扬声器，接好后语音正常。

### 启用 ZLMediaKit 原生 WebRTC

**双向对讲还需要 WVP 媒体节点启用多端口 RTP。** WVP 的“媒体节点 → 编辑”中启用该选项，并同步重启配置；示例配置为：

```yaml
media:
  rtp:
    enable: true
    port-range: 30000,30500
    send-port-range: 40001,40500
```

这是 WVP 的 GB28181 RTP 设置，与下文 ZLM WebRTC 10005 属于两段通信。安全组 / 防火墙需放行所用 RTP 范围的 TCP / UDP；示例 WVP 的双向对讲 SDP 要求摄像头主动连接服务器的 TCP 发送端口。现有摄像头 SIP 注册端口、视频单端口和 WebRTC 端口仍需保留。

已有节点会保留数据库中的设置，**只改 YAML 再重启可能仍使用旧的 `rtpEnable=false`**；需重新读取实际节点确认 `rtpEnable=true`。默认节点显示“配置不可写”时，网页保存可能只更新数据库，管理员还需修改服务实际使用的配置文件以保证重启一致。本文示例为 `/etc/hik-wvp/application-default.yml`，`${RTP_ENABLE:false}` 可改为 `${RTP_ENABLE:true}`；若环境变量显式设为 `false`，也需一并调整。

Web v1.70.1 在发起双向对讲前检查 WVP 返回的媒体节点配置；单端口模式直接提示配置问题，避免麦克风连上后持续等待摄像头回传。单向喊话单独处理。

先确认当前 ZLM API 列表包含 `/index/api/whip`、`/index/api/whep`、`/index/api/delete_webrtc`。仅有普通视频拉流能力并不代表已编译 WebRTC。若缺少接口，在既有 ZLM 源码目录操作，先备份当前二进制与配置：

```bash
sudo apt-get update
sudo apt-get install -y libsrtp2-dev libssl-dev pkg-config
cmake -S . -B build -DENABLE_WEBRTC=ON
cmake --build build --target MediaServer -j1
```

使用当前安装对应的构建目录及原有 CMake 选项，不覆盖其他组件配置。确认构建产物位置后安装到现有 ZLM 服务使用的路径。示例服务器的 `/etc/hik-zlm/config.ini` 只需调整下面三项，其余字段保留：

```ini
[rtc]
port=10005
tcpPort=10005
externIP=你的服务器公网IP
```

云服务器安全组和系统防火墙须开放 **10005/UDP、10005/TCP**，并确保没有端口冲突；示例刻意避开原 SRT / UDP 图传使用的 8000。然后重启对应 ZLM 服务和 Web 服务，原生部署示例为 `sudo systemctl restart hik-zlm.service unmanned-boat-web.service`。这会短暂中断图传与 Web 连接，应在没有驾驶或任务执行时操作。WVP 与 ZLM 的服务名 / 路径以实际安装为准。

WVP 登录令牌、语音发布用 `pushKey`、ZLM 密钥及删除会话令牌始终保留在服务器；前端只获取音频 SDP 和本平台的临时会话编号。浏览器到 ZLM 的音频使用 WebRTC 加密传输，SIP / RTP 继续沿用现有国标网络。

## 常见问题

- **显示 WVP 已连接、设备数量为 0**：登录和接口正常，但还没有摄像头注册到 WVP。先在 WVP 注册设备，再刷新列表；并不要求 STM32 已上线。
- **设备离线、摄像头通道在线**：先重新读取设备与通道。Web v1.69.1 已修复 WVP 3.x 的 `onLine` 字段被误读为离线的问题；平台分别读取设备和通道状态。若 WVP 自身也显示设备离线，应检查 SIP 注册和心跳，通道目录中的在线标记可能尚未更新，不能代替设备在线状态。
- **登录失败**：检查 WVP 自己的账号和密码 MD5；ZLM API 密钥与服务器 SSH 密码都不能直接代替 WVP 登录凭据。
- **能列设备，点播超时**：检查摄像头在线状态、GB28181 SIP/RTP、防火墙、WVP 的媒体节点配置，以及 ZLM 是否收到轨道。
- **点播成功但平台无画面**：确认 ZLM 的 RTSP 端口、H.264 编码及 WebRTC UDP 端口可达。RTSP 拉流使用本机 TCP；浏览器仍通过现有 WebRTC 链路收流。
- **更改未生效或有版本冲突**：先重新读取；另一管理员可能更新了该服务器的来源配置。密码、播放会话参数及内部 RTSP URL 不会回传到浏览器。
- **云台按钮无动作**：检查摄像头是否支持 GB28181 PTZ、设备是否在线及 WVP 自己的云台是否能控制；固定镜头不支持物理转动。切船后先确认控制面板船名。
- **语音按钮不可用**：确认 HTTPS、麦克风权限、ZLM 密钥和三个 WebRTC 接口。云台可独立于语音组件使用。
- **语音连接超时**：检查 ZLM `externIP`、10005 TCP / UDP 和云安全组；再确认摄像头国标音频使用 G.711A，并在 WVP 自带页面验证对讲 / 广播。双向回传不支持时可尝试单向喊话。
- **语音已连接但摄像头端没声音**：先检查是否已连接外接扬声器、是否供电及音量 / 静音。摄像头麦克风用于拾音回传，不能代替扬声器播放下行声音。
- **一直显示“麦克风已连接，正在等待摄像头语音回传…”**：先查 WVP 日志。若出现“单端口暂不支持此操作”，浏览器上行虽到达 ZLM，WVP 却没有向摄像头发送对讲 SIP INVITE；按上节同时修正实际媒体节点与重启配置。若已启用多端口，再检查 WVP 的 SIP 响应、摄像头到服务器的 RTP TCP 连接与扬声器配置，不能仅凭浏览器麦克风已连接判断设备收到声音。
- **日志提示 `open tcp passive server failed` / `address already in use`**：检查对应发送端口是否被上一次失败的语音监听占用。先结束旧语音；若 WVP 已无语音会话、ZLM 仍留下监听，在没有驾驶 / 任务 / 语音活动时重启 ZLM 清理。图传会短暂重连，不要修改或删除原摄像头绑定来解决端口占用。
- **停用 WVP 接入**：先把各船切回原通道，再将私密环境文件中的 `BOAT_VIDEO_WVP_ENABLED` 改为 `0` 并重启 Web。保留状态文件便于恢复；不要在仍选用 WVP 时删除其中的 UDP 备份。

## 验证范围

Node 测试覆盖 WVP 登录续期、分页、点播参数、来源权限、状态持久化、UDP 恢复以及播放页轮询生命周期。`npm run test:wvp:browser` 使用独立本机 MediaMTX、FFmpeg 和 Chrome，验证真实 RTSP → WebRTC 解码、管理员通道设置及切回原输入；其中 WVP 设备接口使用测试桩。真实摄像头注册、GB28181 网络与编码兼容需在摄像头上线后联调。

云台 / 语音接口测试覆盖角色与同源权限、同摄像头互斥、序号与停止竞态、超时 / 换船 / 登出释放、失败清理重试和仅音频 SDP。`npm run test:camera:browser` 使用真实 Chrome、模拟麦克风与本机 MediaMTX 验证 G.711A 发布 / 回传、音频接收字节、静音、失焦 / 离页关闭及驾驶页深浅主题；国标信令由测试桩提供。没有自动移动生产摄像头或开启真实麦克风，实际云台动作与扬声器声音需通过真实设备确认。

`2026-11-11` 已部署 Web v1.70.0 至 `newboat.coffeebean66.tech`，同时原生启用 ZLM WebRTC，`externIP=47.107.239.64`、TCP / UDP 10005；已确认公网 TCP 连接、三个语音 API 及 WVP 发布鉴权，完整 808 项 Node 回归、构建和 Chrome 专项通过。部署时摄像头设备 / 通道离线，实际 GB28181 音频与公网 UDP 穿透未实测。备份位于 `/var/backups/unmanned-boat-web/wvp-camera-20261111T122409Z`，包含原 Web 文件、ZLM 二进制和配置；原 MediaMTX 与录像配置未变更。
