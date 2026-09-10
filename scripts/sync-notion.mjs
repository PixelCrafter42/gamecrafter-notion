import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainText, renderBlocks, safeUrl } from './notion-render.mjs';

const compactId=value=>String(value || '').replaceAll('-','').toLowerCase();
const normalizedPath=value=>{
  const path=String(value || '').trim();
  if (path==='/') return '/';
  if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)) throw new Error('栏目路径必须以 / 开头，并且只能使用小写英文字母、数字和短横线');
  return path;
};

async function queryAll(request,sourceId,body={}) {
  const pages=[];let cursor;
  do {
    const result=await request('data_sources/'+sourceId+'/query',{method:'POST',body:{page_size:100,...body,...(cursor?{start_cursor:cursor}:{})}});
    if (!Array.isArray(result.results) || (result.has_more && !result.next_cursor)) throw new Error('Notion 查询返回不完整');
    pages.push(...result.results);cursor=result.has_more?result.next_cursor:null;
  } while(cursor);
  return pages;
}

function blockReader(request,label='页面') {
  return async id=>{
    const all=[];let cursor;
    do {
      const value=await request('blocks/'+id+'/children?page_size=100'+(cursor?'&start_cursor='+encodeURIComponent(cursor):''));
      if (!Array.isArray(value.results) || (value.has_more && !value.next_cursor)) throw new Error(label+'内容返回不完整');
      all.push(...value.results);cursor=value.has_more?value.next_cursor:null;
    } while(cursor);
    return all;
  };
}

function requireSchema(source,fields,expected,label) {
  for (const [key,type] of Object.entries(expected)) if (source.properties?.[fields[key]]?.type!==type) {
    throw new Error(label+'字段缺失或类型变化：'+fields[key]);
  }
}

export async function discoverSources({request,config}) {
  const database=await request('databases/'+config.databaseId);
  if (!Array.isArray(database.data_sources)) throw new Error('博客后台数据源无效');
  const byName=new Map();
  for (const source of database.data_sources) {
    if (!source?.id || !source?.name || byName.has(source.name)) throw new Error('博客后台存在无效或重名的数据源');
    byName.set(source.name,source.id);
  }
  for (const name of [config.sources.settings.name,config.sources.sections.name]) if (!byName.has(name)) throw new Error('博客后台缺少数据源：'+name);
  return {database,byName};
}

export async function collectSections({request,config,sources,media}) {
  const settings=config.sources.sections;
  const sourceId=sources.byName.get(settings.name);
  const source=await request('data_sources/'+sourceId);
  requireSchema(source,settings.fields,{name:'title',key:'rich_text',path:'rich_text',layout:'select',enabled:'checkbox',navLabel:'rich_text',showInNav:'checkbox',navOrder:'number',eyebrow:'rich_text',heading:'rich_text',description:'rich_text',showOnHome:'checkbox',homeTitle:'rich_text',homeDescription:'rich_text',homeLimit:'number',contentSource:'rich_text'},'栏目管理');
  const pages=await queryAll(request,sourceId);
  const children=blockReader(request,'栏目页面');
  const sections=[];
  for (const page of pages) {
    if (page.in_trash || page.is_archived) continue;
    const p=page.properties;
    const text=(key,type='rich_text')=>plainText(p[settings.fields[key]]?.[type]).trim();
    const key=text('key');
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error('栏目标识只能使用小写英文字母、数字和短横线');
    const layout=p[settings.fields.layout]?.select?.name || '';
    const contentSource=text('contentSource');
    if (contentSource && !config.sources.content.layouts[layout]) throw new Error('栏目“'+key+'”使用了尚未支持的内容布局：'+layout);
    if (contentSource && !sources.byName.has(contentSource)) throw new Error('栏目“'+key+'”找不到内容数据源：'+contentSource);
    const mediaIndex={};
    const html=layout==='普通页面' ? await renderBlocks(await children(page.id),{children,media:body=>media(body,mediaIndex)}) : '';
    sections.push({
      key,name:text('name','title') || key,path:normalizedPath(text('path')),layout,enabled:!!p[settings.fields.enabled]?.checkbox,
      navLabel:text('navLabel') || text('name','title') || key,showInNav:!!p[settings.fields.showInNav]?.checkbox,navOrder:p[settings.fields.navOrder]?.number ?? 999,
      eyebrow:text('eyebrow'),heading:text('heading') || text('name','title') || key,description:text('description'),
      showOnHome:!!p[settings.fields.showOnHome]?.checkbox,homeTitle:text('homeTitle'),homeDescription:text('homeDescription'),homeLimit:Math.max(0,p[settings.fields.homeLimit]?.number ?? 0),
      contentSource,sourceId:contentSource?sources.byName.get(contentSource):'',sourcePageId:page.id,html,mediaIndex,
    });
  }
  const keys=new Set(),paths=new Set();
  const reservedPaths=new Set(['/privacy','/404']);
  for (const section of sections) {
    if (keys.has(section.key) || paths.has(section.path)) throw new Error('栏目标识或路径重复：'+section.key);
    if (reservedPaths.has(section.path)) throw new Error('栏目路径与系统页面冲突：'+section.path);
    keys.add(section.key);paths.add(section.path);
  }
  if (!sections.some(section=>section.key==='home' && section.enabled)) throw new Error('栏目管理必须保留启用的首页');
  return sections.sort((a,b)=>a.navOrder-b.navOrder || a.key.localeCompare(b.key));
}

