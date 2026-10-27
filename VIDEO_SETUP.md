# 船载视频接入教程

Web `v1.25.0` 起支持为每艘无人船接收视频地址，并在“视频监控”页面播放。管理员可在平台设置按船维护视频 MQTT 用户名和密码；视频端通过 MQTT 发布地址，浏览器直接连接 HTTP(S) 视频服务获取画面。STM32 的遥测和参数通信不需要修改，配套主项目版本仍为 `v2.34.0`。

```text
摄像头 → 视频网关/流媒体服务 → HTTPS HLS、HTTP-FLV 或原生媒体
               │                           │
               └─ MQTT 发布视频地址 → 网页平台 → 浏览器播放
```

平台提供视频地址接收和播放器，没有内置摄像头推流、转码或视频存储服务。摄像头若只有 RTSP/RTMP 输出，应先通过自己的网关转为浏览器可播放的 HLS 或 HTTP-FLV。普通 HTTP 地址可以用于 HTTP 本机测试；HTTPS 网站应使用 HTTPS 视频地址或同源 HTTPS 反向代理。

## 1. MQTT 视频地址协议

默认主题前缀为 `boats`，每艘船使用自己的设备 ID：

```text
boats/<设备ID>/video
```

例如设备 `boat-01` 发布到 `boats/boat-01/video`，不能把视频发布账号名称当作设备 ID。视频账号 `boat-01-vedio` 对应的船仍为 `boat-01`；用户名中的 `vedio` 保留约定拼写。

UTF-8 JSON 示例：

```json
{
  "version": 1,
  "url": "https://video.example.com/live/boat-01.m3u8",
  "format": "hls",
  "title": "船载摄像头"
}
```

| 字段 | 说明 |
| --- | --- |
| `version` | 必须为数字 `1` |
| `url` | 绝对 HTTP(S) 地址，最多2048个字符；不能包含用户名/密码、片段 `#` 或控制字符 |
| `format` | 可省略，默认 `auto`；可选 `auto`、`hls`、`flv`、`native` |
| `title` | 可省略，最多64个字符，用于显示视频名称 |

整个 MQTT 消息最多4096字节。`auto` 根据地址选择播放器；带查询参数或扩展名不明显的直播地址建议显式填写 `format`。`hls` 使用 hls.js 或浏览器原生 HLS，`flv` 使用 mpegts.js，`native` 直接交给 HTML 视频元素。浏览器还需支持实际视频/音频编码，常用 H.264/AAC；扩展名正确并不保证编码可播放。

停止展示该船的视频时，向同一主题发布：

```json
{"version":1,"enabled":false}
```

建议 QoS 1、`retain=true` 发布地址和停用消息，使平台重连后能恢复最新配置。保留消息只代表保存过的地址，不能证明摄像头或视频服务正在工作；是否可播放由播放器实际事件决定。视频消息不延长电控遥测在线时间，不会使离线船获得调参权限。

## 2. 管理员网页配置（推荐）

管理员登录后打开“平台设置 → 视频 MQTT 接入账号”，点击目标船的“配置视频账号”或“修改视频账号”。视频账号与船端遥测账号、设备 ID 和参数权限独立；它只允许写入该船的：

```text
boats/<设备ID>/video
```

按下面步骤操作：

