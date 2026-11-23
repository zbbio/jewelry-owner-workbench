// Isolated, loopback-only owner trial; not production identity. Cookie sessions end on restart.
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
const digest=x=>createHash('sha256').update(x).digest();
export function createPilotAccess(env=process.env){
 const locked=env.WORKBENCH_REQUIRE_LOGIN==='1',code=env.WORKBENCH_PILOT_CODE||'',sessions=new Map(),failures=[];
 if(locked&&(!env.WORKBENCH_DATA||!env.WORKBENCH_SHOP||code.length<16))throw Error('隔离试用需独立数据目录、店铺和至少16位的临时试用口令。');
 const cookie='owner_pilot';
 const token=req=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookie+'='))?.slice(cookie.length+1);
 function valid(req){const t=token(req);if(!t||!sessions.has(t))return false;if(sessions.get(t)<=Date.now()){sessions.delete(t);return false}return true;}
 function signIn(s){if(!locked)return null;const now=Date.now();while(failures.length&&failures[0]<now-60000)failures.shift();
  if(failures.length>=8)throw Object.assign(Error('请稍后重试。'),{code:'LOGIN_WAIT',httpStatus:429});
  if(typeof s!=='string'||s.length>512||!timingSafeEqual(digest(s),digest(code))){failures.push(now);throw Object.assign(Error('试用口令不正确。'),{code:'PILOT_LOGIN',httpStatus:401});}
  for(const [t,v] of sessions)if(v<=now)sessions.delete(t);
  const t=randomBytes(32).toString('base64url');sessions.set(t,now+8*3600000);
  return cookie+'='+t+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800';}
 function logout(req){sessions.delete(token(req));return cookie+'=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';}
 return {locked,valid,signIn,logout};
}