export function metadata(page,{section,common,adapter}) {
  if (page.in_trash || page.is_archived || page.properties?.[common.status]?.select?.name!==common.published) return null;
  const p=page.properties;
  const title=plainText(p[common.title]?.title).trim();
  if (!title) throw new Error('已发布内容必须填写标题');
  const id=plainText(p[common.slug]?.rich_text).trim() || page.id.replaceAll('-','');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('内容路径只能使用小写英文字母、数字和短横线');
  const rawDate=p[common.date]?.date?.start || page.created_time;
  if (!rawDate || Number.isNaN(Date.parse(rawDate))) throw new Error('内容发布日期无效');
  const publicUrl=(field,label)=>{
    const value=field?p[field]?.url:'';
    if (!value) return '';
    const href=safeUrl(value);
    if (!href || !href.startsWith('https://')) throw new Error(label+'必须使用 HTTPS');
    return href;
  };
  const fields=adapter.fields || {};
  return {
    id,kind:adapter.kind,moduleKey:section.key,modulePath:section.path,title,
    description:plainText(p[common.description]?.rich_text).trim() || title,
    pubDate:new Date(rawDate).toISOString(),tags:(p[common.tags]?.multi_select || []).map(tag=>tag.name),draft:false,featured:!!p[common.featured]?.checkbox,
    projectStatus:adapter.kind==='project'?(p[fields.projectStatus]?.select?.name || ''):'',
    projectType:adapter.kind==='project'?plainText(p[fields.projectType]?.rich_text).trim():'',
    projectUrl:adapter.kind==='project'?publicUrl(fields.projectUrl,'项目主页'):'',
    repository:adapter.kind==='project'?publicUrl(fields.repository,'代码仓库'):'',
  };
}

