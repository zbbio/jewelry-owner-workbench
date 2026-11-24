// Portable frontend race regression: real app.js in a small DOM/HTTP test double.
// Does not claim browser or phone coverage, open a DB, or create media.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const pause=()=>new Promise(r=>setImmediate(r));
async function until(f,msg){for(let i=0;i<100;i++){if(f())return;await pause()}assert.fail(msg);}
function gate(){let release;const promise=new Promise(r=>release=r);return {promise,release};}
function harness(){
 class El{
  constructor(tag){Object.assign(this,{tagName:tag.toUpperCase(),children:[],textContent:'',listeners:new Map(),dataset:{},attrs:{},value:'',classList:{add(){}}});}
  *walk(){yield this;for(const c of this.children)yield* c.walk()}
  append(...els){for(const e of els){if(!(e instanceof El))continue;e.parent=this;this.children.push(e)}}
  replaceChildren(...els){for(const e of this.children)e.parent=null;this.children=[];this.append(...els)}
  get options(){return this.children}
  get isConnected(){return this===root||!!this.parent?.isConnected}
  get blocked(){return !!(this.inert||this.parent?.blocked)}
  setAttribute(k,v){this.attrs[k]=v} removeAttribute(k){delete this.attrs[k]}
  querySelector(q){return [...this.walk()].find(e=>e!==this&&e.tagName===q.toUpperCase())||null}
  addEventListener(k,v){this.listeners.set(k,v)}
  click(){if(this.isConnected&&!this.blocked&&!this.disabled)this.listeners.get('click')?.({target:this,isTrusted:false})}
  scrollIntoView(){}
 }
 const root=new El('main'),section=new El('section');root.append(section);
 for(const m of html.matchAll(/<([a-z0-9]+)\b[^<>]*\bid="([^"]+)"/gi)){const e=new El(m[1]);e.id=m[2];section.append(e)}
 const by=id=>[...root.walk()].find(e=>e.id===id);
 const storage=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)}};
 const store=storage(), network=[], gates=new Map();
 const hold=(kind,id)=>{const g=gate();gates.set(kind+id,g);return g};
 const card=id=>({productId:id,productVersion:1,assetIds:[],fields:{price:{value:id==='A'?111:222,unit:'元'}}});
 async function fetch(path,opts){
  const body=opts?.body?JSON.parse(opts.body):null;network.push({path,body});
  const id=path.split('/')[3],kind=body?.question?'ask':'get',key=kind+(body?.productId||id);
  const held=gates.get(key);let status=200;if(held){gates.delete(key);status=await held.promise||200}
  let data;
  if(status!==200)data={error:{message:'not found'}};
  else if(path==='/api/cards')data=['A','B'].map(card);
  else if(path==='/api/tasks')data=[];
  else if(path==='/api/desk/tasks')data={inventory:[],video:[]};
  else if(path==='/api/sales/ask')data={status:'answered',answer:'答复:'+body.productId,productRef:{productId:body.productId,productVersion:1}};
  else if(path.endsWith('/video'))data={productId:id,works:[],tasks:[]};
  else if(id==='A'||id==='B')data=card(id);else throw Error('unexpected '+path);
  return new Response(JSON.stringify(data),{status,headers:{'X-Workbench-Card-Scope':'shop1'}});
 }
 vm.runInNewContext(source,{document:{getElementById:by,createElement:t=>new El(t),querySelector:q=>q==='main'?root:null,querySelectorAll:q=>q==='main section'?[section]:[]},window:{isSecureContext:false},crypto:webcrypto,fetch,sessionStorage:store,localStorage:storage(),location:new URL('http://localhost/'),URL});
 const select=id=>by('cards').children.find(c=>c.dataset.productId===id).querySelector('button').click();
 const shown=()=>by('card-detail').children[0]?.dataset.detailProductId;
 const ask=()=>{by('ask-input').value='这件多少钱？';by('ask-submit').click()};
 const answers=()=>by('sales-result')?.children.map(e=>e.textContent).join(' ');
 const posted=()=>network.filter(n=>n.path==='/api/sales/ask').map(n=>n.body.productId);
 return {by,root,section,select,shown,ask,answers,posted,hold,network,ready:()=>until(()=>by('cards').children.length===2&&!section.blocked,'initial list')};
}
for(const late of [200,404])test('A detail '+late+' last: B is selected and receives the only question',async()=>{
 const h=harness();await h.ready();const a=h.hold('get','A'),b=h.hold('get','B');
 h.select('A');h.select('B');assert.equal(h.by('ask-submit'),undefined);assert.deepEqual(h.posted(),[]);
 b.release(200);await until(()=>h.shown()==='B','B did not open');a.release(late);await pause();assert.equal(h.shown(),'B');
 h.ask();await until(()=>h.answers()?.includes('答复:B'),'B answer missing');assert.deepEqual(h.posted(),['B']);
});
for(const late of [200,404])test('A sales '+late+' last: ask B while A awaits its answer',async()=>{
 const h=harness();await h.ready();h.select('A');await until(()=>h.shown()==='A','open A');
 const a=h.hold('ask','A');h.ask();await until(()=>h.posted().length===1,'A not asked');
 const b=h.hold('get','B');h.select('B');assert.equal(h.by('ask-submit'),undefined);b.release(200);
 await until(()=>h.shown()==='B','B not selectable while A pending');h.ask();await until(()=>h.answers()?.includes('答复:B'),'B reply did not render before A reply');
 a.release(late);await pause();assert.equal(h.shown(),'B');assert.match(h.answers(),/答复:B/);assert.deepEqual(h.posted(),['A','B']);
});
