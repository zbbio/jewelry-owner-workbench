# 模型驱动的店主助手演示 · 源码入口

这是现有本地 MVP 和便携版的公开源码副本：店主下指令 → DeepSeek 选工具 → 本地工具执行 → 图形结果页。四能力按需调用，不是固定顺序。与根目录旧工作台并存，不覆盖其启动方式。

## 推荐：Windows 一键演示

完整解压仓库后，双击**仓库根目录「一键启动四功能演示.cmd」**，或本目录「启动演示.cmd」。首次联网自动校验下载专用运行时和锁定依赖、生成合成数据，再打开本机密钥配置页。已有资料与已安装环境保持不动，下次无需重复下载。无需预装 Node/Python，不修改系统运行环境或全局执行策略。

步骤、四个演示场景、预期结果、停止和恢复说明见[演示操作指南](演示操作指南.md)。一键入口当前只覆盖 Windows 10/11 x64；其他平台可自行按下面源码方式准备，但本轮未验。

## 新同步的实现

- 相册：扫描图片目录、视觉分类、原图不动、结果链接 `/gallery`；模型异常批次明示待确认。
- 商品：从分类结果和价格 Excel 建结构化草稿，图形列表和详情 `/catalog`；价格按文件名匹配，不由模型猜。
- 销售：保留店铺手机框内客服、原会话自动回复、SQLite 去重/重开、店主双窗观察、不同来源隔离。私有店铺原页面改为明确标记的简易合成夹具；接自己的商店时替换适配页和接口，不需要新做商城。
- 内容：三镜头清单，`produced=false`，不生成或发布视频。
- 便携：相对数据目录、双端口统一、启动/停止/环境自查/数据恢复 CMD 和 Python 启动器；密钥首次在本机页面录入、Windows DPAPI 加密，不写到手机或源码。

当前 `app/agent.mjs` 复用既有 fetch DeepSeek 的实现；没有把本次同步冒称为新增完成 Agents SDK 集成。

## 源码方式运行

安装 Node 23.11.1（内置 `node:sqlite`）和 Python 3.13。运行下列命令前，先进入本目录：

```powershell
python -m pip install -r requirements.txt
python -B app/create-demo-data.py
$env:MVP_PYTHON = (Get-Command python).Source
$env:MVP_PREVIEW = '1'
node app/server.mjs
```

另开同目录的终端，执行：

```powershell
$env:MVP_PREVIEW = '1'
node app/anran-server.mjs
```

打开本机 `http://127.0.0.1:4297/`，看分类和卡片页面；点销售接待可看示例店。**预览模式不调用模型，也不会伪装整理/自动回复成功。** 这两条终端命令启动的会话分别用 Ctrl+C 停止。

要实际调用模型，在两个服务的环境中设置自己的 `DEEPSEEK_API_KEY` 并移除 `MVP_PREVIEW`，重新启动。请通过自己的秘密管理工具注入，不把明文值写入 Git、聊天或前端。相册与建卡使用当前视觉 API，是否可调用由账号和 API 实际返回决定；付费调用需联网与额度。点击相册/商品卡会重新处理合成图片，已有图形结果是夹具，不算模型识别成绩。

公开例子货号为 `DEMO103`、`DEMO105`，示例价分别240、260；不对应任何真实商品。未登记证书时应核实，不编造。源码自带的知识示例是新写的合成短句，不是商家原客服 Excel。

## 使用便携启动器源码

公开仓不存 Node/Python EXE、DLL 或私人完整演示 ZIP。新的 bootstrap.ps1 / bootstrap.py 按 runtime-lock.json 从 Node/Python/PyPI 官方分发源下载，SHA256 核验后在本目录准备运行时和三份依赖，并保留许可证。当前固定版本沿用既有演示测试环境，非生产服务版本建议。若需自行离线准备，可按各上游许可提供以下运行时目录：

- `runtime/node/node.exe`
- `runtime/python/python.exe`（以及该 Python 对应的标准库、Pillow/openpyxl 和上游许可证）

在线一键入口自动准备数据，无需手动运行生成器；离线预置方式再用上面的生成器。启动器只支持 Windows x64 的 DPAPI；同一目录已保存的密钥下次复用。停止后「恢复初始演示.cmd」先备份生成结果再恢复种子数据，不删原图。源码方式运行无需这两个 runtime 目录。

## 本地回归（不收费）

先创建合成数据，再运行：

```powershell
node app/test.mjs
node app/test-gallery.mjs
node app/test-catalog.mjs
node app/test-portable.mjs
node app/test-partial-results.mjs
```

图形页面、130合成图片/卡片、路径边界、中文空格搬迁、双端口、来源隔离、空库/重启和异常提示分开验证。fixture 工具单测不等于真实模型、安卓或云端验收；根目录旧工作台回归继续使用根目录 `npm test`。

## 发布边界与许可

自有源码沿用根 MIT；本目录不含商家原图/视频、真实价格表/客服表、店铺素材、数据库、会话、密钥、签名或服务器登录包。程序生成的示意图仅测试流程。数据、runtime 和 userdata 均已忽略；使用自己的业务资料时仍保留相同隔离。第三方运行时按其各自条款安装，本仓 MIT 不替第三方授予许可。