export async function collectSnapshot({request,config,media,previous=[],targets=null,sources,sections}) {
  if (targets && !targets.length) return structuredClone(previous);
  const common=config.sources.content.commonFields;
  const modules=sections.filter(section=>section.enabled && section.contentSource).map(section=>({section,sourceId:section.sourceId,adapter:config.sources.content.layouts[section.layout]}));
  const bySource=new Map(modules.map(module=>[compactId(module.sourceId),module]));
  for (const module of modules) {
    const source=await request('data_sources/'+module.sourceId);
    requireSchema(source,common,{title:'title',description:'rich_text',status:'select',date:'date',tags:'multi_select',slug:'rich_text',featured:'checkbox',cover:'files'},module.section.name);
    if (module.adapter.kind==='project') requireSchema(source,module.adapter.fields,{projectStatus:'select',projectType:'rich_text',projectUrl:'url',repository:'url'},module.section.name);
  }
  const queued=[];
  const targeted=new Set((targets || []).map(target=>target.id));
  if (targets) {
    for (const target of targets) {
      let page;
      try {page=await request('pages/'+target.id);} catch(error) {
        if (error.status===404 && ['page.deleted','page.moved'].includes(target.type)) continue;
        throw error;
      }
      const module=bySource.get(compactId(page.parent?.data_source_id));
      if (module) queued.push({page,...module});
    }
  } else {
    for (const module of modules) {
      const pages=await queryAll(request,module.sourceId,{filter:{property:common.status,select:{equals:common.published}}});
      queued.push(...pages.map(page=>({page,...module})));
    }
  }
  const published=queued.map(item=>({...item,data:metadata(item.page,{section:item.section,common,adapter:item.adapter})})).filter(item=>item.data);
  const retained=targets?previous.filter(item=>!targeted.has(item.sourcePageId)):[];
  const routes=new Set(retained.map(item=>item.moduleKey+':'+item.id));
  for (const {data} of published) {
    const route=data.moduleKey+':'+data.id;
    if (routes.has(route)) throw new Error('同一栏目存在重复内容路径：'+data.id);
    routes.add(route);
  }
  const route=item=>config.site+(item.modulePath==='/'?'':item.modulePath)+'/'+item.id+'/';
  const links=new Map([...retained.map(item=>[item.sourcePageId,route(item)]),...published.map(({page,data})=>[page.id,route(data)])]);
  const children=blockReader(request,'内容页面');
  const content=[...retained];
  for (const {page,data,section,adapter} of published) {
    const mediaIndex={};
    const html=await renderBlocks(await children(page.id),{children,media:body=>media(body,mediaIndex),publishedLinks:links});
    const current=await request('pages/'+page.id);
    if (!metadata(current,{section,common,adapter}) || current.last_edited_time!==page.last_edited_time) throw new Error('内容正在编辑或下线，留待下一次同步');
    const coverFile=page.properties?.[common.cover]?.files?.[0];
    const cover=coverFile?await media(coverFile,mediaIndex):'';
    content.push({...data,cover,html,sourcePageId:page.id,sourceId:page.parent?.data_source_id,mediaIndex});
  }
  return content.sort((a,b)=>(a.moduleKey+':'+a.id).localeCompare(b.moduleKey+':'+b.id));
}

