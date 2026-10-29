# 网页上传固件与 STM32 无线升级

适用于本项目的 STM32H753ZI 电控板，沿用板载以太网和 MQTT。网页管理员在对应船卡点击 **固件升级**，上传 OTA 应用 `.bin`；服务器分块传输到单片机备用 Flash，校验完整后重启，由专用 Bootloader 安装。浏览器可以关闭，升级任务继续在服务器执行。

**第一次不能只更新网页。** 需先用 ST-LINK/USB 有线安装 Bootloader 和 OTA 应用，并配置板端、Bootloader、服务器共用的 OTA 密钥。普通 Release 固件仍从 `0x08000000` 启动，不具备 OTA 接收功能；OTA 应用必须链接到 `0x08020000`。不支持通过此入口远程安装 Bootloader。

## 1. 首次准备单片机

固件源码在主仓库的 [UnmannedBoat_Controller](https://github.com/Coffeebean66/UnmannedBoat/tree/main/UnmannedBoat_Controller)，不包含在独立 Web 仓库中。具体构建、首次选择扇区烧录和恢复步骤见[固件端 OTA 接入教程](https://github.com/Coffeebean66/UnmannedBoat/blob/main/UnmannedBoat_Controller/OTA_SETUP.md)。

1. 在固件目录运行 `python tools/ota_key.py`，生成私密头文件 `Core/Inc/boat_ota_key.local.h` 和服务器导入文件 `ota-key.local.env`。工具不会显示或覆盖已有密钥；请备份，不要上传到 GitHub。
2. 使用同一密钥构建 Bootloader 和 OTA 应用。应用使用 `cmake --preset OTARelease`、`cmake --build --preset OTARelease`，得到 `build/OTARelease/UnmannedBoat_Controller.bin`。Bootloader 的独立构建方法见固件教程。
3. 首次通过 ST-LINK 分别将 Bootloader 烧到 `0x08000000`、OTA 应用烧到 `0x08020000`。使用选择扇区擦除，避免整片擦除已有参数；下载区和升级记录区也应按固件教程初始化。
4. 保持原船端 MQTT 设备 ID、账号和服务器地址配置。重启联网后，这艘船会每秒上报 OTA 能力；网页无需另开连接或新增串口。

Flash 分区：Bootloader 128 KiB、OTA 应用 640 KiB、下载区 640 KiB、升级记录 128 KiB。原参数区 `0x081C0000`～`0x081FFFFF` 保留；不能将它改作固件暂存区。当前最大应用文件为 **655360 字节**，网页接受 `.bin`，不接受 `.elf`、`.hex`、Bootloader 或普通直烧 `.bin`。

## 2. 配置服务器

前提是已部署新版 Web，启用平台账户和 MQTT，且有管理员账户。OTA 未配置时默认关闭，原监测、视频和调参继续可用。本功能不使用 Docker，不额外监听公网端口。

将板端工具生成的 `ota-key.local.env` 安全复制到服务器，例如先传至仅自己可读的临时位置，再安装到配置目录：

```bash
sudo install -o root -g root -m 600 /path/to/ota-key.local.env /etc/unmanned-boat-web/ota.env
sudo systemctl edit unmanned-boat-web
```

在编辑器中加入以下 drop-in，并保存：

```ini
[Service]
EnvironmentFile=/etc/unmanned-boat-web/ota.env
```

文件中唯一必需配置为 `BOAT_OTA_KEY=` 后接 **64 个十六进制字符**，与生成的板端私密头一致。不要使用示例、测试密钥，不要把密钥填到浏览器或 MQTT 设备密码框。设备登录密码与 OTA 密钥用途不同；升级密钥保存在服务器与固件中。

已有受管理 MQTT 服务器还需从新版完整 Web 源码目录按以下顺序更新。先更新 root MQTT 管理组件；安装脚本会重启网页服务，但不会迁移已有 ACL 或重载 Broker：

```bash
sudo bash maintenance/install-mqtt-device-admin.sh
```

再显式补齐已有设备及桥接账号的参数和 OTA 主题权限：

```bash
sudo node maintenance/configure-parameter-acl.cjs /etc/unmanned-boat-web/acl /etc/unmanned-boat-web/runtime.env
```

脚本输出 `1` 表示 ACL 已修改，并在配置目录保存 `acl.before-parameters-*` 恢复副本；输出 `0` 表示权限已齐全。原密码和无关 ACL 保留。仅在输出 `1` 时向运行中的 Broker 发送 HUP，使其加载新 ACL：

```bash
sudo systemctl kill --kill-whom=main --signal=HUP unmanned-boat-mqtt.service
```

确认 ACL 迁移成功并完成所需的 Broker 重载后，最后统一重载、重启网页服务，让 OTA 配置和主题订阅生效：

```bash
sudo systemctl daemon-reload
sudo systemctl restart unmanned-boat-web
sudo systemctl status unmanned-boat-web
```

最后这次网页重启必须在 ACL 生效之后；若此前 OTA 订阅曾被旧 ACL 拒绝，只重载 Broker 不一定会重新订阅。普通网页“更新”只替换应用，不替换 root 管理组件，也不会执行这次 ACL 迁移；新的设备创建和首次部署已生成对应 ACL。使用自建外部 Broker 时，手动为每艘船与桥接账号配置下表权限，并在权限生效后重启网页服务；不要给视频账号授予这些主题。

| 主题 | 所属船端账户 | 服务器桥接账户 |
| --- | --- | --- |
| `boats/<设备ID>/firmware-command` | 只读 | 写 |
| `boats/<设备ID>/firmware-response` | 只写 | 读 |
| `boats/<设备ID>/firmware-capability` | 只写 | 读 |

三类消息都不使用 retained；历史能力或旧响应不能启动升级。所有船仍使用不同设备 ID、MQTT 账号；单次升级及响应按设备、连接会话与随机传输 ID 隔离。当前服务器配置一个 `BOAT_OTA_KEY`，通过它升级的板端须安装同一密钥。

若在 Windows 本机测试，Node 不会自动读取 `.env`。请将生成文件中的 `BOAT_OTA_KEY` 设为当前 PowerShell 进程环境变量，再按 README 启动服务，同时配置管理员与实际 MQTT Broker；不要把含密钥的命令或终端截图提交到仓库。

## 3. 从网页升级

1. 登录管理员账户，从所需无人船的卡片点击 **固件升级**，或从“当前无人船”菜单进入。弹窗明确显示目标设备 ID；进入弹窗只查询能力和任务，不会烧录。
2. 将遥控 CH6 设为低档，两路电机停稳且反馈正常满 1 秒。保持供电、网口及 MQTT 链路稳定，等待“设备已就绪”。单片机还会在执行时重新核对停机条件。
3. 选择本次用相同密钥编译的 OTA 应用 `.bin`，点击 **上传并升级**，核对目标船与文件名后确认。服务器验证大小、栈指针和复位向量，生成带 HMAC 的清单，再逐块发送。
4. 查看 **等待准备 → 传输固件 → 校验下载内容 → 等待重启验证 → 升级完成**。进度条是设备已确认的下载字节；下载 100% 后仍需等待重启确认，不能据此判断安装成功。
5. 新启动的应用上报新启动标识，且实际固件 SHA-256 匹配本次文件时，服务器才显示 **升级完成**。重启后按原停机解锁流程恢复控制，建议先读取参数核对，再进行水测。

升级期间 STM32 锁定推进为中位，并拒绝参数写入与 Flash 保存。服务器同样限制同一船的调参和 OTA 同时执行。不同船的任务独立，服务器最多同时处理 4 个升级任务、2 个文件上传；每块 256 字节，收到匹配响应后才发下一块，丢包最多尝试 3 次。

安装提交前可点击 **取消传输**，之后不能取消。关闭弹窗、断开当前详情或退出账户都不自动取消后台任务；再次打开同一船可继续查看。任务和固件暂存在服务器有界内存中，**重启或更新网页服务会中断未提交的任务，不能跨服务器重启续传**。因此升级船端时不要同时点击网页顶部的“更新并重启”。

## 4. 失败处理与边界

| 现象 | 检查方法 |
| --- | --- |
| 服务器未配置 OTA | 检查 systemd 是否加载 `ota.env`，密钥是否恰好 64 位十六进制，平台账户和 MQTT 是否启用 |
| 在线但没有升级能力 | 确认已安装 OTA 应用而非普通 Release；检查三个主题的 ACL，等待当前连接的新能力消息 |
| 设备未就绪或停机条件不满足 | CH6 低档、电机转速反馈正常并停稳，等待至少 1 秒；结束正在进行的参数 Flash 保存 |
| 文件向量不匹配 | 上传 `build/OTARelease/UnmannedBoat_Controller.bin`；原 `build/Release` 的应用地址不对 |
| 身份校验失败 | 检查服务器、应用和 Bootloader 密钥一致；不要随意重新生成密钥，网页无法远程修改 Bootloader 密钥 |
| 传输超时或断线 | 未提交时保留旧应用，恢复网络、重新停机后重传；没有断点续传，迟到旧会话响应无效 |
| 显示尚未确认升级结果 | 安装指令可能已经生效；先检查设备是否重启、联网及固件摘要，再决定后续操作，不要把它当成成功或立即反复重试 |
| 设备不启动 | 使用 ST-LINK 检查升级记录和应用，必要时重新安装；选择性擦除 OTA 区，保留参数和正确 Bootloader |

完整下载、签名、摘要及向量通过后才会擦写应用。**已经完整提交的候选，在复制应用阶段断电，Bootloader 下次会从下载区重新安装。** 若在升级记录/提交字编程时断电造成不完整记录或 ECC 错误，Bootloader 保守停机，可能需要 ST-LINK 恢复；因此不能承诺任意时刻断电都可自动恢复。本实现不提供运行故障检测、自动回退到上一版本或 Bootloader 自更新；上传可启动但有业务问题的固件仍需人工恢复/升级。

服务器会签发本项目地址范围内的管理员上传镜像；HMAC 防止无密钥伪造固件，不替代管理员审核。当前船端 MQTT 使用普通 TCP，没有链路加密，遥测和固件内容仍可被旁路观察；生产环境需按实际网络配置访问隔离。

协议字段见[OTA_PROTOCOL.md](https://github.com/Coffeebean66/UnmannedBoat/blob/main/UnmannedBoat_Controller/OTA_PROTOCOL.md)。本功能需完成有线初始化才能在实船使用；本地编译、模拟传输和浏览器验证不代表已烧录或实船验证。
