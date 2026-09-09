import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import worker,{BlogSync,validSignature} from './worker.mjs';
function fixture() {
  const values=new Map();
  const storage={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),setAlarm:async time=>{storage.alarm=time;}};
  const env={SETUP_KEY:'setup',PUBLISH_KEY:'publish',WORKSPACE_ID:'space',SITE_URL:'https://site.test',DEPLOY_HOOK_URL:'https://hook.test'};
  const obj=new BlogSync({storage},env);
  env.SYNC_STATE={idFromName:()=>1,get:()=>obj};
  const request=(path,body,signature)=>worker.fetch(new Request('https://worker.test'+path,{method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body),headers:signature?{'X-Notion-Signature':signature}:{}}),env);
  const event=async(type,id='one')=>{
    const body={id,type,workspace_id:'space',timestamp:new Date().toISOString()};
    return request('/notion/setup',body,'sha256='+createHmac('sha256','verify').update(JSON.stringify(body)).digest('hex'));
  };
  return {storage,env,obj,request,event};
}
test('webhook requires secret route and valid signature; content edits are ignored',async()=>{
  const f=fixture();
  assert.equal((await f.request('/publish/wrong',{})).status,404);
  assert.equal((await f.request('/publish/publish')).status,405);
  await f.request('/notion/setup',{verification_token:'verify'});
  assert.equal((await f.request('/notion/setup',{type:'page.properties_updated'})).status,401);
  assert.deepEqual(await (await f.event('page.content_updated')).json(),{ignored:true});
  assert.equal(await f.storage.get('state'),undefined);
  assert.deepEqual(await (await f.event('page.properties_updated')).json(),{queued:true});
  assert.deepEqual(await (await f.event('page.properties_updated')).json(),{duplicate:true});
  assert.equal((await f.request('/setup/setup')).status,410);
  assert.equal(await validSignature('x','sha256='+'0'.repeat(64),'verify'),false);
});
test('manual button queues deployment and successful live build confirms it',async()=>{
  const f=fixture(),original=globalThis.fetch;
  try {
    await f.request('/publish/publish',{});
    assert.ok(f.storage.alarm<=Date.now()+2000);
    const calls=[];
    globalThis.fetch=async(url)=>{calls.push(url);return Response.json(url.startsWith('https://hook')?{success:true}:{syncedAt:new Date(Date.now()+1000).toISOString()});};
    await f.obj.alarm();
    assert.equal((await f.storage.get('state')).awaiting,true);
    await f.obj.alarm();
    assert.equal((await f.storage.get('state')).pending,false);
    assert.equal(calls.length,2);
  } finally {globalThis.fetch=original;}
});
test('a newer event during publication verification is not discarded',async()=>{
  const f=fixture(),original=globalThis.fetch;
  try {
    await f.obj.queue('manual');
    await f.storage.put('state',{...(await f.storage.get('state')),awaiting:true});
    globalThis.fetch=async(url)=>{
      if(url.startsWith('https://hook')) return Response.json({success:true});
      const old=await f.storage.get('state');
      await f.storage.put('state',{...old,target:old.target+10000});
      return Response.json({syncedAt:new Date(old.target+1).toISOString()});
    };
    await f.obj.alarm();
    assert.equal((await f.storage.get('state')).pending,true);
  } finally {globalThis.fetch=original;}
});
test('failed hooks stop after four attempts and a new button press recovers',async()=>{
  const f=fixture(),original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{throw new Error('network');};
    await f.obj.queue('manual');
    for(let i=0;i<4;i++) await f.obj.alarm();
    assert.equal((await f.storage.get('state')).pending,false);
    await f.obj.queue('manual');
    assert.equal((await f.storage.get('state')).attempts,0);
    assert.equal((await f.storage.get('state')).pending,true);
  } finally {globalThis.fetch=original;}
});