1. 先在设备列表确认目标船已经存在，并核对设备 ID。视频账号表单不能新增第二艘船，也不能修改设备 ID。
2. 首次配置填写视频 MQTT 用户名和密码。用户名为 1～64 位字母、数字、下划线或短横线；密码为 6～64 位可打印 ASCII，不能包含空白或冒号。视频用户名可以是 `boat-01-vedio` 这类独立账号，但不能占用船端遥测账号、网页桥接账号或其他视频账号。
3. 点击保存并确认目标设备。服务端只为该船写入 `video` 主题 ACL，不会修改 STM32 的遥测账号、密码、设备 ID 或参数主题。保存有实际变更时专用 Broker 会短暂重连，旧 MQTT 连接可能断开后恢复。
4. 修改已有视频账号时，可以只改用户名并把密码框留空，保留原密码哈希；输入新密码才会替换密码。网页不会回读、显示、导出密码或密码哈希。保存失败会恢复原密码、ACL 和 Broker 配置，不能部分提交。
5. 保存成功后，使用新用户名和密码向 `boats/<设备ID>/video` 发布地址，按[发布视频地址示例](#4-发布视频地址示例)验证。改名或改密会使旧视频凭据立即失效，但不影响船端遥测账号。

设备列表接口的管理员快照可附带 `canManageVideo` 和 `videos`。`videos` 只列出已配置视频账号的设备 ID、用户名等摘要，不返回密码。管理接口为：

```text
PATCH /api/mqtt/devices/<设备ID>/video
JSON: {"username":"boat-01-vedio","password":"<首次或重设时填写>","revision":"<读取时版本>"}
```

首次配置或重设密码时发送 `password`；仅改用户名时省略 `password` 即可保留原哈希。接口仅允许统一账户中的管理员同源调用，响应返回最新摘要和 `requiresReconnect`，不返回密码。访客、未登录用户和其他船只不能调用。

已有服务器须先更新一次受信任 root 管理组件：

```bash
sudo bash maintenance/install-mqtt-device-admin.sh
```

网页更新只替换应用文件，不会替换 root 管理组件。旧组件继续支持原有无人船 MQTT 账号的读取、创建和修改，但不提供视频账号管理；页面会提示组件版本不足。重新执行上面的安装脚本后，视频账号面板和接口才会启用。安装或更新组件会按脚本流程重启网页服务；视频账号保存造成的 Broker 短暂重连仅发生在实际配置变更时。

## 2.1 旧 CLI 方式（可选）

此步骤适用于项目脚本创建的 Linux 受管理 MQTT Broker。先在平台创建普通船只设备 `boat-01`，再为它配置独立视频账号；不要用“新增无人船”创建名为 `boat-01-vedio` 的第二艘船。

使用最新完整 Web 源码，在服务器创建仅 root 可访问的配置文件：

```bash
sudo install -m 600 -o root -g root /dev/null /root/video-access.json
sudoedit /root/video-access.json
```

文件只能包含以下三项，将占位密码替换为自己的私密密码：

```json
{
  "deviceId": "boat-01",
  "username": "boat-01-vedio",
  "password": "YOUR_PRIVATE_PASSWORD"
}
```

视频密码支持6～64位可打印 ASCII，不能包含空白或冒号；普通船只设备账号仍要求8～64位。配置文件必须是 root 所有、权限 `600` 的普通文件，不能为符号链接。不要将该文件加入 Git；示例中的密码只是占位值。

在 Web 源码根目录执行：

```bash
sudo node maintenance/configure-video-access.cjs --config /root/video-access.json
```

自定义部署配置目录时增加 `--config-dir /自己的配置目录`，默认 `/etc/unmanned-boat-web`。若 Node 不在 sudo 的 PATH，使用部署时的系统级 Node 绝对路径执行脚本。

脚本只为已存在的船配置视频发布账号，授予：

```text
视频账号：write boats/boat-01/video
网页桥接账号：read boats/+/video
```

视频账号不能读写电控遥测、状态、校时或参数主题。脚本保留其他设备和桥接账号的密码，通过带锁事务更新配置、密码文件、ACL 和 Broker 限制；同时将旧部署的 `max_packet_size` 提升至至少8192、`message_size_limit` 提升至至少4096。变更成功后重启专用 Broker，现有 MQTT 连接会短暂重连；失败时回滚。配置、密码和权限均相同的重复执行不会重启。

此 CLI 是网页设置之外的可选维护方式。首次安装不会自动创建视频账号，单纯上传源码或点击网页“更新”也不会应用私密账号。网页设置和 CLI 共用同一受管理配置、锁和回滚机制；不要同时对同一艘船执行两种操作。自行使用外部 Broker 时，按上述主题权限在自己的 Broker 配置独立发布账号、桥接订阅权限及消息大小限制。

## 3. 允许浏览器访问视频来源

默认只允许视频来自网站自身域名。跨域视频需在网页服务环境中明确设置来源，例如：

```text
BOAT_VIDEO_ALLOWED_ORIGINS=https://video.example.com,https://cdn.example.com
```

仅填写来源，即协议、域名和可选端口；不要加路径、查询参数、用户名或密码。最多16个来源，不支持 `*`。例如 `https://video.example.com:8443` 有效，`https://video.example.com/live/` 无效。

受管理服务器可执行：

```bash
sudoedit /etc/unmanned-boat-web/runtime.env
sudo systemctl restart unmanned-boat-web.service
```

在环境文件中添加或修改该项后，刷新浏览器。已有私密配置应继续保留，不要用示例覆盖整个文件。网页更新会保留源码目录外的运行配置。

Windows PowerShell 本机测试可先设置环境再启动：

```powershell
$env:BOAT_VIDEO_ALLOWED_ORIGINS = 'https://video.example.com,https://cdn.example.com'
node server.js
```

此配置会扩展页面 CSP 的 `connect-src` 和 `media-src`。视频服务器仍须允许浏览器跨域读取：HLS 的清单、分片、密钥以及 HTTP-FLV 流都应提供适当的 CORS 响应，例如网站为 `https://boat.example.com` 时：

```text
Access-Control-Allow-Origin: https://boat.example.com
```

清单中的其他域名、跳转后的 CDN、分片和密钥来源也必须满足 CSP 与 CORS 要求。HTTPS 页面不能依靠 CSP 放行 HTTP 混合内容；应将媒体服务改为 HTTPS，或由自己的网站通过 HTTPS 反向代理。平台不会代理、下载或转码视频流。

## 4. 发布视频地址示例

视频端可使用支持用户名密码的任意 MQTT 客户端。下面使用 Python 的 `paho-mqtt 2.x`，从环境读取连接资料；未设置密码环境变量时交互输入，不把密码写入命令或脚本。

```bash
python3 -m pip install 'paho-mqtt>=2,<3'
export VIDEO_MQTT_HOST='mqtt.example.com'
export VIDEO_MQTT_USERNAME='boat-01-vedio'
export VIDEO_DEVICE_ID='boat-01'
export VIDEO_STREAM_URL='https://video.example.com/live/boat-01.m3u8'
export VIDEO_STREAM_FORMAT='hls'
```

保存为自己的 `publish_video.py`：

```python
import getpass
import json
import os
import threading
import uuid

import paho.mqtt.client as mqtt

connected = threading.Event()
connection_result = {"ok": False}


def on_connect(client, userdata, flags, reason_code, properties):
    connection_result["ok"] = not reason_code.is_failure
    connected.set()


device_id = os.environ.get("VIDEO_DEVICE_ID", "boat-01")
payload = {
    "version": 1,
    "url": os.environ["VIDEO_STREAM_URL"],
    "format": os.environ.get("VIDEO_STREAM_FORMAT", "auto"),
    "title": "船载摄像头",
}
client = mqtt.Client(
    mqtt.CallbackAPIVersion.VERSION2,
    client_id=f"video-config-{uuid.uuid4().hex[:12]}",
)
client.username_pw_set(
    os.environ.get("VIDEO_MQTT_USERNAME", "boat-01-vedio"),
    os.environ.get("VIDEO_MQTT_PASSWORD") or getpass.getpass("视频 MQTT 密码: "),
)
client.on_connect = on_connect
tls_enabled = os.environ.get("VIDEO_MQTT_TLS") == "1"
if tls_enabled:
    client.tls_set()
port = int(os.environ.get("VIDEO_MQTT_PORT", "8883" if tls_enabled else "1883"))
client.connect(os.environ["VIDEO_MQTT_HOST"], port, keepalive=30)
client.loop_start()
try:
    if not connected.wait(10) or not connection_result["ok"]:
        raise RuntimeError("MQTT 连接或认证失败")
    message = client.publish(
        f"boats/{device_id}/video",
        json.dumps(payload, ensure_ascii=False),
        qos=1,
        retain=True,
    )
    message.wait_for_publish(timeout=10)
    if not message.is_published():
        raise RuntimeError("MQTT 发布确认超时")
    print("视频地址已发布")
finally:
    client.disconnect()
    client.loop_stop()
```

执行 `python3 publish_video.py`。视频地址变化时再次发布即可；停用时把代码中的 `payload` 改为 `{"version": 1, "enabled": False}` 并再次发布。每个在线 MQTT 客户端使用不同的 client ID，避免与 STM32 或其他视频设备互相踢下线。现有默认 Broker 为普通 TCP 1883；只有自己的 Broker 已配置可信 TLS 时才设置 `VIDEO_MQTT_TLS=1`。

## 5. 在平台查看

1. 登录平台，选择对应的 `boat-01`。
2. 点击船卡的“查看视频”，或进入当前船菜单的“视频监控”，查看标题、地址接收时间及是否为保留配置。
3. 使用页面播放控件查看画面；浏览器阻止自动播放时手动点击播放。播放状态以播放器的加载、播放、等待和错误事件为准。
4. 切换船只后只显示新船的视频；离开视频页、退出登录或隐藏页面时释放播放器，重新进入时按当前船的视频配置恢复。

视频地址会发送给有权查看该船的登录用户。媒体服务如需鉴权，可使用适合浏览器播放的短期签名地址，并在到期前发布新地址；不要把 MQTT 密码放进视频 URL。

## 6. 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 提示未配置视频 | 确认主题为 `boats/boat-01/video`、设备 ID 正确、JSON `version` 为1、消息未被停用；检查桥接账号是否有视频订阅权限 |
| MQTT 登录失败 | 确认已在目标 Broker 运行账号配置脚本，而不只是修改本机文件；核对视频用户名及私密密码，避免使用普通船账号代替 |
| MQTT 发布后没有变化 | 检查主题 ACL、4096字节消息上限和 Broker 报文限制；确认发送到平台实际连接的 Broker，不能向用户名对应的第二艘船主题发送 |
| 收到地址但黑屏 | 先在同一浏览器网络下确认流媒体服务可达，再查看播放器错误；检查 URL 是否过期、摄像头是否真正推流、编码是否被浏览器支持 |
| 控制台出现 CSP 错误 | 把实际媒体、分片、密钥和 CDN 的精确来源加入 `BOAT_VIDEO_ALLOWED_ORIGINS`，重启网页服务并刷新 |
| 控制台出现 CORS 错误 | 在媒体服务及其分片/密钥/CDN 响应上设置允许网站读取的 CORS 头；修改平台来源列表不能替代媒体端 CORS |
| HTTPS 页面不能加载 HTTP 视频 | 将视频升级为 HTTPS 或配置同源 HTTPS 代理；不会自动降级网站安全连接 |
| RTSP/RTMP 无法播放 | 先通过外部网关转换为 HLS 或 HTTP-FLV，再发布转换后的 HTTP(S) 地址 |
| 有视频但船显示离线 | 视频和电控状态独立；检查 STM32 遥测链路，视频地址或保留消息不会让电控状态变为在线 |
| 视频频繁中断且 MQTT 也闪断 | 检查摄像头、脚本和 STM32 是否误用了相同 client ID；视频账号本身应与电控账号独立 |

当前功能的本地验证范围和发布状态以 [README 修改记录](README.md#代码与验证) 为准；真实摄像头、外部流媒体服务和生产 Broker 需在实际部署时联调。
