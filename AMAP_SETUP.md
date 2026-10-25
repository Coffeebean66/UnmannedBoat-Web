# 高德地图配置教程

网页 v1.9.0 支持在管理员设置中填写高德官方 JavaScript API 2.0 配置。尚未填写 Key 时继续显示 OpenStreetMap，地图底部提示“高德未配置”；界面保存后刷新网页即可应用。配置已填写但 SDK 加载失败时会显示错误。电机、IMU、参数等功能独立于地图加载。

从 v1.10.0 起，可在地图下方点击“切换至 OSM / 切换至高德”主动选择底图。无需船端在线或刷新整页，船位、轨迹、速度箭头及当前视野会保留；成功选择只记录在当前浏览器，不会改动服务器地图配置，也不影响其他访问者。没有选择记录时，已配置高德则默认高德。选择高德前仍需按下文配置 Key；若地图首次加载失败，可以点击“切换至 OSM”恢复浏览。

## 1. 申请 Key 和安全密钥

1. 登录 [高德开放平台控制台](https://console.amap.com/)，完成平台要求的账号认证。
2. 在“应用管理 → 我的应用”中新建应用，再添加 Key，服务平台选择 **Web端（JS API）**。
3. 保存该 Key 及其配套的 **安全密钥（securityJsCode）**。二者来自同一个 Web 端应用；不能用 Web服务、Android、iOS 或小程序 Key 替代。
4. 在控制台配置应用的域名白名单，至少覆盖实际使用的 `boat.coffeebean66.tech`。本机调试按平台当前规则允许 `localhost`、`127.0.0.1`；如控制台支持单独调试 Key，可为本地另建一个。

服务额度和计费以控制台为准。官方说明：[JS API 加载](https://lbs.amap.com/api/javascript-api-v2/guide/abc/load)。本项目使用官方 SDK，不调用未公开的免 Key 瓦片地址。

## 2. 推荐：在管理员设置中填写

1. 服务器先安装网页 v1.9.0 或更新版本，使用现有管理员账户登录。
2. 点击右上角“设置”，找到“平台地图设置”。无需连接无人船或等待 MQTT 遥测。
3. 填写 **Web端 Key** 和同一应用的 **安全密钥 securityJsCode**。两项均为 32 位十六进制。
4. 点击“保存地图配置”，看到保存成功后点击“刷新页面应用”。保存本身不打断监测；刷新页面会重新建立当前连接。
5. 地图左上角应显示“高德地图 / GCJ-02”。如果加载失败，按本文末尾的检查项处理 Key、白名单或网络问题。

配置保存在运行服务的主机上，供访问该服务的用户共用；没有写入 STM32，也不占用设备参数预设。访客不能读取管理接口或修改配置。未启用平台账户的本机开发/旧密码模式不能通过网页保存，请使用下方环境变量方式，或先按 README 配好管理员/访客账户。

两项都清空再保存表示**停用高德**，刷新后使用 OSM；只填一项不能保存。界面保存的配置优先于环境变量，包含“已停用”状态；环境变量的变更不会覆盖已保存的值。若希望恢复仅由环境变量控制，先停止服务，由运维备份并移走实际使用的 `map-settings.json`，再重启。

### 配置保存在哪里

配置不在源码目录中，因此服务重启、重新打开浏览器及网页一键更新后均可保留。默认位置按以下顺序选择：

| 场景 | 文件位置 |
| --- | --- |
| 显式指定 | `BOAT_MAP_CONFIG_FILE` 指向的绝对文件路径 |
| 已启用网页一键更新的服务器 | `BOAT_UPDATE_STATE_DIR/requests/map-settings.json`，默认 `/var/lib/unmanned-boat-web-update/requests/map-settings.json` |
| 本版脚本安装的基础 systemd 服务 | `STATE_DIRECTORY/map-settings.json`，通常为 `/var/lib/unmanned-boat-web/map-settings.json` |
| Windows 本机 | `%APPDATA%\unmanned-boat-web\map-settings.json`，未设置 APPDATA 时使用当前用户 `AppData\Roaming` |
| 普通 Linux 用户启动 | `$XDG_CONFIG_HOME/unmanned-boat-web/map-settings.json`，未设置时为 `~/.config/unmanned-boat-web/map-settings.json` |

现有已安装一键更新服务可使用原有可写目录，不必授予网页服务修改 `/etc` 的权限。全新基础部署脚本会创建独立 systemd `StateDirectory`。自建服务可以设置 `BOAT_MAP_CONFIG_FILE`，并为运行用户提供相应目录写入权限；只读目录或保存失败会明确报错，不会显示保存成功。

卸载脚本默认保留 `/var/lib/unmanned-boat-web`；一键更新目录随现有卸载流程备份到恢复目录。自定义文件和本机用户目录也由使用者单独管理，不随源码目录一起删除。

## 3. 可选：Windows 环境变量启用

在网页工程目录打开 PowerShell，设置环境变量后启动：

```powershell
$env:BOAT_AMAP_KEY='替换为Web端JS_API_Key'
$env:BOAT_AMAP_SECURITY_CODE='替换为配套的securityJsCode'
.\start-local.ps1
```

尚未通过界面保存过配置时，打开 `http://127.0.0.1:8080`，地图左上角应显示“高德地图 / GCJ-02”。这两个环境变量只影响当前 PowerShell 及其启动的 Node 进程；换终端后要重新设置。已有本地服务需先按 Ctrl+C 停止，再从设置了变量的终端重新启动。

如果执行策略限制了脚本，可以在已设置变量的同一终端运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1
```

工程的 `.env.example` 仅是变量模板。当前 Node 服务**不会自动读取 `.env` 文件**，复制或修改模板后仍需将变量传入启动进程。真实配置不要提交到 GitHub。

## 4. 可选：Linux / systemd 环境变量启用

尚未通过界面保存配置时，也可以用环境变量启用高德。配置保存在源码目录外，后续通过网页“更新”按钮更新代码时仍可保留，不需要重新设置 MQTT 或管理员账户。推荐优先使用管理员设置入口。

先创建配置目录并编辑地图配置：

```bash
sudo install -d -m 755 /etc/unmanned-boat-web
sudo nano /etc/unmanned-boat-web/map.env
```

文件写入以下两行，等号右侧替换为真实值：

```text
BOAT_AMAP_KEY=替换为Web端JS_API_Key
BOAT_AMAP_SECURITY_CODE=替换为配套的securityJsCode
```

随后创建独立的 systemd 配置片段：

```bash
sudo chmod 600 /etc/unmanned-boat-web/map.env
sudo install -d -m 755 /etc/systemd/system/unmanned-boat-web.service.d
sudo nano /etc/systemd/system/unmanned-boat-web.service.d/map.conf
```

`map.conf` 内容：

```ini
[Service]
EnvironmentFile=/etc/unmanned-boat-web/map.env
```

应用配置并重启网页服务：

```bash
sudo systemctl daemon-reload
sudo systemctl restart unmanned-boat-web.service
sudo systemctl status unmanned-boat-web.service --no-pager
```

刷新 `https://boat.coffeebean66.tech`。环境变量接入需服务器至少安装 v1.8.0，管理员设置入口需 v1.9.0；仅填 Key 不会让旧版网页获得新功能。此教程提供操作步骤，本次没有替你修改线上配置或重启线上服务。

Web 端 Key 和 `securityJsCode` 会按官方直接加载方式用于浏览器初始化，不是仅留在服务器的私钥；请使用 Web 端应用并配置域名限制，不要填写其他后端服务凭据。

## 5. 坐标和现有功能

- RTK 经纬度、遥测数值和内部轨迹采样始终保留 **WGS84 原值**。
- 高德地图上的船位、分色轨迹、目标/实际速度箭头统一在显示入口转换为 **GCJ-02**，只转换一次。经纬度数字栏仍显示 RTK 原始坐标。
- 转换复用现有近似算法；地图底图和换算精度不代表 RTK 的厘米级精度。不要将转换结果回传给单片机 PID 或替换原始定位数据。
- 未配置高德时，OSM 使用 WGS84，不进行 GCJ-02 偏移。
- 地图保持二维、北向朝上，支持跟随/回到船位、缩放、分色轨迹和速度箭头隐藏；深浅主题同步切换。
- 从 v1.9.1 起，底图就绪后无需连接无人船或收到 RTK 定位即可浏览、平移和缩放；未定位只显示角落提示，有效定位才出现船位和速度箭头。

## 6. 常见现象

| 现象 | 检查项 |
| --- | --- |
| 显示“高德未配置” | 两项是否均为 32 位十六进制；界面保存是否成功并已刷新；环境变量方式是否重启服务；Key 类型是否为 Web端（JS API） |
| 找不到地图设置或提示需要管理员 | 线上网页是否至少 v1.9.0；是否启用平台账户并登录管理员；访客和未启用账户模式不可保存 |
| 保存失败 | 查看界面提示；自建服务的配置目录是否可写；不能用只读源码目录替代运行数据目录 |
| 改了环境变量仍使用旧 Key | 已保存配置优先，直接在管理员设置中更改；清空保存表示停用，不是恢复环境变量 |
| SDK 请求失败或超时 | 浏览器网络能否访问 `webapi.amap.com`；本地/服务器域名是否在白名单中；网络策略是否允许高德资源 |
| 地图空白或鉴权错误 | 检查控制台 Key 的服务类型、配套安全密钥、域名、额度；浏览器开发者工具中查看高德返回的错误信息 |
| 控件可见但底图空白，控制台出现 CSP / EvalError / WebGLRender 错误 | 旧版 CSP 拦截高德脚本或地图数据；按下节升级完整网页服务，不能只替换前端文件或重新填写 Key |
| 坐标数字与地图不一样 | 数字栏是 WGS84，地图位置是 GCJ-02；这是显示转换，不要再次手工偏移 |
| 更新代码后还显示旧地图 | 确认当前服务版本，界面保存后点击刷新页面；检查地图底部当前提供方提示 |
| 配好高德后刷新仍显示 OSM | 当前浏览器记住了 OSM 选择，点击地图下方“切换至高德”；清空并停用高德配置后仍只能使用 OSM |

尚无真实 Key 时可运行 `npm run test:amap:browser` 验证前端与配置接口、坐标转换和覆层对齐。该检查使用明确标注的模拟 SDK，不能替代填写真实 Key 后的联网验证。

### 高德空白与 CSP 修复

`v1.10.0` 及更早的 CSP 不兼容真实高德 JS API 2.0：会拦截动态脚本、WebAssembly、内联尺寸检测脚本、初始化接口或地图样式/数据资源。即使配置接口和 SDK 都返回 HTTP 200，也可能只有控件和底色。修改点在 `server/map-config.js` 的 `MAP_CONTENT_SECURITY_POLICY`，由 `server.js` 返回 HTTP 响应头，不需要修改 STM32 或 RTK 协议。

`v1.10.1` 兼容配置为高德增加 `unsafe-inline`、`unsafe-eval` 和 `wasm-unsafe-eval`，并明确列出实测所需的高德脚本、样式、地图数据和图片域名。动态执行与内联脚本权限作用于整个页面，无法用域名列表只限给高德；这是直接加载官方 SDK 的兼容取舍。仍限制外部资源域名、禁止 HTML 内联事件（`script-src-attr 'none'`），保留 Worker、对象、基址与页面嵌入限制；不移除整条 CSP 或开放任意域名。

应用步骤：

1. 先将本次完整网页源码上传至独立的 `UnmannedBoat-Web` 仓库。仅修改本地文件不会改变服务器响应头。
2. 管理员在网页“更新”入口检查并安装该提交；手动部署时同样需要更新服务端文件，并重启 `unmanned-boat-web.service`。
3. 浏览器使用 `Ctrl+F5` 刷新，点击“切换至高德”。无需船端在线或收到定位，应能浏览默认区域。
4. 若 Nginx 另行添加了 CSP，需同步更新或移除重复的旧 CSP；浏览器会同时执行多份策略，Node 放行不能覆盖另一份拦截规则。可用 `curl -I https://boat.coffeebean66.tech/` 核对实际响应头。
5. 浏览器开发者工具中确认没有高德资源的 CSP 拦截、`EvalError` 或 `WebGLRender` 错误，并目视确认地名/道路已显示；仅有 SDK 200 或“地图初始化完成”不代表后续瓦片全部正常。

加载判断也已修改：`public/map-view.js` 等待高德 `complete`，15 秒未完成或收到 `error` 会明确提示，仍可切换 OSM；渲染等待期间销毁页面会取消监听和计时，不会重新创建地图。后续高德资源触发 `securitypolicyviolation` 时保留警告，避免误报完全成功。
