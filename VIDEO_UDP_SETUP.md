# SRT / UDP 低延迟视频接入

网页支持以下视频链路，无需 Docker：

```text
摄像头/船载计算机 ── SRT（UDP 8890）──> MediaMTX
                                          │
                                   WebRTC（UDP 8189）
                                          │
                                       网页浏览器

网页登录、WHEP 信令：继续走原来的 HTTP(S) 网站端口
STM32 遥测与调参：继续走 MQTT
```

SRT 是带丢包重传和抖动缓冲的 UDP 视频协议。浏览器不能直接播放任意 UDP 数据，因此服务器接收 SRT 后用 WebRTC 转发；Node 服务处理鉴权、信令与录像回放代理，实时视频由 MediaMTX 转发。服务器还支持按船保存分段 MP4，操作和保存目录设置见 [VIDEO_RECORDING_SETUP.md](VIDEO_RECORDING_SETUP.md)。发送端程序需按本页协议接入。

平台也支持船端直接发送 **RTP/H.264 over UDP** 或 **MPEG-TS over UDP**：为一艘船配置独立 UDP 端口，由 MediaMTX 的固定设备路径接收，再通过相同 WebRTC 页面观看和录制。此模式与 SRT 的封装和鉴权不同，不能将 SRT 地址直接改成 `udp://` 后沿用账号参数；配置方法见下文“原始 UDP 图传”。

## 1. 准备服务器

先部署或更新完整 Web 项目，并启用平台登录账户及受管理 MQTT 设备管理组件。支持 Linux amd64/arm64、systemd 247 及以上；使用项目部署时安装的系统 Node.js。安装脚本需要 `curl`、`tar`、`sha256sum`、`ss` 等常用工具，缺少时会在修改服务前提示。

在最新 Web 源码目录执行：

```bash
# 已有服务器也需要更新这个独立的 root 管理组件；网页自动更新不会替换它。
sudo bash maintenance/install-mqtt-device-admin.sh

# 第一个参数必须是浏览器可以直连的服务器公网 IPv4 或解析到该 IP 的域名。
# 第二个参数是本机网页服务端口，默认 7890；反向代理的 443 不是这个端口。
sudo bash maintenance/install-video-media.sh boat.example.com 7890
```

例如服务器的公网地址是 `47.251.109.111`，也可以将第一个参数直接填写为该 IP。若域名启用了只代理 HTTP 的 CDN，应使用服务器公网 IP，或另设不经 CDN 代理的视频域名。

脚本固定安装官方 MediaMTX `v1.21.3` 并校验预置 SHA-256，创建 `unmanned-boat-video.service`，生成私密配置，然后重启网页和视频服务。下载或启动失败会恢复原有受管理文件和服务状态。升级会保留现有路径、UDP 接收源、其他媒体设置及自定义 service 参数，只补充录像接口、持久化目录和必需的网络地址族；命令中的域名和网页端口更新浏览器公开地址与鉴权回调。内部鉴权密钥保留，账号密码仍在平台中按船维护。复杂或重复键的 YAML 会拒绝自动升级，现有配置不会被重置。

安装文件：

| 路径 | 用途 |
| --- | --- |
| `/usr/local/lib/unmanned-boat-video/mediamtx` | 媒体服务程序 |
| `/etc/unmanned-boat-video/mediamtx.yml` | root 只读私密配置，通过 systemd credential 交给媒体服务 |
| `/etc/unmanned-boat-video/runtime.env` | 网页内部鉴权配置，权限 `600` |
| `/etc/systemd/system/unmanned-boat-video.service` | 独立媒体服务 |
| `/etc/systemd/system/unmanned-boat-web.service.d/45-video-media.conf` | 网页加载媒体配置的 drop-in |
| `/var/lib/unmanned-boat-video/recordings` | 按船保存的服务器录像，目录可由管理员在允许的状态目录内修改 |

这些是源码目录外的运行配置，普通网页更新会保留。无需把私密配置、账号文件或密码提交到 GitHub。

