"""K2 empty-shop acceptance. Adapted from K1 fullhost.py (SHA256 543d57a5…); never operate the issued host."""
from pathlib import Path
import argparse,base64,hashlib,http.client,json,os,shutil,socket,sqlite3,subprocess,sys,tempfile,time,uuid,zipfile
from contextlib import ExitStack
import websocket
HERE=Path(__file__).resolve().parent; W=HERE.parent
def need(v,tag):
 if not v:raise RuntimeError(tag)
sha=lambda b:hashlib.sha256(b).hexdigest()
read=lambda f:json.loads(f.read_text('utf8'))
def put(f,o):
 f.parent.mkdir(exist_ok=True,parents=True);f.write_text(json.dumps(o,ensure_ascii=False,indent=2),'utf8')
def wait(fn,desc):
 end=time.monotonic()+22
 while time.monotonic()<end:
  try:
   v=fn()
   if v:return v
  except (OSError,ValueError):pass
  time.sleep(.1)
 raise RuntimeError(desc)
def get(port,path):
 c=http.client.HTTPConnection('127.0.0.1',port,timeout=2)
 try:c.request('GET',path);r=c.getresponse();return r.status,r.read()
 finally:c.close()
def terminate(p):
 if p.poll() is None:
  p.terminate()
  try:p.wait(4)
  except subprocess.TimeoutExpired:p.kill();p.wait(5)
