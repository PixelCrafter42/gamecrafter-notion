const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
const types=new Set(['page.created','page.properties_updated','page.deleted','page.undeleted','page.moved','data_source.schema_updated']);
const encode=value=>new TextEncoder().encode(value);

export async function validSignature(raw,signature,token) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature || '') || !token) return false;
  const bytes=Uint8Array.from(signature.slice(7).match(/.{2}/g),b=>parseInt(b,16));
  const key=await crypto.subtle.importKey('raw',encode(token),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,bytes,encode(raw));
}

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    const setup=env.SETUP_KEY && path==='/setup/'+env.SETUP_KEY;
    const notion=env.SETUP_KEY && path==='/notion/'+env.SETUP_KEY;
    const manual=env.PUBLISH_KEY && path==='/publish/'+env.PUBLISH_KEY;
    if (path!=='/' && !setup && !notion && !manual) return json({error:'Not found'},404);
    if ((notion || manual) && request.method!=='POST') return json({error:'Use POST'},405);
    if ((setup || path==='/') && request.method!=='GET') return json({error:'Use GET'},405);
    return env.SYNC_STATE.get(env.SYNC_STATE.idFromName('blog')).fetch(request);
  },
};

export class BlogSync {
  constructor(ctx,env) { this.ctx=ctx;this.env=env; }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if (path==='/') {
      const state=await this.ctx.storage.get('state') || {};
      return json({service:'Notion → gamecrafter.fun',pending:!!state.pending,lastEventAt:state.lastEventAt || null,lastPublishedAt:state.lastPublishedAt || null,error:state.error || null});
    }
    if (path.startsWith('/setup/')) {
      if (await this.ctx.storage.get('locked')) return json({error:'Setup closed'},410);
      return json({verification_token:await this.ctx.storage.get('verificationToken') || null});
    }
    const raw=await request.text();
    if (raw.length>65536) return json({error:'Request too large'},413);
    if (path.startsWith('/publish/')) { await this.queue('manual'); return json({queued:true}); }
    let payload; try { payload=JSON.parse(raw); } catch { return json({error:'Invalid JSON'},400); }
    const token=await this.ctx.storage.get('verificationToken');
    if (typeof payload.verification_token==='string') {
      if (await this.ctx.storage.get('locked')) return json({error:'Setup closed'},409);
      if (token && token!==payload.verification_token) return json({error:'Already initialized'},409);
      await this.ctx.storage.put('verificationToken',payload.verification_token);
      return json({received:true});
    }
    if (!await validSignature(raw,request.headers.get('X-Notion-Signature'),token)) return json({error:'Invalid signature'},401);
    if (payload.workspace_id!==this.env.WORKSPACE_ID) return json({error:'Workspace mismatch'},403);
    if (!types.has(payload.type)) return json({ignored:true});
    const time=Date.parse(payload.timestamp);
    if (!payload.id || !Number.isFinite(time) || Math.abs(Date.now()-time)>7*86400000) return json({error:'Invalid event'},400);
    const seen=await this.ctx.storage.get('seen') || [];
    if (seen.includes(payload.id)) return json({duplicate:true});
    await this.ctx.storage.put('seen',[...seen.slice(-999),payload.id]);
    await this.ctx.storage.put('locked',true);
    await this.queue(payload.type);
    return json({queued:true});
  }
  async queue(reason) {
    const now=Date.now(),state=await this.ctx.storage.get('state') || {};
    state.pending=true;state.target=now;state.lastEventAt=new Date(now).toISOString();state.reason=reason;state.error=null;
    if (!state.awaiting) {state.attempts=0;state.firstQueuedAt=state.firstQueuedAt || now;}
    await this.ctx.storage.put('state',state);
    if (!state.awaiting) {
      // Trailing-edge coalescing, bounded at 2 minutes so continuous edits still publish.
      await this.ctx.storage.setAlarm(Math.min(now+(reason==='manual'?2000:15000),state.firstQueuedAt+120000));
    }
  }
  async alarm() {
    let state=await this.ctx.storage.get('state');
    if (!state?.pending) return;
    try {
      if (state.awaiting) {
        const check=await fetch(this.env.SITE_URL+'/_notion-sync.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(15000)});
        const result=check.ok ? await check.json().catch(()=>({})) : {};
        state=await this.ctx.storage.get('state') || state;
        if (Date.parse(result.syncedAt)>=state.target) {
          state.pending=false;state.awaiting=false;state.firstQueuedAt=null;state.lastPublishedAt=result.syncedAt;state.error=null;
          await this.ctx.storage.put('state',state);return;
        }
      }
      if ((state.attempts || 0)>=4) {
        state.awaiting=false;state.pending=false;state.firstQueuedAt=null;state.error='发布未确认，请检查 Pages 构建日志并再次点击发布按钮';
        await this.ctx.storage.put('state',state);return;
      }
      if (!this.env.DEPLOY_HOOK_URL) throw new Error('Deploy Hook 未配置');
      const result=await fetch(this.env.DEPLOY_HOOK_URL,{method:'POST',signal:AbortSignal.timeout(20000)});
      if (!result.ok) throw new Error('Deploy Hook 请求失败');
      const body=await result.json().catch(()=>({}));
      if (body.success===false) throw new Error('Deploy Hook 拒绝请求');
      // An event arriving during the network call must remain pending.
      const current=await this.ctx.storage.get('state') || state;
      await this.ctx.storage.put('state',{...current,awaiting:true,attempts:(state.attempts || 0)+1,lastHookAt:new Date().toISOString()});
      await this.ctx.storage.setAlarm(Date.now()+150000);
    } catch {
      const current=await this.ctx.storage.get('state') || state;
      current.attempts=(state.attempts || 0)+1;current.error='暂时无法触发或确认部署，正在重试';
      if (current.attempts>=4) {current.pending=false;current.awaiting=false;current.firstQueuedAt=null;current.error='发布失败，请检查 Pages 构建日志并再次点击发布按钮';}
      await this.ctx.storage.put('state',current);
      if (current.attempts<4) await this.ctx.storage.setAlarm(Date.now()+60000);
    }
  }
}