## 2. 放行 UDP 端口

在云服务器安全组及操作系统防火墙中放行：

| 端口 | 方向与用途 |
| --- | --- |
| UDP `8890` | 船端向服务器推送 SRT 视频 |
| UDP `8189` | 浏览器与服务器建立 WebRTC 媒体连接 |
| 网站原有 TCP 端口（通常 `443`） | 网页访问与同源 WHEP 信令 |

脚本不会自动修改防火墙。TCP `8889`（WebRTC 信令）、`9997`（媒体控制）、`9996`（录像回放）仅监听 `127.0.0.1` 并使用内部凭据鉴权，不应向公网开放；浏览器通过原网站的登录接口间接访问。没有开启 RTSP、RTMP、HLS 或 MoQ，也不需要新增 MQTT 视频大包。录像能力安装后可用，需在网页对各船分别点击开始。

浏览器和船端都需要允许 UDP 出站。当前部署不提供 TURN 或 TCP 媒体回退；限制 UDP 的网络无法通过此链路播放，需调整网络或继续使用[HTTP/HLS/FLV 方案](VIDEO_SETUP.md)。

## 3. 按船配置视频账号

管理员登录，进入“平台设置 → 视频 MQTT 接入账号”，为已存在的船配置独立视频用户名和密码。原来已配置的账号可直接复用，不用新增一艘名为视频账号的船。

例如：

```text
设备 ID：boat-01
视频用户名：boat-01-vedio
视频密码：在平台设置的私密密码
```

SRT 的流路径使用设备 ID `boat-01`；用户名 `boat-01-vedio` 只用于认证。服务端验证这组凭据是否属于目标船，不允许把同一账号用于其他船的路径。修改视频账号或密码后，新建 SRT 连接应使用新凭据；已建立的媒体会话需断开重连才能重新鉴权。

这里沿用视频 MQTT 账号管理入口以统一维护凭据，SRT 视频帧直接走 UDP，并不经过 MQTT Broker。STM32 遥测账号、网页登录账号和视频账号仍各自独立。

## 4. 船端推流格式

发送 **H.264、无 B 帧的 MPEG-TS over SRT**。推荐先用 720p、25 fps、约 1.5 Mbit/s、关键帧间隔 1 秒验证；摄像头输出若已满足要求，可直接封装推送，避免重复编码。H.265 在不同浏览器中的支持不一致，不作为默认接入格式。

SRT 地址结构：

```text
srt://服务器公网地址:8890?mode=caller&latency=120000&pkt_size=1316&streamid=publish:设备ID:视频用户名:视频密码
```

其中 `latency=120000` 为 120 毫秒协议缓冲参数，不代表最终画面延迟。设备 ID 和用户名支持 1～64 位字母、数字、下划线、短横线。密码中的 `&`、`?`、`#`、`%` 等 URL 字符必须编码；推荐将整个 `streamid` 参数用 URL 编码，而不是直接拼接任意密码。

以下 Linux 示例读取 `/dev/video0`。先将完整 SRT 地址放入 `VIDEO_SRT_URL` 环境变量，再执行；FFmpeg 必须包含 `libsrt` 和 `libx264` 支持：

```bash
# 替换地址、设备 ID、用户名和私密密码；仅当密码没有 URL 特殊字符时可直接这样填写。
export VIDEO_SRT_URL='srt://boat.example.com:8890?mode=caller&latency=120000&pkt_size=1316&streamid=publish:boat-01:boat-01-vedio:YOUR_PRIVATE_PASSWORD'

ffmpeg -f v4l2 -framerate 25 -video_size 1280x720 -i /dev/video0 \
  -an -c:v libx264 -preset ultrafast -tune zerolatency \
  -profile:v baseline -pix_fmt yuv420p -r 25 \
  -g 25 -keyint_min 25 -sc_threshold 0 -bf 0 \
  -b:v 1500k -maxrate 1500k -bufsize 300k -flush_packets 1 \
  -f mpegts "$VIDEO_SRT_URL"
```