export async function collectSiteConfig({request,config,media,sources,sections}) {
  const settings=config.sources.settings;
  const sourceId=sources.byName.get(settings.name);
  const source=await request('data_sources/'+sourceId);
  requireSchema(source,settings.fields,{name:'title',description:'rich_text',authorName:'rich_text',authorBio:'rich_text',avatar:'files',email:'email',github:'url',x:'url',rss:'checkbox',theme:'checkbox'},'站点设置');
  const rows=await queryAll(request,sourceId,{sorts:[{timestamp:'last_edited_time',direction:'descending'}]});
  if (rows.length!==1) throw new Error('站点设置必须且只能保留一条记录');
  const page=rows[0],properties=page.properties;
  const text=(key,type='rich_text')=>plainText(properties[settings.fields[key]]?.[type]).trim();
  const name=text('name','title');
  if (!name) throw new Error('站点名称不能为空');
  const authorName=text('authorName') || name;
  const email=String(properties[settings.fields.email]?.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('站点设置中的邮箱格式无效');
  const social=[];
  for (const [key,label] of [['github','GitHub'],['x','X']]) {
    const value=properties[settings.fields[key]]?.url;
    if (value) {const href=safeUrl(value);if (!href || !href.startsWith('https://')) throw new Error(label+' 链接必须使用 HTTPS');social.push({label,href});}
  }
  if (email) social.push({label:'邮箱',href:'mailto:'+email});
  const mediaIndex=Object.assign({},...sections.map(section=>section.mediaIndex));
  const avatarFile=properties[settings.fields.avatar]?.files?.[0];
  const avatar=avatarFile?{src:await media(avatarFile,mediaIndex),alt:authorName}:null;
  const active=sections.filter(section=>section.enabled);
  const byKey=Object.fromEntries(active.map(section=>[section.key,section]));
  const writing=byKey.writing || {},projects=byKey.projects || {},about=byKey.about || {};
  return {
    name,title:name,description:text('description') || name,avatar,author:{name:authorName,bio:text('authorBio'),email},social,
    sections:active.map(({mediaIndex,sourceId,...section})=>section),
    navigation:{home:byKey.home?.navLabel || '首页',writing:writing.navLabel || '写作',projects:projects.navLabel || '项目',about:about.navLabel || '关于'},
    pages:{
      home:{writingTitle:writing.homeTitle || writing.navLabel || '写作',aboutTitle:about.homeTitle || about.heading || '关于',aboutDescription:about.homeDescription || about.description || ''},
      writing:{eyebrow:writing.eyebrow || 'Writing',title:writing.heading || '写作'},
      projects:{eyebrow:projects.eyebrow || 'Projects',title:projects.heading || '项目',description:projects.description || ''},
      about:{eyebrow:about.eyebrow || 'About',title:about.heading || '关于',description:about.description || '',html:about.html || ''},
    },
    features:{rss:!!properties[settings.fields.rss]?.checkbox,theme:!!properties[settings.fields.theme]?.checkbox,projects:!!byKey.projects,about:!!byKey.about},
    sourcePageId:page.id,mediaIndex,
  };
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
  let previous=[],previousSiteConfig=null,revision=0,targets=null,cacheCompatible=false;
  const remote=process.env.SYNC_KEY;
  if (remote) {
    const response=await fetch(config.site+'/_notion-content.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(30000)});
    if (response.ok) {
      const base=await response.json();
      if (!Number.isSafeInteger(base.revision)) throw new Error('已发布内容缓存版本无效');
      revision=base.revision;
      if (base.version===2 && Array.isArray(base.posts) && !base.posts.some(p=>!p.sourcePageId || !p.moduleKey || !p.modulePath || typeof p.html!=='string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id))) {
        previous=base.posts;previousSiteConfig=base.siteConfig || null;cacheCompatible=true;
      }
    } else if (response.status!==404) throw new Error('无法读取已发布内容缓存');
    const planning=await fetch(config.syncWorker+'/plan?since='+revision,{headers:{Authorization:'Bearer '+remote},signal:AbortSignal.timeout(30000)});
    if (!planning.ok) throw new Error('无法获取单篇同步计划');
    const plan=await planning.json();
    if (!Number.isSafeInteger(plan.revision) || plan.revision<revision || !Array.isArray(plan.targets)) throw new Error('单篇同步计划无效');
    if (!response.ok && !plan.full) throw new Error('首次初始化需点击全量更新按钮');
    revision=plan.revision;targets=plan.full || !cacheCompatible?null:plan.targets;
  } else if (process.env.CF_PAGES) throw new Error('缺少 SYNC_KEY，停止构建以避免意外全量发布');
  const request = createRequest({token:process.env.NOTION_TOKEN,cliScript:process.env.NOTION_CLI_SCRIPT});
  const assets = new Map();
  const cachedMedia=Object.assign({},...previous.map(post=>post.mediaIndex || {}),previousSiteConfig?.mediaIndex || {});
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
  const sources=await discoverSources({request,config});
  const sections=await collectSections({request,config,sources,media});
  const content = await collectSnapshot({request,config,media,previous,targets,sources,sections});
  const siteConfig = await collectSiteConfig({request,config,media,sources,sections});
  // Retain unchanged files from the published CDN instead of re-downloading them from Notion.
  const needed=[...new Set([...content.flatMap(item=>Object.values(item.mediaIndex || {})),...Object.values(siteConfig?.mediaIndex || {})])];
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
  const posts=content.filter(item=>item.kind!=='project');
  const projects=content.filter(item=>item.kind==='project');
  const output=resolve(dataDir,'notion-posts.json');
  await writeFile(output+'.tmp',JSON.stringify(posts,null,2)+'\n'); await rename(output+'.tmp',output);
  const projectsOutput=resolve(dataDir,'notion-projects.json');
  await writeFile(projectsOutput+'.tmp',JSON.stringify(projects,null,2)+'\n'); await rename(projectsOutput+'.tmp',projectsOutput);
  if (siteConfig) await writeFile(resolve(dataDir,'site-config.json'),JSON.stringify(siteConfig,null,2)+'\n');
  await writeFile(resolve(root,'public/_notion-content.json'),JSON.stringify({version:2,revision,posts:content,siteConfig})+'\n');
  await writeFile(resolve(root,'public/_notion-sync.json'),JSON.stringify({syncedAt,revision,mode:targets===null?'full':'incremental',updated:targets===null?content.length:targets.length})+'\n');
  // Delete only generated hash-named files inside this project's generated asset directory.
  for (const name of await readdir(assetDir)) if (/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name) && !assets.has(name)) {
    const target=resolve(assetDir,name);
    if (dirname(target)!==assetDir || basename(target)!==name) throw new Error('附件路径校验失败');
    await unlink(target);
  }
  console.log('Notion '+(targets===null?'全量':'单篇增量')+'同步完成：本次读取 '+(targets===null?content.length:targets.length)+' 条，合计 '+posts.length+' 篇文章、'+projects.length+' 个项目，'+assets.size+' 个附件。');
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) runSync().catch(error=>{console.error(error.message);process.exitCode=1;});
