import assert from "node:assert/strict";
import { runAgent } from "./agent.mjs";
const cases = [
  ["把今天这批珠宝照片按实物分组，先不要建卡", "album_classify_batch"],
  ["把第一组整理成一张商品卡，先保存为草稿", "catalog_create_or_read_card"],
  ["客人问这件有没有证书，帮我回一句，先别发", "sales_prepare_reply"],
  ["想看戴起来多大，给我列三个镜头，先别做片", "content_prepare_shooting_checklist"]
];
for (const [text, tool] of cases) { const r = await runAgent(text, { fixtureMode: true }); assert.equal(r.tool, tool); assert.equal(r.receipt.status, "completed"); }
console.log(`MVP four tools: ${cases.length}/${cases.length} passed`);