也可将输入部分替换为测试画面，验证服务器和浏览器，不必先接摄像头：

```bash
ffmpeg -re -f lavfi -i 'testsrc=size=640x360:rate=25' \
  -an -c:v libx264 -preset ultrafast -tune zerolatency \
  -profile:v baseline -pix_fmt yuv420p -g 25 -bf 0 -b:v 700k \
  -flush_packets 1 -f mpegts "$VIDEO_SRT_URL"
```

此版本使用 SRT `streamid` 认证，**默认未启用 SRT 上行加密**；它不能替代加密传输。浏览器侧 WebRTC 媒体使用 DTLS-SRTP 加密，网页登录和信令应使用 HTTPS。需要上行加密时，可另行增加服务端和发送端一致的 SRT passphrase，当前安装脚本没有配置共享 passphrase。

### 原始 UDP 图传：固定设备路径

若上位板已经发送 RTP/H.264 的 UDP 数据，可在安装时指定接收设备与端口，默认使用 RTP：

```bash
sudo env BOAT_VIDEO_UDP_DEVICE=boat-01 BOAT_VIDEO_UDP_PORT=8000 BOAT_VIDEO_UDP_FORMAT=rtp \
  bash maintenance/install-video-media.sh boat.example.com 7890
```

设备和端口必须一起填写，设备 ID 需要先在平台注册，端口可选 `1024–65535` 中未被占用的端口，不能与网页端口、WebRTC、SRT 或内部控制/回放端口冲突。默认格式为 `rtp`，同时生成 H.264/90000、payload type `96`、`packetization-mode=1` 的 SDP；发送端 payload 不同，可设置 `BOAT_VIDEO_UDP_PAYLOAD_TYPE`（`96–127`）。安装后生成的设备路径相当于：

```yaml
paths:
  boat-01:
    source: udp+rtp://0.0.0.0:8000
    rtpSDP: |
      v=0
      o=- 0 0 IN IP4 0.0.0.0
      s=Boat H264 RTP
      c=IN IP4 0.0.0.0
      t=0 0
      m=video 8000 RTP/AVP 96
      a=rtpmap:96 H264/90000
      a=fmtp:96 packetization-mode=1
  '~^[A-Za-z0-9_-]{1,64}$': {}
```

船端推送示例：

```bash
ffmpeg -re -f lavfi -i 'testsrc2=size=640x360:rate=25' \
  -an -c:v libx264 -preset ultrafast -tune zerolatency \
  -profile:v baseline -pix_fmt yuv420p -g 25 -bf 0 -b:v 700k \
  -flush_packets 1 -payload_type 96 -f rtp 'rtp://boat.example.com:8000?pkt_size=1200'
```

发送端需在视频中周期性带上 SPS/PPS 和关键帧；接收端的 SDP 必须与发送端编码、时钟和 payload type 一致。如需自定义 SDP，可在服务器私密媒体配置中调整 `rtpSDP`，升级会保留已有设置。没有为 RTP 固定 `profile-level-id`，应使用浏览器支持的 H.264 配置。

如果发送端实际是 MPEG-TS over UDP，明确设置 `BOAT_VIDEO_UDP_FORMAT=mpegts`。这时接收源为 `udp+mpegts://0.0.0.0:8000`，不需要 SDP；FFmpeg 输出相应改为 `-f mpegts 'udp://boat.example.com:8000?pkt_size=1316'`。RTP 与 MPEG-TS 不能混用。

在云安全组和服务器防火墙放行所选 UDP 端口，建议限制为船端网络来源。原始 UDP 接收不验证视频用户名和密码，也没有 SRT 的重传或上行加密；视频账号仍用于其他船的 SRT 接入和原有 MQTT 地址发布。设备 `boat-01` 的固定 UDP 源占用该设备路径，该船应使用对应 UDP 端口；其他设备仍可使用 SRT 8890。网页播放和录像继续要求平台登录。

