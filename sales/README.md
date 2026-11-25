# 销售仓：问这件货

同步服务入口：`createSales({ db, catalog, content?, directory?, knowledge?, policy?, canAccessSales?, canRetrieveWork?, getInventoryMaxAgeMs?, now? })`。
只接服务端当前登录的 `ctx={shopId,actorId}`。调用方若有可随时撤销的店员角色，注入 `canAccessSales(ctx)` 查询当前授权；请求体里的店铺或操作者不参与鉴权。

- `ask(ctx, {requestId, sessionId, productId?, question, needVideo?})` 返回店主视图。面向顾客的话术是 `answer`，不是整个对象；供应商候选及库存核实依据只在店内使用。缺指代请澄清；给定的商品号不可见时统一 `PRODUCT_NOT_FOUND`，不返回旧回执。销售服务不外发消息。
- 商品仓的 `get(ctx, productId)` 给当前号、版本和结构化字段。标题/描述取 `.value`，人工尺寸带 `.unit`。库存须与同号同版 `getSummary(ctx, productId).inventory` 对上：核实状态、时间、核实人和依据齐备才引用该次核实。未接摘要、资料有缺、状态矛盾均按未知。`getInventoryMaxAgeMs(ctx)` 可注入本店核实有效期（毫秒）；未配置不代定天数，只报告带时间的核实记录，不保证预留或发货。
- 未知或过期保留一个同店同件的开放库存核实事项；`listTasks(ctx)` 供店主回查。新的问答读到有效核实记录才结清该事项，历史问答不重开它。首页待办数按 `status=open` 统计，内容任务由内容仓负责。`directory.search(ctx,{productId,tier})` 是获准的只读目录：先 `frequent`、无匹配再 `other`；两层都空与目录不可用分开。没有通知或送达回执。
- 视频只传 `{requestId: 原问答号 + ':video', productId, productVersion, demand, sessionId}`。销售先事务保存答复、库存事项和这份固定入参；提交后调用正式的 `content.requestVideo(ctx, input)`。中断后用原问答号重试，不按新卡版本重组旧需求。没有内容适配器时仅返回未接入的入参。内容已接但调用报错时不造视频回包，独立的库存事项仍可回查。
- `video` 是经过关联字段核对的 v1 回包。只有 `queued` 将内容方的持久 `taskId` 附在顶层 `taskIds` 中；`existing_available` 用 `workRef` 和 `retrievalStatus`，其余两态给下一步。旧片首次由内容核本件、许可与可播；已有销售请求重取旧片时额外调用服务端 `canRetrieveWork(ctx,{productId,workRef})` 复核该版本当前是否仍可取用。没有复核器则报 `VIDEO_ACCESS_RECHECK_REQUIRED`，撤权报 `VIDEO_ACCESS_DENIED`，不把历史引用当作现行许可。所有成功视频回包均为 `deliveryStatus=not_submitted`。
- 同店同操作同键同正文回原业务结果；先检查当前权限，异正文报冲突。公开商品字段、客户消息和模型均不改写库存。库存写入继续归商品仓。

**重跑（店主工作台目录）：**

```powershell
node --test --test-reporter=spec tests/sales.test.mjs tests/sales-composition.test.mjs
```

组合测试使用实际 `createCatalog`、`createContent` 和 SQLite。商品及核实依据均为合成数据，目录、作品、许可、媒体探测和店规有效期是 fixture；不是实物、真实可播媒体、店铺通知或外店消息验收。
