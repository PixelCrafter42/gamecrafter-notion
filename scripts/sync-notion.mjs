import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainText, renderBlocks, safeUrl } from './notion-render.mjs';

export function metadata(page, fields) {
  if (page.archived || page.in_trash || page.is_archived || page.properties?.[fields.status]?.select?.name !== fields.published) return null;
  const p = page.properties;
  const title = plainText(p[fields.title]?.title).trim();
  if (!title) throw new Error('已发布文章必须填写标题');
  const id = plainText(p[fields.slug]?.rich_text).trim() || page.id.replaceAll('-', '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('文章链接只能使用小写英文字母、数字和短横线');
  const rawDate = p[fields.date]?.date?.start || page.created_time;
  if (!rawDate || Number.isNaN(Date.parse(rawDate))) throw new Error('文章发布日期无效');
  return {id, title, description:plainText(p[fields.description]?.rich_text).trim() || title, pubDate:new Date(rawDate).toISOString(), tags:(p[fields.tags]?.multi_select ?? []).map(t=>t.name), draft:false};
}

export async function collectSnapshot({ request, config, media, previous=[], targets=null }) {
  if (targets && !targets.length) return structuredClone(previous);
  // Check the schema first: a renamed/missing field must not silently clear the website.
  const source = await request('data_sources/' + config.dataSourceId);
  for (const [key,type] of [['title','title'],['description','rich_text'],['status','select'],['date','date'],['tags','multi_select'],['slug','rich_text']]) {
    if (source.properties?.[config.fields[key]]?.type !== type) throw new Error('Notion 字段缺失或类型变化：' + config.fields[key]);
  }
  const pages = []; let cursor;
  const targeted=new Set((targets || []).map(t=>t.id));
  if (targets) {
    for (const target of targets) {
      let page;
      try {page=await request('pages/'+target.id);} catch(error) {
        if (error.status===404 && ['page.deleted','page.moved'].includes(target.type)) continue;
        throw error;
      }
      // Events for nested or moved pages must never publish content outside the article database.
      if (page.parent?.data_source_id?.replaceAll('-','')!==config.dataSourceId.replaceAll('-','')) continue;
      pages.push(page);
    }
  } else do {
    const result = await request('data_sources/' + config.dataSourceId + '/query', {method:'POST',body:{page_size:100,filter:{property:config.fields.status,select:{equals:config.fields.published}},...(cursor ? {start_cursor:cursor} : {})}});
    if (!Array.isArray(result.results) || (result.has_more && !result.next_cursor)) throw new Error('Notion 查询返回不完整');
    pages.push(...result.results); cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  const published = pages.map(page=>({page,data:metadata(page,config.fields)})).filter(p=>p.data);
  const retained=targets ? previous.filter(post=>!targeted.has(post.sourcePageId)) : [];
  const ids = new Set(retained.map(post=>post.id));
  for (const {data} of published) { if (ids.has(data.id)) throw new Error('存在重复文章链接：' + data.id); ids.add(data.id); }
  const links = new Map([...retained.map(post=>[post.sourcePageId,config.site+'/blog/'+post.id+'/']),...published.map(({page,data})=>[page.id,config.site+'/blog/'+data.id+'/'])]);
  const children = async id => {
    const all = []; let next;
    do {
      const result = await request('blocks/' + id + '/children?page_size=100' + (next ? '&start_cursor='+encodeURIComponent(next) : ''));
      if (!Array.isArray(result.results) || (result.has_more && !result.next_cursor)) throw new Error('Notion 区块返回不完整');
      all.push(...result.results); next = result.has_more ? result.next_cursor : null;
    } while(next);
    return all;
  };
  const posts = [...retained];
  for (const {page,data} of published) {
    const mediaIndex={};
    const html = await renderBlocks(await children(page.id), {children,media:body=>media(body,mediaIndex),publishedLinks:links});
    const current = await request('pages/' + page.id);
    if (!metadata(current,config.fields) || current.last_edited_time !== page.last_edited_time) throw new Error('文章正在编辑或下线，留待下一次同步');
    posts.push({...data,html,sourcePageId:page.id,mediaIndex});
  }
  return posts.sort((a,b)=>a.id.localeCompare(b.id));
}

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
export function createRequest({token,cliScript,fetchImpl=fetch}) {
  let last = 0;
  return async (path, {method='GET',body} = {}) => {
    await sleep(Math.max(0,360 - (Date.now()-last))); last = Date.now();
    if (cliScript) {
      const args = [cliScript,'api','v1/'+path,'-X',method,'--notion-version','2026-03-11'];
      if (body) args.push('--data','@-');
      return JSON.parse(execFileSync(process.execPath,args,{input:body ? JSON.stringify(body) : undefined,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true}));
    }
    if (!token) throw new Error('缺少 NOTION_TOKEN，请在 Cloudflare Pages 生产环境密钥中配置');
    for (let attempt=0; attempt<5; attempt++) {
      const response = await fetchImpl('https://api.notion.com/v1/'+path,{method,headers:{Authorization:'Bearer '+token,'Notion-Version':'2026-03-11','Content-Type':'application/json'},body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(30000)});
      if (response.ok) return response.json();
      if ((response.status===429 || response.status>=500) && attempt<4) { await sleep(Math.min(30000,Number(response.headers.get('retry-after') || 2**attempt)*1000)); continue; }
      const error=new Error('Notion API 请求失败 ('+response.status+')；请检查连接权限和数据库配置');error.status=response.status;throw error;
    }
  };
}

export async function runSync() {
  const syncedAt=new Date().toISOString();
  const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const config = JSON.parse(await readFile(resolve(root,'notion.config.json'),'utf8'));
  let previous=[],revision=0,targets=null;
  const remote=process.env.SYNC_KEY;
  if (remote) {
    const response=await fetch(config.site+'/_notion-content.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(30000)});
    if (response.ok) {
      const base=await response.json();
      if (base.version!==1 || !Number.isSafeInteger(base.revision) || !Array.isArray(base.posts) || base.posts.some(p=>!p.sourcePageId || typeof p.html!=='string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id))) throw new Error('已发布内容缓存无效');
      previous=base.posts;revision=base.revision;
    } else if (response.status!==404) throw new Error('无法读取已发布内容缓存');
    const planning=await fetch(config.syncWorker+'/plan?since='+revision,{headers:{Authorization:'Bearer '+remote},signal:AbortSignal.timeout(30000)});
    if (!planning.ok) throw new Error('无法获取单篇同步计划');
    const plan=await planning.json();
    if (!Number.isSafeInteger(plan.revision) || plan.revision<revision || !Array.isArray(plan.targets)) throw new Error('单篇同步计划无效');
    if (!response.ok && !plan.full) throw new Error('首次初始化需点击全量更新按钮');
    revision=plan.revision;targets=plan.full?null:plan.targets;
  } else if (process.env.CF_PAGES) throw new Error('缺少 SYNC_KEY，停止构建以避免意外全量发布');
  const request = createRequest({token:process.env.NOTION_TOKEN,cliScript:process.env.NOTION_CLI_SCRIPT});
  const assets = new Map();
  const cachedMedia=Object.assign({},...previous.map(post=>post.mediaIndex || {}));
  const assetName=/^[a-f0-9]{64}\.(?:jpg|png|gif|webp|avif|pdf|mp4|mp3|m4a|txt)$/;
  const media = async (body,index) => {
    if (body.type==='external') return safeUrl(body.external?.url);
    const raw = body.file?.url;
    if (!raw) throw new Error('Notion 附件地址缺失');
    const url = new URL(raw);
    if (url.protocol!=='https:' || !['amazonaws.com','notion.so','notion-static.com','notionusercontent.com'].some(host=>url.hostname===host || url.hostname.endsWith('.'+host))) throw new Error('无法识别的 Notion 附件存储域名');
    // Notion file URLs expire; their immutable object paths stay stable across signed URLs.
    const key=createHash('sha256').update(url.origin+url.pathname).digest('hex');
    if (cachedMedia[key] && assetName.test(cachedMedia[key])) {index[key]=cachedMedia[key];return '/notion-media/'+cachedMedia[key];}
    const response = await fetch(raw,{redirect:'error',signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('Notion 附件下载失败 ('+response.status+')');
    const mime = response.headers.get('content-type')?.split(';')[0];
    const types = {'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','image/avif':'avif','application/pdf':'pdf','video/mp4':'mp4','audio/mpeg':'mp3','audio/mp4':'m4a','text/plain':'txt'};
    if (!types[mime]) throw new Error('不支持的附件类型：'+mime+'。支持常见图片、PDF、MP4、MP3 和文本。');
    const chunks=[]; let total=0;
    for await (const chunk of response.body) { total+=chunk.length; if (total>20*1024*1024) throw new Error('单个附件不能超过 20 MB'); chunks.push(chunk); }
    const bytes=Buffer.concat(chunks);
    const name=createHash('sha256').update(bytes).digest('hex')+'.'+types[mime];
    assets.set(name,bytes);index[key]=name; return '/notion-media/'+name;
  };
  // Finish every API call before changing any generated file.
  const posts = await collectSnapshot({request,config,media,previous,targets});
  // Retain unchanged files from the published CDN instead of re-downloading them from Notion.
  const needed=[...new Set(posts.flatMap(post=>Object.values(post.mediaIndex || {})))];
  let nextAsset=0;
  await Promise.all(Array.from({length:Math.min(6,needed.length)},async()=>{
    while(nextAsset<needed.length) {
      const name=needed[nextAsset++];
      if (!assetName.test(name)) throw new Error('缓存附件路径无效');
      if (assets.has(name)) continue;
      const response=await fetch(config.site+'/notion-media/'+name,{signal:AbortSignal.timeout(30000)});
      if (!response.ok) throw new Error('无法恢复已发布附件，保留旧网站');
      const chunks=[];let total=0;
      for await (const chunk of response.body) {total+=chunk.length;if(total>20*1024*1024) throw new Error('缓存附件超过限制');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);
      if (createHash('sha256').update(bytes).digest('hex')!==name.split('.')[0]) throw new Error('缓存附件完整性校验失败');
      assets.set(name,bytes);
    }
  }));
  const dataDir=resolve(root,'src/data'), assetDir=resolve(root,'public/notion-media');
  await mkdir(dataDir,{recursive:true}); await mkdir(assetDir,{recursive:true});
  for (const [name,bytes] of assets) await writeFile(resolve(assetDir,name),bytes);
  const output=resolve(dataDir,'notion-posts.json');
  await writeFile(output+'.tmp',JSON.stringify(posts,null,2)+'\n'); await rename(output+'.tmp',output);
  await writeFile(resolve(root,'public/_notion-content.json'),JSON.stringify({version:1,revision,posts})+'\n');
  await writeFile(resolve(root,'public/_notion-sync.json'),JSON.stringify({syncedAt,revision,mode:targets===null?'full':'incremental',updated:targets===null?posts.length:targets.length})+'\n');
  // Delete only generated hash-named files inside this project's generated asset directory.
  for (const name of await readdir(assetDir)) if (/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name) && !assets.has(name)) {
    const target=resolve(assetDir,name);
    if (dirname(target)!==assetDir || basename(target)!==name) throw new Error('附件路径校验失败');
    await unlink(target);
  }
  console.log('Notion '+(targets===null?'全量':'单篇增量')+'同步完成：本次读取 '+(targets===null?posts.length:targets.length)+' 篇，合计 '+posts.length+' 篇已发布文章，'+assets.size+' 个附件。');
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) runSync().catch(error=>{console.error(error.message);process.exitCode=1;});
