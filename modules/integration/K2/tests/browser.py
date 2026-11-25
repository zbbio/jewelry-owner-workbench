"""K2 store-owner interaction checks. python -B browser.py --host <disposable K1+K2 host> --out <new evidence dir>
Actual K1/P1 conversations & HTTP/SQLite plus rendered host UI; confirmation/readiness/legacy reply are synthetic.
All HTTP loopback. No shared device, private login, model, or issuing host. Nothing written into --host.
"""
from pathlib import Path
from contextlib import ExitStack
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from http.client import HTTPConnection
from urllib.parse import urlsplit
import argparse,base64,hashlib,http.client,json,os,queue,subprocess,sys,tempfile,threading,time,urllib.request,uuid
import websocket
T=Path(__file__).resolve().parent
K1=T.parents[2]/'K1'/'workspace'
ANCHOR=b'/*K2_BIND_READERS*/Object.freeze({})'
FIXX=b'/*K2_TEST_BINDING_ONLY*/globalThis.K2TestOnly.api'
def sha(b):return hashlib.sha256(b).hexdigest()
def dump(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
def q(x):return json.dumps(x,ensure_ascii=False)
def wait(f,desc,timeout=12):
 end=time.monotonic()+timeout;r=None
 while time.monotonic()<end:
  r=f()
  if r:return r
  time.sleep(.045)
 raise AssertionError('timeout: '+desc+' last='+repr(r))
def stop(p):
 if p.poll() is None:
  p.terminate()
  try:p.wait(5)
  except subprocess.TimeoutExpired:p.kill();p.wait(7)
class Chrome:
 def __init__(self,stack,w,chrome):
  profile=w/'profile'
  cmd=[str(chrome),'--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-sync','--disable-background-networking','--disable-component-update','--disable-breakpad','--disable-gpu','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+str(profile),'--window-size=1120,980','about:blank']
  proc=subprocess.Popen(cmd,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);stack.callback(stop,proc)
  flag=profile/'DevToolsActivePort';port=wait(lambda:flag.exists() and flag.read_text().splitlines()[0],'CDP')
  conn=urllib.request.build_opener(urllib.request.ProxyHandler({}))
  tabs=json.load(conn.open('http://127.0.0.1:'+port+'/json/list',timeout=6))
  self.ws=websocket.create_connection(next(t['webSocketDebuggerUrl'] for t in tabs if t['type']=='page'),timeout=10,suppress_origin=True,http_no_proxy=['localhost','127.0.0.1']);stack.callback(self.ws.close)
  self.seq=0;self.errors=[];self.network=[]
  for m in ['Page.enable','Network.enable','Runtime.enable','Profiler.enable']:self.call(m)
  self.call('Profiler.startPreciseCoverage',{'callCount':True,'detailed':False})
 def call(self,m,p=None):
  self.seq+=1;s=self.seq;self.ws.send(json.dumps({'id':s,'method':m,'params':p or {}}))
  while 1:
   r=json.loads(self.ws.recv())
   if r.get('method')=='Runtime.exceptionThrown':self.errors.append(r['params']['exceptionDetails'].get('exception',{}).get('description',r['params']['exceptionDetails']['text']))
   if r.get('method')=='Network.requestWillBeSent':self.network.append(r['params']['request']['url'])
   if r.get('id')==s:
    if 'error' in r:raise RuntimeError(r['error'])
    return r['result']
 def js(self,s):
  r=self.call('Runtime.evaluate',dict(expression=s,returnByValue=True,awaitPromise=True))
  if 'exceptionDetails' in r:raise RuntimeError(r['exceptionDetails'].get('exception',{}).get('description',r['exceptionDetails']['text']))
  return r['result'].get('value')
 def pos(self,sel,check=True):
  ret=self.js("""(()=>{const n=document.querySelector(SEL);if(!n||n.disabled||!n.getClientRects().length)return null;n.scrollIntoView({block:"center"});const r=n.getBoundingClientRect(),p=[r.left+r.width/2,r.top+r.height/2],hit=document.elementFromPoint(...p);return n===hit||n.contains(hit)?p:null;})()""".replace('SEL',q(sel)))
  return ret
 def click(self,sel):
  x,y=wait(lambda:self.pos(sel),'mouse target '+sel)
  self.press(x,y)
 def press(self,x,y):
  for k in ['mousePressed','mouseReleased']:self.call('Input.dispatchMouseEvent',{'type':k,'button':'left','clickCount':1,'x':x,'y':y})
 def write(self,sel,text):
  self.click(sel);self.js('document.querySelector('+q(sel)+').select()');self.call('Input.insertText',{'text':text})
 def image(self,out):out.write_bytes(base64.b64decode(self.call('Page.captureScreenshot',{'format':'png'})['data']))
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--host',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);parser.add_argument('--chrome',type=Path,default=Path(os.environ.get('ProgramFiles','C:/Program Files'))/'Google/Chrome/Application/chrome.exe')
 a=parser.parse_args();h=a.host.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
 manifest=json.loads((h/'release.json').read_text('utf8'));script=(h/'n22-ui/n22-app.js').read_bytes();assert sha(script)==manifest['files']['n22-ui/n22-app.js']
 if script.count(ANCHOR)!=1:raise ValueError('expected exactly one compiled private port bind anchor')
 served=script.replace(ANCHOR,FIXX)
 transcript=[];checks=[];ordinary=[];r={'scope':'actual K1+P1 UI/P1 SQLite/Kotlin code; P2 + readiness + old turn reply = synthetic in-process/CDP; not Android/model/real ticket','argv':sys.argv,'release':manifest['releaseId'],'sha256Production':sha(script),'sha256Fixture':sha(served),'fixtureOnlyDiff':ANCHOR.decode()+' -> '+FIXX.decode(),'checks':checks}
 w=Path(tempfile.mkdtemp(prefix='k2-k1-browser-proof-'))
 def check(label,value,detail=None):
  checks.append({'check':label,'pass':bool(value),**({'observed':detail} if detail is not None else {})})
  if not value:raise AssertionError(label+': '+repr(detail))
 with ExitStack() as st:
  try:
   nlog=st.enter_context((out/'p1-fixture.stderr').open('wb'))
   node=subprocess.Popen(['node',str(K1/'test-app/fixture.mjs'),str(h),str(w/'fixture.sqlite')],encoding='utf8',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=nlog,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
   st.callback(stop,node)
   def ctl(s):
    node.stdin.write(s+'\n');node.stdin.flush();return json.loads(node.stdout.readline())
   raw=json.loads(node.stdout.readline())['base'];assert urlsplit(raw).hostname=='127.0.0.1';p1port=urlsplit(raw).port
   def getp(path,body=None):
    s=HTTPConnection('127.0.0.1',p1port,timeout=6);s.request('POST' if body else 'GET',path,json.dumps(body,ensure_ascii=False).encode() if body else None,{'Content-Type':'application/json'});resp=s.getresponse();data=json.loads(resp.read());s.close();assert resp.status in (200,201),(resp.status,data);return data
   root='/api/n22/conversations';rid=lambda:str(uuid.uuid4())
   ca=getp(root,dict(requestId=rid(),title='夹具话题甲'));cb=getp(root,dict(requestId=rid(),title='夹具话题乙'))
   original=getp(root+'/'+ca['conversationId']+'/turn',dict(requestId=rid(),text='测试甲：定位这一条原消息 KONE-51'))
   after=getp(root+'/'+ca['conversationId']+'/turn',dict(requestId=rid(),text='测试甲：不是待确认引用的后一条 KONE-51'))
   other=getp(root+'/'+cb['conversationId']+'/turn',dict(requestId=rid(),text='测试乙：不是待确认引用的另一话题 KTWO-52'))
   ticket=dict(confirmationId='k2-fixture-ticket-01',conversationId=original['conversationId'],messageId=original['messageId'],runId=original['runId'],objectId='k2-sample-object-01',objectVersion=2,status='pending',summary='合成票：确认后更新隔离样本草稿',expiresAt='2099-01-01T00:00:00.000Z')
   r['seed']={'ticket':ticket,'nonTarget':[after['messageId'],other['messageId']],'creation':'real P1 route in synthetic shop; before browser interactions'}
   class H(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):self.serve()
    def do_POST(self):self.serve()
    def serve(self):
     method=self.command;u=urlsplit(self.path);p=u.path;body=self.rfile.read(int(self.headers.get('Content-Length',0)))
     if self.headers.get('Host')!='127.0.0.1:'+str(self.server.server_port):self.send_error(403);return
     if p=='/api/n22/turn' and method=='POST':
      x=json.loads(body);ordinary.append({k:x.get(k) for k in ['text','messageId','requestId']})
      data=json.dumps({'shopId':'k2-test-shop','messageId':x['messageId'],'requestId':x['requestId'],'status':'needs_photos','actions':[]}).encode()
      status=200;typ='application/json'
     elif p=='/n22-app.js': data=served if bind['active'] else script;status=200;typ='text/javascript; charset=utf-8'
     else:
      c=HTTPConnection('127.0.0.1',p1port,timeout=10)
      c.request(method,self.path,body,{'Content-Type':'application/json'});src=c.getresponse();data=src.read();status=src.status;typ=src.getheader('Content-Type','text/plain');c.close()
     transcript.append(dict(method=method,path=p,status=status))
     self.send_response(status);self.send_header('Content-Type',typ);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers()
     try:self.wfile.write(data)
     except (ConnectionResetError,BrokenPipeError):pass
   bind={'active':True};srv=ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=srv.serve_forever,daemon=True).start();st.callback(srv.server_close);st.callback(srv.shutdown)
   base='http://127.0.0.1:'+str(srv.server_port);ch=Chrome(st,w,a.chrome)
   driver=(T/'browser-fixture.js').read_text('utf8').replace('/*K2_TEST_SEED*/',q([ticket]))
   ch.call('Page.addScriptToEvaluateOnNewDocument',{'source':driver});ch.call('Page.navigate',{'url':base+'/'})
   j=ch.js; click=ch.click;wait(lambda:j('document.readyState==="complete" && !!document.querySelector("#k2-open") && !document.querySelector("#send").disabled'),'ready')
   peek=lambda:j('K2TestOnly.peek()');mode=lambda x:j('K2TestOnly.mode('+q(x)+')')
   text=lambda sel:j('(document.querySelector('+q(sel)+')?.innerText||"")')
   shown=lambda sel:j('!!document.querySelector('+q(sel)+')?.getClientRects().length')
   pending='#k2-pending button[data-confirmation-id="'+ticket['confirmationId']+'"]'
   def open_panel():
    if not shown('#k2-panel'):click('#k2-open')
   def close_panel():
    if shown('#k2-panel'):click('#k2-close');wait(lambda:not shown('#k2-panel'),'sidebar closed')
   def close_k1():
    if j('document.querySelector("#k1-panel").open'):
     click('#k1-close');wait(lambda:j('!document.querySelector("#k1-panel").open && !document.querySelector("#k1-messages article")'),'K1 closed + close event handled')
   def fresh():
    close_k1();close_panel();j('K2TestOnly.reset()');open_panel();wait(lambda:shown(pending) and j('document.querySelectorAll("#k2-recent [data-message-id]").length===2 && document.querySelectorAll("#k2-ready li").length===4'),'pending ticket and settled sidebar layout')
   def detail():
    fresh();click(pending);wait(lambda:shown('[data-k2-choice="confirm"]') and '已回到这张票的原消息' in text('#k1-note'),'ticket detail and final fresh recheck')
   def focuses():
    return j('(()=>{const a=document.activeElement.closest("#k1-messages article");return a?{...a.dataset}:null})()')
   def direct(word):
    ch.write('#prompt',word);click('#send');wait(lambda:any(row['text']==word for row in ordinary),'legacy turn')
    wait(lambda:'请授权本次需要整理的照片' in text('#thread'),'legacy compositor displayed per-turn response')
   # First acceptance check begins with a real owner click on the list, not a unit/API invariant.
   open_panel();wait(lambda:shown(pending) and j('document.querySelectorAll("#k2-recent [data-message-id]").length===2'),'list mounted');click(pending)
   f=wait(lambda:(f:=focuses()) and f.get('mid')==ticket['messageId'] and f,'original focus')
   check('owner clicks pending → selected exact older original row/run in topic A (not latest or other topic)',f.get('cid')==ticket['conversationId'] and f.get('run')==ticket['runId'] and f.get('k1Focused')=='true',f)
   check('navigation was a precise GET and zero decide or legacy turn',any(x['method']=='GET' and x['path']==root+'/'+ticket['conversationId']+'/messages/'+ticket['messageId'] for x in transcript) and not any(c[0]=='decide' for c in peek()['calls']) and not ordinary)
   ch.image(out/'01-original.png')
   # Stale/withdrawn objects are invalidated before an action reaches a mutation port.
   for m in ['newVersion','expired','403','wrongRun']:
    detail();before=peek();mode(m);click('[data-k2-choice="confirm"]')
    wait(lambda:len(peek()['calls'])>len(before['calls']),'fresh preflight '+m)
    wait(lambda:not shown('[data-k2-choice="confirm"]') or j('document.querySelector(\'[data-k2-choice="confirm"]\')?.disabled'),'rejected '+m)
    if m=='403':wait(lambda:j('!document.querySelector("#k1-messages article") && !document.querySelector("#k1-topics [data-cid]") && !document.querySelector("#k2-pending button")'),'revocation cleared protected content')
    check('preflight rejects '+m+' without decide',len([x for x in peek()['calls'] if x[0]=='decide'])==len([x for x in before['calls'] if x[0]=='decide']) and peek()['effects']==before['effects'],{'status':text('#k2-status'),'note':text('#k1-note')})
   detail();mode('commit409');before=peek();click('[data-k2-choice="confirm"]')
   wait(lambda:len([x for x in peek()['calls'][len(before['calls']):] if x[0]=='decide'])==1,'atomic rejection')
   check('server-side 409 after preflight: one attempted decision, no mutation',peek()['effects']==before['effects'])
   detail();before=peek();click('[data-k2-choice="cancel"]')
   wait(lambda:peek()['effects']['cancelled']==before['effects']['cancelled']+1,'cancel')
   check('explicit cancel reaches cancel once; fixture business execution counter unchanged',peek()['effects']['confirmed']==before['effects']['confirmed'] and len([x for x in peek()['calls'][len(before['calls']):] if x[0]=='decide' and x[2]=='cancel'])==1,peek()['effects'])
   fresh();mode('hold');click(pending);wait(lambda:peek()['held'],'held stale ticket detail');close_panel();j('K2TestOnly.release()')
   rendered=lambda:j('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
   rendered();check('pending response after closing sidebar does not open K1 or focus an old row',not shown('#k2-panel') and not j('document.querySelector("#k1-panel").open') and not focuses())
   fresh();mode('holdSecond403');before=peek();click(pending)
   wait(lambda:peek()['held'] and j('document.querySelector("#k1-panel").open'),'held second recheck on K1 original')
   click('#k1-topics [data-cid="'+cb['conversationId']+'"]')
   selB='#k1-messages article[data-mid="'+other['messageId']+'"]'
   wait(lambda:shown(selB),'topic B visible before stale A response')
   j('K2TestOnly.release()');wait(lambda:peek()['finishedLatches']==before['finishedLatches']+1,'stale 403 delivered');rendered()
   check('late A authorization rejection after user selects B does not remove or refocus B',shown(selB) and cb['title']==text('#k1-active') and not shown('#k1-messages .k2-ticket'),{'activeTitle':text('#k1-active'),'Bmid':other['messageId'],'notes':text('#k1-note')})
   fresh();mode('newListVersion');before=peek();click(pending)
   wait(lambda:peek()['held'] and '/ v3' in text('#k1-messages .k2-ticket'),'newer same-ID source card present before stale detail read')
   j('K2TestOnly.release()');wait(lambda:peek()['finishedLatches']==before['finishedLatches']+1 and '确认票已变化或过期' in text('#k1-messages .k2-ticket'),'same ID conflict invalidated old card')
   check('same-ID/version collision between refetch and populated source card disables interactions rather than authorizing stale v2',not shown('[data-k2-choice="confirm"]') and not shown('[data-k2-choice="cancel"]') and before['effects']==peek()['effects'],{'sourceText':text('#k1-messages .k2-ticket')})
   detail();before=peek();mode('holdDecision');ct='[data-k2-choice="confirm"]';pos=wait(lambda:ch.pos(ct),'confirm coordinates')
   ch.press(*pos);wait(lambda:peek()['held'] and j('document.querySelector(\'[data-k2-choice="confirm"]\').disabled'),'one pending atomic decision')
   ch.press(*pos);j('K2TestOnly.release()')
   wait(lambda:peek()['effects']['confirmed']==before['effects']['confirmed']+1 and '原票已确认' in text('#k1-messages'),'successful confirmed receipt')
   delta=[x for x in peek()['calls'][len(before['calls']):] if x[0]=='decide']
   check('rapid repeated explicit confirmation while deciding yields one decision and one simulated effect',len(delta)==1 and delta[0][2]=='confirm',{'portCalls':delta,'effects':peek()['effects']})
   close_k1();close_panel();j('K2TestOnly.reset()');click('#k1-launch')
   click('#k1-topics [data-cid="'+ca['conversationId']+'"]')
   src='#k1-messages article[data-mid="'+ticket['messageId']+'"] .k2-ticket[data-confirmation-id="'+ticket['confirmationId']+'"]'
   wait(lambda:shown(src),'ticket mounted at original even with sidebar closed')
   check('original message opened through ordinary K1 topic also exposes the same ticket ID (closed sidebar)',not shown('#k2-panel') and shown(src),{'mid':ticket['messageId'],'confirmationId':ticket['confirmationId']})
   close_k1()
   mode('ok');open_panel();wait(lambda:shown(pending),'reopen')
   wait(lambda:j('document.querySelectorAll("#k2-recent [data-message-id]").length===2 && document.querySelectorAll("#k2-ready li").length===4'),'recent and readiness')
   latest=j('Array.from(document.querySelectorAll("#k2-recent [data-message-id]"),n=>n.dataset.messageId)')
   check('recent tasks are latest real P1 message of each topic and not a pending-list clone',set(latest)=={after['messageId'],other['messageId']},latest)
   ready=text('#k2-ready');check('readiness resolves each warehouse independently and never promotes absent rows',all(x in ready for x in ['商品：挂载未知；当前就绪','销售：挂载未知；当前不可用','相册：挂载未知；待核实','内容：挂载未知；待核实']),ready)
   before=len(ordinary);direct('测试：侧栏打开时直接整理照片');check('open sidebar: ordinary submit remains reachable by mouse',shown('#k2-panel') and len(ordinary)==before+1,ordinary[-1])
   ch.image(out/'02-sidebar.png');close_panel();direct('测试：侧栏关闭时直接整理照片');check('closed sidebar: same ordinary submit path',not shown('#k2-panel') and len(ordinary)==before+2,ordinary[-1])
   cov=next(s for s in ch.call('Profiler.takePreciseCoverage')['result'] if s['url']==base+'/n22-app.js');bs=served.decode().encode('utf-16le');syms=['chatTargetKey','openConversationAt_','consumeJump_','groupTasks'];hits={s:[] for s in syms}
   for fun in cov['functions']:
    rr=fun['ranges'][0];i=rr['startOffset'];name=fun['functionName'];ctx=bs[max(0,i-64)*2:(i+80)*2].decode('utf-16le',errors='replace')
    for sym in syms:
     if sym in name or (not name and sym in ctx and rr['endOffset']-i<2000):hits[sym].append({'name':name,'start':i,'calls':rr['count']})
   check('Chrome executed upstream K2 groupTasks and compiled Mika K1 navigate/row/consume code from the integrated UI',all(any(x['calls'] for x in h) for h in hits.values()),hits)
   bind['active']=False;ch.call('Page.reload',{'ignoreCache':True})
   wait(lambda:j('document.readyState==="complete" && !!document.querySelector("#k2-open") && !document.querySelector("#send").disabled'),'production port reload');open_panel()
   wait(lambda:text('#k2-status') or text('#k2-ready'),'unbound empty state');time.sleep(.15)
   check('production unbound port: no actionable ticket or decision on screen',not shown(pending) and not shown('[data-k2-choice="confirm"]'),{'text':text('#k2-panel')})
   ch.image(out/'03-unbound.png')
   # Reactivate fixture-only port for a real P1 401. K2's in-flight old successful read must not repopulate either view.
   bind['active']=True;ch.call('Page.reload',{'ignoreCache':True})
   wait(lambda:j('document.readyState==="complete" && !!document.querySelector("#k2-open") && !document.querySelector("#send").disabled'),'bound privacy reload')
   fresh();mode('holdSecondOK');before=peek();click(pending)
   wait(lambda:peek()['held'] and shown('#k1-back-last') and shown('#k2-recent [data-message-id]'),'K2 ticket, recents visible; old K2 detail held before revoke')
   ctl('revoke');click('#k1-back-last')
   wait(lambda:any(x['status']==401 and x['path'].startswith(root+'/') for x in transcript),'real P1 401')
   wiped=lambda:j('!document.querySelector("#k1-messages article, #k1-topics [data-cid], #k2-pending button, #k2-recent button, #k2-ready li, .k2-ticket")')
   wait(wiped,'both K1/side areas cleared by live auth refusal')
   j('K2TestOnly.release()');wait(lambda:peek()['finishedLatches']==before['finishedLatches']+1,'old successful K2 response resumed after revocation')
   rendered();check('real P1 401 on K1 origin read wipes previously displayed sidebar ticket/recents and suppresses stale later K2 result',wiped() and before['effects']==peek()['effects'],{'sidebar':text('#k2-panel'),'k1note':text('#k1-note')})
   ch.image(out/'04-k1-401.png')
   actual=ctl('stats');check('navigation did not execute extra P1 turns; only seeded 3 fixture messages exist',len(actual['runs'])==3,{'P1Runs':len(actual['runs']),'ordinarySyntheticSubmits':len(ordinary)})
   check('page has no exception or non-loopback network request',not ch.errors and all(urlsplit(x).hostname in ('127.0.0.1',None) for x in ch.network),ch.errors)
   ctl('stop');check('fixture stopped cleanly',node.wait(5)==0)
   print('PASS',len(checks),'checks');r['exit']=0;return 0
  except Exception as e:
   r['error']=repr(e);r['exit']=1;print(repr(e),file=sys.stderr)
   if 'ch' in locals():
    try:r['lastScreen']=ch.js('document.body.innerText').strip()[-2200:];r['lastState']=ch.js('globalThis.K2TestOnly?.peek()');ch.image(out/'failure.png')
    except Exception:pass
   return 1
  finally:
   r['http']=transcript;r['ordinary']=ordinary;dump(out/'browser.json',r)
if __name__=='__main__':sys.exit(main())
