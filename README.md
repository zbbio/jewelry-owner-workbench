# 珠宝店主四仓工作台 · Jewelry Owner Workbench

把一件珠宝从相册建档、建商品卡、回答“这件多少钱”，到制作和取回这件商品已确认的视频。面向店主，**不是商城**。主项目是在自己电脑上运行的移动 Web/PWA 原型；另附安卓有线试用壳源码。仓库不附 APK，也不是线上 SaaS 或已经接入外店的服务。

| 模块 | 已实现 | 边界 |
| --- | --- | --- |
| 相册 | 导入照片、摘要查重、建议同件归组、从原卡或相册补图 | 证据不足保留原图待核，不把同托板当同商品；跨角度识别仍有漏认 |
| 商品 | 一件一码、编辑有单位的尺寸和价格、记录版本 | 旧版本覆盖会被拒绝；不把未核实库存当现货 |
| 销售 | 从当前商品卡取报价、文案和引用，库存不明建待办 | 本地问答和操作规则；不调用收费模型、不代发顾客消息 |
| 内容 | 选本件获准素材、生成 MP4、预览并确认指定版本、按卡取回 | 普通取片优先已有批准版；重新选材不等于强制重剪，不向外店发布 |

## 下载与本地运行

通过本公开仓的 **Code → Download ZIP** 下载并解压，或克隆本仓。**进入你实际解压后包含 [启动隔离手机试用.ps1](启动隔离手机试用.ps1) 的目录**，同层还有 [server.mjs](server.mjs)、[package.json](package.json) 和 [requirements.txt](requirements.txt)。目录名可能带分支名或提交哈希。**下方路径只是示例，执行前请换成你实际的路径。** Windows PowerShell 中路径含中文或空格时，请保留引号：

~~~powershell
Set-Location -LiteralPath '.\公开 试用\实际解压目录'
~~~

以下命令中的文件路径都相对于这个目录。

需要 Node.js 23 或更新版本（内置 `node:sqlite`）；参考环境为 Windows、Node.js 23.11.1 和 Python 3.13。相册功能需要 Pillow、NumPy、OpenCV；制作视频还需 PATH 中的 FFmpeg、ffprobe（支持 libx264 和 drawtext）和可用的中文字体。仓库不附字体或编解码器。Node 端无须安装第三方 npm 包。

~~~powershell
python -m pip install -r '.\requirements.txt'
node '.\server.mjs'
~~~

也可执行 `npm.cmd start`（实际调用 `node server.mjs`）。在同一电脑打开默认地址 **http://127.0.0.1:4179/**。新数据目录首次启动时为空；可导入自己有权使用的试验照片，再补充尺寸和价格。默认演示数据在当前用户主目录下的 `.jewelry-owner-workbench-public/demo`。如设置 `WORKBENCH_DATA`，请用新的空目录，勿指向商家已有数据库。

服务只绑定本机回环地址。不要用公网隧道、反向代理或端口转发对外暴露这个演示服务。公开仓只提供源代码和测试，不附私有资料、店铺数据库、素材、凭据或既有设备配对。

### 隔离试用与可选安卓 USB 浏览器

下列命令也在仓库根目录执行。Windows PowerShell 5.1 使用 `powershell.exe`，PowerShell 7 使用 `pwsh.exe`；按已安装的解释器选一行。不带 `-UsbAndroid` 只在电脑本机启动隔离试用，不查找设备。

~~~powershell
powershell.exe -NoProfile -File '.\启动隔离手机试用.ps1'
pwsh.exe -NoProfile -File '.\启动隔离手机试用.ps1'
~~~

安卓 USB 试用另需安装 Android SDK Platform Tools（`adb` 在 PATH 中），并由测试者在**自己有权测试的设备**上启用 USB 调试、解锁并确认本电脑的调试授权。选对应的命令：

~~~powershell
powershell.exe -NoProfile -File '.\启动隔离手机试用.ps1' -UsbAndroid
pwsh.exe -NoProfile -File '.\启动隔离手机试用.ps1' -UsbAndroid
~~~

[启动脚本](启动隔离手机试用.ps1)保存为带 BOM 的 UTF-8，编辑时请保留 BOM。上述命令不改全局执行策略或系统编码；若所在环境禁止运行脚本，请遵守其策略。

默认端口为 4187，可用 `-Port` 指定。`-UsbAndroid` 默认只接受唯一一台已连接并授权的设备；多台时用 `-Serial` 明确选定测试设备。若事先检测到端口占用则提示换端口。

启动后按终端提示，在本机或启用 USB 的测试手机浏览器中打开试用页（默认 **http://localhost:4187/pilot**），输入本次启动的临时口令，不要截图、抄录或转发口令。隔离数据在 `%LOCALAPPDATA%\JewelryOwnerWorkbenchPublic-Trials` 下；`-Shop` 选择独立子目录，同一名称再次启动会复用其本地试用数据。正常结束按 Ctrl+C；清理只针对本次启动建立的映射。

**本公开试用版是本地移动网页，不会安装 APK。**

### 11 月 24 日更新

- 快速切换商品时，只显示最后选中的商品；上一件的迟到答复不会串到当前商品。更新后若提示旧商品记录不带店铺信息，请在本店重新选一次商品。
- 可在原商品卡取回已确认的视频。旧播放链接仍可用；从商品卡发出的新链接会核对商品版本，版本不符时提示重新打开。
- 本次公开更新仍是本地网页试用；仓库新增 Android 壳源码，但不附 APK、真实店铺图片、线上后端或模型凭据。

### 回归与实测边界

~~~powershell
npm.cmd test
node --test '.\tests\launcher-powershell.test.mjs'
~~~

第一行跑仓库完整测试入口（等同 `node --test`）；合成业务回归用程序生成的图片、临时 SQLite 和短视频，不用真实店铺资料。视频测试需满足上述依赖。第二行只跑 [Windows 启动脚本回归](tests/launcher-powershell.test.mjs)；非 Windows 或缺少对应解释器时会跳过相应项，跳过不算通过。

本轮用真实 Windows PowerShell 5.1 和 PowerShell 7 解析脚本，两者均无语法错误。从含中文和空格的隔离目录用 `-NoProfile -File` 执行时，替身回归检查了不带 USB 时的启动参数、`-UsbAndroid` 分支的定向映射与回收调用、以及已有映射时拒绝启动。另用无授权设备的 ADB 替身确认，`-UsbAndroid` 会在设备检查处按预期退出。

这些结果只证明脚本可解析、参数和分支按预期传递。**本轮未建立真实 USB 映射、未在真机浏览器试用，也未验证真机问价或播放。** 目前不包括支付、结算、顾客消息自动发送或真实外店发布。

## 许可

本仓库的项目代码和公开版图标使用 [MIT 许可证](LICENSE)。运行时单独安装的库、FFmpeg、编码器和系统字体保留各自条款；MIT 不授予他人照片、商品或音视频的使用权。

## 安卓 App 源码

[安卓有线试用壳源码](android/n14-shell/)也在本仓库。它负责打开电脑端助手，不包含手机安装包、店铺数据库或真实图片。仓库里的网页试用脚本走手机浏览器，不是该 App 所需的专用电脑服务。完整的同事试用包、配套服务和无线版本尚未发布。详见[安卓源码说明](android/n14-shell/README.md)。
