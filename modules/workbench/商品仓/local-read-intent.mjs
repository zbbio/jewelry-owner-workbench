// Pure S1 read-action classifier extracted byte-for-byte (LF) from 销售仓/s1.mjs; no SDK imports.
// Source region SHA256: 84bfd131f2e834bbfc783739e48d963a26484d1af3b1311d08238d6770c1e5d2
const quoteWords = /多少钱|多少元|怎么卖|什么价|问价|询价|售价|卖价|价格|报价|(?:的价|价和片|价与片|价、片|价和视频)/u;
const prior = /(?:以前|以往|之前|原来|先前|上回|上次)(?:的|那[条段个部]|[这那]次){0,3}/.source;
const video = /(?:视频|短片|片子|实拍)/.source;
const clipWords = new RegExp('旧(?:片|视频)|原(?:片|视频)|已有视频|'+prior+'(?:旧)?'+video+
  '|上次.{0,7}(?:视频|那条|那段)|(?:看看|看|找|给我).{0,14}'+video+'|价[和与、](?:片|视频)|片(?:也|都)?给我','u');
// Scope refusals by their target. A plain “不问” is enough; no creation
// is independent of no lookup.
const no = /(?:先\s*)?(?:不(?:需要|要|用|必|想)?|别|无需|无须)\s*(?:再\s*)?/.source;
const readVerb = /(?:看看|看|寻找|找|调取|调|取|查看|查询|查|问|报|询|拿|要|给(?:我)?|播放)/.source;
const priceTarget = /(?:多少钱|多少元|怎么卖|什么价|售价|卖价|价格|报价|问价|询价|价)/.source;
const videoTarget = /(?:旧(?:片|视频)|原(?:片|视频)|视频|短片|片子|实拍|片)/.source;
const gap = /(?:(?!(?:看看|寻找|找|调取|查看|查询|查|问|不|别|无需|无须|(?:新|重)?做|制作|拍摄)).){0,22}?/.source;
const lead = /(?:先\s*)?/.source+'(?:'+/(?:不要|不用|不必|不需要|不想|无需|无须)\s*(?:再\s*)?/.source+
  '(?:'+readVerb+')?|(?:不|别)\\s*(?:再\\s*)?'+readVerb+')';
const negatedBefore = new RegExp(lead+'\\s*'+gap+'(?:('+priceTarget+')|('+videoTarget+'))','gu');
const negatedAfter = new RegExp(/^(\s|同样|也|都|均|全)*/.source+no+readVerb+
  /(?:了|吧|呢|哈|也|$|(?=[^\p{Script=Han}\w]))/.source,'u');
const mention = new RegExp('('+priceTarget+')|('+videoTarget+')','gu');
const sharedNegative = new RegExp('(?:都|均|全)\\s*'+no+'(?:'+readVerb+')?','u');
const splitClause = /[，,。；;！？!?\n]|(?:但是|但|而是|反而|还是|只(?:想|要|需)?)(?=\s*(?:查询|查|看|找|取|调|问|报|给|播放))|也(?=\s*(?:不|别|无需|无须))/u;
function actionsOf(text) {
  const parts = text.split(splitClause).map(s => s.trim()).filter(Boolean);
  if (parts.some(s => /^(?:请)?(?:确认|批准|同意|发布|发送|改价|修改|去做|建草稿)|(?:把|将).{0,14}(?:价格|售价).{0,6}(?:改|设|调)|^(?!别|不|先别|先不)(?:请)?(?:帮我|给我)?(?:新建|新做|制作|拍摄|重剪)/u.test(s))) return [];
  const yes = new Set(), denied = new Set();
  const deny = m => denied.add(m[1]?'quote':'old_video');
  for (const p of parts) {
    // Earlier positive mentions of an action never override an explicit veto
    // in this turn, in particular a veto of a potentially billed price lookup.
    for (const m of p.matchAll(negatedBefore)) {
      deny(m);
      const joined=p.slice(m.index+m[0].length).match(/^\s*(?:和|与|跟|以及|及|、)\s*(.*)$/u);
      if(joined){
        for(const t of joined[1].matchAll(mention)) {
          if(t.index<=15&&!/找|查|问|看|给/u.test(joined[1].slice(0,t.index)))deny(t);
          break;
        }
      }
    }
    for(const m of p.matchAll(mention)){
      if(negatedAfter.test(p.slice(m.index+m[0].length)))deny(m);
    }
    const all=p.search(sharedNegative);
    if(all>0){
      const objects=p.slice(0,all);
      if(/和|与|跟|以及|及|、/u.test(objects))for(const m of objects.matchAll(mention))deny(m);
    }
    if(quoteWords.test(p))yes.add('quote');
    if(clipWords.test(p)&&!/^(?:先)?(?:不(?:要|用|必|需要|想)?|别|无需)(?:再)?(?:新做|做|制作|新建|重做|重剪|拍摄)/u.test(p))yes.add('old_video');
  }
  return ['quote','old_video'].filter(a=>yes.has(a)&&!denied.has(a));
}

export {actionsOf};
