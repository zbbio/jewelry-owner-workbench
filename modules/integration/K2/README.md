# K2｜近期任务与待我确认

本模块是 K1 的五文件增量。普通输入框不读本模块的选项，侧栏也不转发输入。近期取当前 P1 身份最近五个话题的最后一条原消息，不是跨四仓全部在途作业的调度表。仅打开侧栏、查看就绪和定位原消息都是读操作。

## 生产接线与归属

- [upstream/group-tasks.js](upstream/group-tasks.js)：Mika 固定 e8479330f7284dd0031649636e18e197d6633ece 的三段完整源码；按待处理/进行中/已结束排话题，保留同话题多票。切片行号、blob、哈希和许可证在 [slice-map.json](upstream/slice-map.json) 和 [licenses](upstream/licenses)。
- [web/bridge.js](web/bridge.js) 的 recent、ready、openSource、openTicket、decide、k2DropSensitive 直接运行在 K1 已有闭包里。P1 消息标识及回执检查、K1 已编译的 Mika Kotlin 跳转都沿用。待确认列表和原消息卡是一张带确认号的票，不按摘要、当前页面选中的货或“好”反推。
- 实际可读的是 P1 消息与已认证 /api/n22/capabilities 的挂载状态。销售汇总的四仓当前就绪数据另列，缺失显示“待核实”，未挂载不判“可用”。使用 DOM textContent，页面不存身份、票据、商品记录。
- P2/S2 的扩展点只存在于构建时的私有投影，不是服务端协议、WebView 原生接口或授权来源。原窗未交合格接口时，默认无确认读写端口，无写按钮。测试夹具只供 CDP 验收，不进入发布 JS。不要用浏览器全局变量配置正式绑定。
- 确认、取消只能来自明确点击的原票。K2 先向原仓复读票，逐一核对确认号、话题、消息、运行号、对象、版本、后果、时限，再以 P1 精确 GET 核消息。确认时还须由 P2 在提交事务内原子复核身份、有效期、同对象版本及幂等；前端防双击不是事务保障。换版须重预览，撤权清除两处视图；HTTP 结果不明不自动重试。K2 不建票、不持有事务、不选择模型或业务处理器。

## 给原仓的最小接点（均为页面内形状）

原仓交实际 API 后才由商品仓审阅并在独立副本注入 ports.js；只在这里写 DTO 映射，不要求原仓照此更改合同。listPending() 返回当前店主可见且按最新优先的票数组，readPending(confirmationId) 必须重新核权、交回当前票或 HTTP 等价的拒绝；decide(ticket,"confirm"|"cancel") 返回原子处理后的同锚票。投影字段见 bridge.js 的 ticket()/same()，包括 confirmationId、conversationId、messageId、runId、objectId、objectVersion、summary、expiresAt、status。summary 必须完整代表这次操作的后果；原生产合同若有更多约束（如授权范围、票版本或不可变预览号），必须在权威端绑定，不得丢弃后直接启用。返回集过大时由 P2 提供可验证翻页，不静默截断或冒称全量。
销售仓 readiness() 给本店当前四仓状态、原因；源缺失与“不就绪”分开。P2 到货后需以真实隔离票检验列表/原消息同号、并发换版/撤权零业务写、明确同意至多一笔、取消无业务写，再做总控独验。

## 复测

PowerShell，从本 module 目录。所有端口仅回环、临时空店，不用共享手机或模型。
~~~powershell
node upstream/group-tasks.test.cjs
$h = Join-Path $env:TEMP ("n99-k2-"+[guid]::NewGuid())
python -B tools/integrate.py prepare --host $h
python -B tools/integrate.py apply --host $h
python -B tests/browser.py --host $h --out (Join-Path $env:TEMP ("k2-browser-"+[guid]::NewGuid()))
python -B tests/fullhost.py --evidence (Join-Path $env:TEMP ("k2-host-"+[guid]::NewGuid()))
python -B tools/integrate.py rollback --host $h
python -B tools/verify_delta.py --evidence (Join-Path $env:TEMP ("k2-delta-"+[guid]::NewGuid()+".json"))
~~~
浏览器测试复用 K1 已签收的本地夹具及 test-fullhost/tty_pair.py，后者只处理临时空店配对，不落配对值。需本机 Python（含 websocket-client）、Node 23、Chrome、K1 交件、P1 原 ZIP 与既有 npm 离线缓存。接件包不是第二个宿主发行包。更多见 [接入与回退](tools/接入与回退.md)。
