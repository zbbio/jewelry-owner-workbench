import assert from 'node:assert/strict';
import { replyFor } from './agent.mjs';

for (const [tool, link, pending] of [
  ['album_classify_batch', '/gallery', '相关图片待确认'],
  ['catalog_create_or_read_card', '/catalog', '相关识别字段待确认'],
]) {
  const base={total:130,groups:{'项链':120,'待确认':10},classificationMode:'deepseek_vision'};
  const partial=replyFor(tool,{result:{...base,failedBatches:1}});
  assert.ok(partial.includes('1 批模型返回异常'),tool+' discloses failed batch count');
  assert.ok(partial.includes(pending),tool+' discloses confirmation status');
  assert.ok(partial.includes(`href="${link}"`),tool+' preserves visual results link');
  const complete=replyFor(tool,{result:{...base,failedBatches:0}});
  assert.ok(!complete.includes('批模型返回异常'),tool+' success has no invented failure');
  assert.ok(complete.includes(`href="${link}"`));
  const legacy=replyFor(tool,{result:base});
  assert.ok(!legacy.includes('批模型返回异常'),tool+' missing failure field remains compatible');
}
console.log('PASS partial-result disclosure: album/catalog batch failures visible; pending fields/images stated; original links preserved; success and legacy receipts unchanged. No model call.');