def run(a,o):
 with tempfile.TemporaryDirectory(prefix='k2-fullhost-',ignore_cleanup_errors=True) as tmp, ExitStack() as end:
  t=Path(tmp);root=t/'tree';state=t/'state';state.mkdir()
  need(sha(a.zip.read_bytes())=='aa6cd0906cbc4a2660e4dd70be77589558c4e2d36247df9b0e18316b26199b14','P1 input digest')
  # Empty disposable copy of K1 first, then the K2 delta.
  env={k:v for k,v in os.environ.items() if k in {'PATH','SystemRoot','WINDIR','LOCALAPPDATA','USERPROFILE','TEMP','TMP','COMSPEC','PATHEXT','ProgramFiles','ProgramFiles(x86)'} or k.upper() in {'PATH','SYSTEMROOT','WINDIR','LOCALAPPDATA','USERPROFILE','TEMP','TMP','COMSPEC','PATHEXT','PROGRAMFILES','PROGRAMFILES(X86)'}}
  env.update(PYTHONIOENCODING='utf8',PYTHONDONTWRITEBYTECODE='1')
  cmd=[sys.executable,'-B',str(W/'tools/integrate.py'),'apply','--host',str(root),'--base',str(a.zip)]
  prep=[*cmd];prep[3]='prepare'; q=subprocess.run(prep,env=env,capture_output=True,text=True,encoding='utf8');o['prepare']={'argv':prep,'exit':q.returncode,'out':q.stdout};need(not q.returncode,'prepare failed: '+q.stderr)
  x=subprocess.run(cmd,env=env,capture_output=True,text=True,encoding='utf8');o['patch']={'argv':cmd,'exit':x.returncode};need(not x.returncode,'apply failed')
  npm=[shutil.which('node'),str(Path(shutil.which('node')).parent/'node_modules/npm/bin/npm-cli.js'),'ci','--offline','--ignore-scripts','--no-audit','--no-fund','--logs-max=0','--omit=dev']
  n=subprocess.run(npm,cwd=root/'app/a/b/c/销售仓',env=env,capture_output=True,encoding='utf8',errors='replace',timeout=100,creationflags=subprocess.CREATE_NO_WINDOW)
  o['dependencies']={'argv':npm,'exit':n.returncode};need(n.returncode==0,'offline npm ci failed: '+n.stderr[-400:])
  m=read(root/'release.json');ui=root/m['ui'];entry=root/m['entry'];shop='k2-fullhost-empty';mats=t/'materials';cards=mats/'cards.json';materials=mats/'materials.json';catalog=t/'catalog.json'
  put(cards,{'schema':1,'storeRef':shop,'cards':[]});put(materials,{'storeId':shop,'cards':{}});put(catalog,{'storeId':shop,'aliases':{},'rows':{n:[] for n in 'catalog_products catalog_product_assets catalog_inventory catalog_copy_versions catalog_receipts studio_choices studio_works'.split()}})
  with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  need(port>=30000,'port too low');origin='http://127.0.0.1:'+str(port)
  pins={f.name:m['files'][m['ui']+'/'+f.name] for f in ui.iterdir() if f.is_file()}
  cfg={'n22ContentContract':{'mode':'allow_empty'},'n22ContentDoctor':True,'packageReleaseId':m['releaseId'],'managerInstance':uuid.uuid4().hex,'allowAndroidHost':False,'modelPolicy':'disabled','stateDir':str(state),'storeRef':shop,'origin':origin,'releasePort':port,'materialDir':str(mats),'snapshotFile':str(cards),'snapshotSha256':sha(cards.read_bytes()),'materialSha256':sha(materials.read_bytes()),'contentArchive':None,'uiDir':str(ui),'uiSha256':pins['index.html'],'uiFileDigests':pins,'n22Root':str(root/'app/a/b/c'),'n22Ui':True,'n22CatalogSlice':str(catalog),'n22CatalogSha256':sha(catalog.read_bytes()),'n22CatalogSource':str(root/'app/店主工作台/catalog/index.mjs'),'n22StudioSource':str(root/'app/店主工作台/content/studio.mjs'),'n22PixelPython':sys.executable,'n22Adapters':{k:{'file':str(root/f),'export':sym,'sha256':m['files'][f]} for k,(f,sym) in m['adapters'].items()}}
  runtime=t/'runtime.json';put(runtime,cfg);env.update(N17_CONFIG=str(runtime))
  cmd=[shutil.which('node'),str(entry),'serve'];p=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW);end.callback(terminate,p)
  o.update(entry=m['entry'],entrySha256=sha(entry.read_bytes()),release=m['releaseId'],command=cmd,inputs={'shop':shop,'catalogRows':0,'content':'allow_empty','model':'disabled'})
  def health():
   if p.poll() is not None:raise RuntimeError('original host stopped: '+p.stderr.read().decode('utf8','replace')[-1200:])
   return json.loads(get(port,'/healthz')[1])
  h=wait(health,'health');o['health']={k:h[k] for k in ['ok','service','releaseId','mode','uiMounted','noModel']};need(h['uiMounted'] and h['noModel'],'host health')
  ready,rr=get(port,'/readyz');o['readinessHttp']=ready;need(ready==200,'host not ready: '+rr[:250].decode(errors='replace'))
  o['unauthHistoryHttp']=get(port,'/api/n22/conversations')[0];need(o['unauthHistoryHttp']==401,'unauthenticated history')
  startup=subprocess.STARTUPINFO();startup.dwFlags|=subprocess.STARTF_USESHOWWINDOW;startup.wShowWindow=0
  result=subprocess.run([sys.executable,str(W.parents[1]/'K1/workspace/test-fullhost/tty_pair.py'),str(entry)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NEW_CONSOLE,startupinfo=startup,timeout=35)
  o['operatorPairIssueExit']=result.returncode;need(result.returncode==0,'interactive issuer failed '+str(result.returncode))
  code=result.stdout.decode().strip();need(len(code)==19,'TTY issue')
  profile=t/'browser'
  chrome=Path(os.environ['ProgramFiles'])/'Google/Chrome/Application/chrome.exe'
  chromeCmd=[str(chrome),'--headless=new','--no-first-run','--disable-sync','--disable-background-networking','--disable-extensions','--disable-breakpad','--disable-gpu','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+str(profile),'--window-size=1100,900','about:blank']
  ch=subprocess.Popen(chromeCmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW);end.callback(terminate,ch)
  cdp=int(wait(lambda:(profile/'DevToolsActivePort').read_text().splitlines()[0],'Chrome CDP'))
  page=next(k for k in json.loads(get(cdp,'/json/list')[1]) if k['type']=='page');ws=websocket.create_connection(page['webSocketDebuggerUrl'],suppress_origin=True,http_no_proxy=['localhost','127.0.0.1'],timeout=7);end.callback(ws.close)
  seq=0
  def call(method,params=None):
   nonlocal seq
   seq+=1;i=seq;ws.send(json.dumps({'id':i,'method':method,'params':params or {}}))
   while True:
    r=json.loads(ws.recv())
    if r.get('id')==i:
     need('error'not in r,'CDP '+method);return r['result']
  def ev(s):
   r=call('Runtime.evaluate',{'expression':s,'returnByValue':True})
   return r.get('result',{}).get('value')
  def condition(s):return wait(lambda:ev(s),'unmet UI condition: '+s)
  def click(selector):
   q=json.dumps(selector);cx,cy=condition('(()=>{const b=document.querySelector('+q+');if(!b||b.disabled||!b.getClientRects().length)return null;b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()')
   for k in ['mousePressed','mouseReleased']:call('Input.dispatchMouseEvent',{'type':k,'button':'left','clickCount':1,'x':cx,'y':cy})
  def type_(q,v):click(q);call('Input.insertText',{'text':v})
  o['chrome']=call('Browser.getVersion')['product'];call('Page.enable');call('Page.navigate',{'url':origin+'/'})
  type_('input[name=code]',code);del code,result;click('#n15-pair button');condition('!!document.getElementById("k1-launch")')
  condition('document.readyState==="complete" && typeof document.querySelector("#k2-open")?.onclick==="function" && document.querySelector("#connection").textContent.includes("已连接")')
  click('#k2-open');condition('document.querySelector("#k2-panel").hidden===false')
  condition('document.querySelector("#k2-pending").innerText.includes("未接入") && document.querySelectorAll("#k2-ready li").length===4')
  o['unbound']={'noConfirmButtons':ev('document.querySelectorAll("[data-k2-choice]").length===0'),'warehouses':ev('document.querySelector("#k2-ready").innerText'),'authority':'P1 live capability read, no S2 readiness provider'}
  need(o['unbound']['noConfirmButtons'],'unbound port exposed decision')
  o['direct']=[]
  for opened in (True,False):
   if not opened:click('#k2-close')
   need(ev('document.querySelector("#k2-panel").hidden')!=opened,'wrong drawer state')
   wording='查货号 K2EMPTY'+('OPEN' if opened else 'CLOSED')+' 的商品资料'
   type_('#prompt',wording);click('#send')
   condition('Array.from(document.querySelectorAll("#thread .sent")).some(n=>n.textContent==='+json.dumps(wording,ensure_ascii=False)+')')
   condition('!document.querySelector("#thread article:last-child .replied").textContent.includes("正在")')
   mid=ev('document.querySelector("#thread article:last-child").dataset.messageId')
   reads=ev('performance.getEntriesByType("resource").filter(r=>new URL(r.name).pathname==="/api/n22/turn").length')
   o['direct'].append({'sidebarOpen':opened,'input':wording,'messageId':mid,'legacyRouteCount':reads,'reply':ev('document.querySelector("#thread article:last-child .replied").innerText')})
  need(o['direct'][0]['legacyRouteCount']==1 and o['direct'][1]['legacyRouteCount']==2,'ordinary route was not called once per submit')
  click('#k1-launch');condition('document.getElementById("k1-panel").open')
  for name in ['本机甲话题','本机乙话题']:
   type_('#k1-title',name);click('#k1-create');condition('document.querySelector("#k1-active").textContent==='+json.dumps(name,ensure_ascii=False));condition('Array.from(document.querySelectorAll("#k1-topics button")).some(b=>b.textContent==='+json.dumps(name,ensure_ascii=False)+')')
  rows=ev('Array.from(document.querySelectorAll("#k1-topics button")).map(e=>[e.dataset.cid,e.textContent])');need(len(rows)==2,'expected two created topics');o['topics']=rows
  (cid,title)=next(k for k in rows if '甲' in k[1]);click('#k1-topics button[data-cid="'+cid+'"]');condition('document.querySelector("#k1-active").textContent==='+json.dumps(title,ensure_ascii=False))
  type_('#k1-text','查货号 K2FULLHOST 的商品资料');click('#k1-send');condition('document.querySelector("#k1-messages article")?.dataset.status && !document.querySelector("#k1-send").disabled')
  o['message']=ev('(()=>{const e=document.querySelector("#k1-messages article");return {cid:e.dataset.cid,mid:e.dataset.mid,status:e.dataset.status,text:e.innerText}})()')
  click('#k1-close');condition('!document.querySelector("#k1-panel").open');click('#k2-open')
  cid=o['message']['cid'];mid=o['message']['mid'];click('#k2-recent button[data-message-id="'+mid+'"]')
  condition('document.activeElement?.dataset.k1Focused==="true"')
  o['recentFocus']=ev('({mid:document.activeElement.dataset.mid,cid:document.activeElement.dataset.cid,run:document.activeElement.dataset.run,key:document.activeElement.dataset.rowKey})')
  need(o['recentFocus']['mid']==mid and o['recentFocus']['cid']==cid and o['recentFocus']['key']=='u0','recent did not navigate to source')
  call('Page.reload',{'ignoreCache':True});condition('document.readyState==="complete" && !document.querySelector("#k1-panel").open');click('#k2-open');click('#k2-recent button[data-message-id="'+mid+'"]');condition('document.activeElement?.dataset.k1Focused==="true"')
  click('#k1-back-last');condition('document.activeElement?.dataset.k1Focused==="true"')
  o['restoredKey']=ev('document.activeElement.dataset.rowKey');need(o['restoredKey']=='u0','original row')
  a.evidence.mkdir(parents=True,exist_ok=True);(a.evidence/'recent-after-reload.png').write_bytes(base64.b64decode(call('Page.captureScreenshot')['data']))
  db=sqlite3.connect((state/'n22-messages.sqlite').as_uri()+'?mode=ro',uri=True)
  try:o['counts']={k:db.execute('select count(*) from '+k).fetchone()[0] for k in ['n99_p1_turns','n99_p1_tools','n99_p1_conversations']}
  finally:db.close()
  need(o['counts']['n99_p1_turns']==1 and o['counts']['n99_p1_conversations']==2,'cold read duplicated a submission')
  # Browser profile and all test credentials remain in scratch, removed after shutdown.
  ws.close();terminate(ch);(state/'stop.request').write_text(h['runId'],'utf8')
  o['hostExit']=p.wait(timeout=10);need(o['hostExit']==0,'stop original host')
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--zip',type=Path,default=W.parents[2]/'商品仓/P1/N99-P1-集成候选.zip');ap.add_argument('--evidence',type=Path,default=HERE/'evidence');a=ap.parse_args();o={}
 try:run(a,o);o['exit']=0
 except Exception as e:o.update(exit=1,error=str(e))
 put(a.evidence/'actual-host.json',o);print(json.dumps(o,ensure_ascii=False));sys.exit(o['exit'])