服务限制中包含 `AF_NETLINK`，用于 UDP 接收源查询网络接口；缺少它可能导致媒体进程无法初始化原始 UDP 源。当前安装脚本会补齐此项，已有自定义 drop-in 会保留。再次运行安装脚本时，不填写这两个变量会保留已有 UDP 源；填写则只更新指定设备的接收源。需要删除 UDP 路径或改回 SRT 时，应明确修改媒体配置，脚本不会自动删除现有设备路径。

## 5. 网页查看

安装启用后，登录网页、选择目标船并打开“查看视频 / 船载视频”。网页自动通过同源接口建立 WebRTC 连接，显示 `WebRTC · 低延迟`。**无需再通过 MQTT 发布视频地址**，即使 STM32 暂时没有遥测，已注册船的视频也可独立接入。

切换船只、停止播放、隐藏视频页面或退出登录会释放当前媒体连接。若发送端尚未推流，先启动发送端，再点击网页“重新连接”。启用网关后优先使用 WebRTC；连接失败会显示错误，不会悄悄播放此前保存的 HTTP 地址。

没有安装/已经停用低延迟网关时，原有 MQTT 地址 + HLS/FLV/原生视频播放仍然有效。两种接入方式的区别见 [VIDEO_SETUP.md](VIDEO_SETUP.md)。

## 6. 排查与性能

```bash
sudo systemctl status unmanned-boat-video.service --no-pager
sudo journalctl -u unmanned-boat-video.service -n 80 --no-pager
sudo journalctl -u unmanned-boat-web.service -n 80 --no-pager
sudo ss -lunp | grep -E ':(8890|8189)\b'
# 原始 UDP 示例还需确认接收端口：
sudo ss -lunp | grep ':8000\b'
sudo ss -ltnp | grep ':8889\b'
```

| 现象 | 优先检查 |
| --- | --- |
| 安装提示先更新 MQTT 管理组件 | 重新执行 `maintenance/install-mqtt-device-admin.sh`；普通网页更新不会替换 root 组件 |
| SRT 推流被拒绝 | 设备 ID 是否存在、流路径是否为设备 ID、账号是否为该船视频账号、URL 编码及密码是否正确 |
| 原始 UDP 已发送但没有视频 | 检查所选 UDP 端口、防火墙、固定设备路径、RTP/SDP 或 MPEG-TS 封装是否匹配，以及 service 是否允许 `AF_NETLINK` |
| 推流成功但网页无画面 | UDP `8189`、安装时填写的公网地址是否能被浏览器直连、浏览器是否支持 H.264、视频是否包含 B 帧 |
| 网页仍显示 HLS/FLV | 是否已安装并启用网关、网页服务是否成功加载媒体 drop-in、浏览器是否刷新 |
| 卡顿或延迟升高 | 先降低分辨率和码率；检查船端上传带宽、丢包、编码缓存，避免在不稳定链路上使用过低 SRT 缓冲 |

MediaMTX 转发和录制媒体，不做解码或转码。2 核 2 GB 服务器可先验证少量流，但容量主要受带宽、码率、磁盘和同时观看人数影响。例如 1 路 1.5 Mbit/s 视频被 3 个浏览器观看，服务器视频出口约为 4.5 Mbit/s，另有协议开销；连续录像约占 675 MB/小时。每艘船分别推流会叠加入口、出口和存储需求。实际延迟由采集、编码、网络、SRT 和浏览器共同决定，应以真实设备测量为准。

## 7. 停用与恢复

只停用视频网关，保留网页和 MQTT：

```bash
sudo bash maintenance/remove-video-media.sh
```

脚本验证受管理路径后停止并禁用独立媒体服务，移除自己的网页 drop-in，必要时重启网页；程序、service unit、私密配置、视频账号、录像文件和录像设置均保留，不递归删除系统目录。网页恢复原有 HTTP 视频接入。仅检查所有权、不作改动可运行：

```bash
sudo bash maintenance/remove-video-media.sh --check-only
```

恢复时重新运行安装命令即可，已有内部密钥会保留。完整平台删除使用项目根目录的 `remove.sh`；其恢复文件保留规则见项目 README。
