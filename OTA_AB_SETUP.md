# A/B 无线升级与自动回滚

Web `v1.44.0` 同时支持原复制式OTA和新A/B方案，按船端能力自动选择。首次迁移必须有线更新 **A/B Bootloader与A区应用**，不能只更新网页。

## 固件准备

后续更新至Web `v1.45.0`及配套在线LQR调参固件时，已安装A/B方案的船只需更新应用包，无需重刷Bootloader。新参数存档保留旧固件可读前缀，但旧固件重新保存可能丢失LQR扩展；升级顺序和备份方法见[在线调参与回滚兼容](OPTIMAL_CONTROL_SETUP.md#flash-存档与回滚兼容)。

在主项目 `UnmannedBoat_Controller` 目录执行：

```powershell
cmake --preset OTAAB
cmake --build --preset OTAAB
```

IDE配置预设选择 **`A/B OTA - package (.boatota)`**，构建预设选 `OTAAB` 后直接生成。该入口同时编译A区、B区及Bootloader，再生成完整包；原 `tools/build-ota-ab.ps1` 同样调用这个预设。Windows和Linux均可使用上述CMake命令。

新Bootloader位于 `build/BootloaderAB/UnmannedBoat_Bootloader.hex`，首次A区应用位于 `build/OTAAB_A/UnmannedBoat_Controller.hex`。日常上传 `build/OTAAB/UnmannedBoat_Controller.boatota`。复用现有私密密钥，与服务器一致。分区、选择扇区擦除和Linux编译见主项目 [A/B安装教程](https://github.com/Coffeebean66/UnmannedBoat/blob/main/UnmannedBoat_Controller/OTA_AB_SETUP.md)。

## 服务器

更新Web前后端并重启原服务，继续使用 `BOAT_OTA_KEY` 和原MQTT固件主题ACL，无需重新安装管理组件或改设备账号。管理员、驾驶员可以升级，访客不可；仍校验账户、同源与上传后的会话有效性。原服务器接入见 [OTA_SETUP.md](OTA_SETUP.md)。

每区上限640 KiB，双镜像包最多 **1310880字节（160 + 2×655360）**。反向代理需允许超过1MiB的包，例如Nginx现有站点 `server` 中设置 `client_max_body_size 2m;`，检查后重载。当前每份应用约100KiB，双包约200KiB。

## 操作与结果

1. 选船打开“固件升级”，“A/B OTA”显示当前区、已确认/试运行和回滚次数。
2. 选择 `.boatota`；服务端验证双地址、尺寸、两份SHA及整体摘要，只传当前空闲区的一份镜像。浏览器不能指定地址或签名。
3. 普通/强制升级沿用原停车条件；试运行时保持推进中位，控制/网络任务、MQTT订阅、QoS1遥测PUBACK连续正常10秒才确认。试运行不接受下一次升级。
4. 新启动ID、正确活动区、匹配SHA和 `confirmed=true` 同时满足才显示完成。试运行超时/崩溃后船端自动回旧区，平台收到回滚计数增加后显示“已自动回滚”。

60秒未确认主动复位，卡死由约32秒看门狗复位；试运行中人工复位/断电同样触发下次启动回滚。已确认版本正常断网不回滚。参数保留，回滚只恢复程序；确认后的故障由看门狗重启当前版本。

关窗口或网页不取消已提交的升级。新旧程序均无法联网时，网页显示等待/未知，不能凭超时断言板端结果；恢复联网后可查看活动区和回滚计数。服务器重启仍不恢复内存升级任务，船端已提交的启动选择/回滚独立执行。

原 `v1` 船继续上传单镜像 `.bin`，640KiB限制和重启摘要确认保持。A/B使用独立 `boardId=0x07530002`、`v=2` 能力；旧Bootloader不能通过原OTA入口直接迁移。
