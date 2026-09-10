import test from 'node:test';
import assert from 'node:assert/strict';
import {metadata,collectSnapshot,collectSiteConfig} from './sync-notion.mjs';
import {richText,renderBlocks} from './notion-render.mjs';

const fields={title:'标题',description:'摘要',status:'发布状态',published:'已发布',date:'发布日期',tags:'标签',slug:'文章链接'};
const config={fields,dataSourceId:'db',site:'https://gamecrafter.fun'};
const rt=text=>[{type:'text',plain_text:text,text:{content:text}}];
const page=(id='one',status='已发布')=>({id,created_time:'2026-09-09T00:00:00Z',last_edited_time:'2026-09-09T00:00:00Z',properties:{标题:{title:rt(id)},摘要:{rich_text:[]},发布状态:{select:{name:status}},发布日期:{date:null},标签:{multi_select:[]},文章链接:{rich_text:rt(id)}}});
const schema={properties:Object.fromEntries([['title','title'],['description','rich_text'],['status','select'],['date','date'],['tags','multi_select'],['slug','rich_text']].map(([key,type])=>[fields[key],{type}]))};
const block=text=>({id:'block',type:'paragraph',paragraph:{rich_text:rt(text)}});

test('drafts, archived and trashed pages never publish',()=>{
  assert.equal(metadata(page('draft','草稿'),fields),null);
  assert.equal(metadata({...page(),in_trash:true},fields),null);
  assert.equal(metadata({...page(),archived:true},fields),null);
  assert.equal(metadata({...page(),is_archived:true},fields),null);
  assert.equal(metadata(page(),fields).id,'one');
});
test('incremental publication reads only the target and preserves other published bodies',async()=>{
  const old=[{id:'one',sourcePageId:'one',html:'old A',mediaIndex:{}},{id:'two',sourcePageId:'two',html:'old B',mediaIndex:{}}];
  const calls=[];
  const request=async path=>{
    calls.push(path);
    if(path==='data_sources/db') return schema;
    if(path==='pages/one') return {...page('one'),parent:{data_source_id:'db'}};
    if(path.startsWith('blocks/one/')) return {results:[block('new A')],has_more:false};
    throw new Error('must never read B or query all pages: '+path);
  };
  const posts=await collectSnapshot({config,request,media:async()=>'',previous:old,targets:[{id:'one',type:'article-button'}]});
  assert.equal(posts.find(p=>p.id==='one').html,'<p>new A</p>');
  assert.deepEqual(posts.find(p=>p.id==='two'),old[1]);
  assert.equal(calls.filter(p=>p.startsWith('blocks/')).length,1);
  assert.deepEqual(await collectSnapshot({previous:old,targets:[]}),old);
});
test('incremental draft, deletion and moving out remove only the target; unrelated 404 fails closed',async()=>{
  const previous=[{id:'one',sourcePageId:'one',html:'A'},{id:'two',sourcePageId:'two',html:'B'}];
  for(const value of [{...page('one','草稿'),parent:{data_source_id:'db'}},{...page('one'),parent:{data_source_id:'other'}},null]) {
    const request=async path=>{
      if(path==='data_sources/db') return schema;
      if(value) return value;
      const error=new Error('missing');error.status=404;throw error;
    };
    const posts=await collectSnapshot({config,request,previous,targets:[{id:'one',type:'page.deleted'}]});
    assert.deepEqual(posts,[previous[1]]);
    if(!value) await assert.rejects(()=>collectSnapshot({config,request,previous,targets:[{id:'one',type:'article-button'}]}),/missing/);
  }
});
test('incremental duplicate slug cannot overwrite an unrelated article',async()=>{
  const request=async path=>path==='data_sources/db'?schema:{...page('two'),id:'one',parent:{data_source_id:'db'}};
  await assert.rejects(()=>collectSnapshot({config,request,previous:[{id:'two',sourcePageId:'two'}],targets:[{id:'one'}]}),/重复/);
});
test('slugs reject traversal and unsafe path syntax',()=>{
  for (const slug of ['../secret','a/b','<script>','A B','a?x=1']) assert.throws(()=>metadata(page(slug),fields));
});
test('rich text escapes HTML and blocks executable link schemes',()=>{
  assert.equal(richText([{type:'text',plain_text:'<script>bad</script>',href:'javascript:alert(1)'}]),'&lt;script&gt;bad&lt;/script&gt;');
  assert.match(richText([{...rt('safe')[0],href:'https://example.com/?q="'}]),/href="https:\/\/example.com/);
  assert.equal(richText([{type:'mention',plain_text:'Private page',href:'https://notion.so/private'}]),'Private page');
});
test('nested lists stay valid and unknown blocks stop publication',async()=>{
  const list=[{id:'1',type:'numbered_list_item',has_children:true,numbered_list_item:{rich_text:rt('one')}},{id:'2',type:'numbered_list_item',numbered_list_item:{rich_text:rt('two')}}];
  assert.equal(await renderBlocks(list,{children:async()=>[block('nested')],media:async()=>''}),'<ol><li>one<p>nested</p></li><li>two</li></ol>');
  await assert.rejects(()=>renderBlocks([{type:'synced_block'}],{children:async()=>[],media:async()=>''}),/不支持/);
});
test('full reconciliation follows pagination, removes missing posts, and accepts zero published posts',async()=>{
  const p1=page('one'),p2=page('two');
  let queries=0,blockReads=0;
  const request=async(path,opts)=>{
    if(path==='data_sources/db')return schema;
    if(path.endsWith('/query')) {queries++; return opts.body.start_cursor ? {results:[p2],has_more:false} : {results:[p1],has_more:true,next_cursor:'next'};}
    if(path.startsWith('pages/'))return path.endsWith('one')?p1:p2;
    if(path.includes('/children')) {blockReads++;return {results:[block('content')],has_more:false};}
    throw new Error('unexpected');
  };
  const posts=await collectSnapshot({request,config,media:async()=>''});
  assert.deepEqual(posts.map(p=>p.id),['one','two']);assert.equal(queries,2);assert.equal(blockReads,2);
  const empty=await collectSnapshot({config,media:async()=>'',request:async path=>path==='data_sources/db'?schema:{results:[],has_more:false}});
  assert.deepEqual(empty,[]);
});
test('duplicate slugs, schema changes, API failure and concurrent unpublishing fail closed',async()=>{
  await assert.rejects(()=>collectSnapshot({config,request:async()=>({properties:{}})}),/字段/);
  await assert.rejects(()=>collectSnapshot({config,request:async path=>path==='data_sources/db'?schema:{results:[page(),page()],has_more:false}}),/重复/);
  await assert.rejects(()=>collectSnapshot({config,request:async()=>{throw new Error('offline');}}),/offline/);
  await assert.rejects(()=>collectSnapshot({config,media:async()=>'',request:async path=>path==='data_sources/db'?schema:path.endsWith('/query')?{results:[page()],has_more:false}:path.startsWith('blocks/')?{results:[],has_more:false}:page('one','草稿')}),/正在编辑或下线/);
});

test('site settings map one Notion row to safe public configuration',async()=>{
  const siteFields={name:'站点名称',description:'简介',authorName:'作者名称',authorBio:'作者简介',avatar:'头像',email:'邮箱',github:'GitHub',x:'X',rss:'显示 RSS',theme:'显示明暗切换'};
  const siteConfig={databaseId:'settings',fields:siteFields};
  const properties={
    站点名称:{title:rt('Craft4Fun')},简介:{rich_text:rt('记录。')},作者名称:{rich_text:rt('Crafter')},作者简介:{rich_text:rt('慢慢写。')},
    头像:{files:[{type:'file',file:{url:'https://example.com/avatar.png'}}]},邮箱:{email:'hello@example.com'},GitHub:{url:'https://github.com/example'},X:{url:null},
    '显示 RSS':{checkbox:true},显示明暗切换:{checkbox:false},
  };
  const settingsSchema={properties:Object.fromEntries(Object.entries({name:'title',description:'rich_text',authorName:'rich_text',authorBio:'rich_text',avatar:'files',email:'email',github:'url',x:'url',rss:'checkbox',theme:'checkbox'}).map(([key,type])=>[siteFields[key],{type}]))};
  const request=async path=>path==='databases/settings'?{data_sources:[{id:'source'}]}:path==='data_sources/source'?settingsSchema:{results:[{properties}]};
  const value=await collectSiteConfig({config:{siteConfig},request,media:async()=>'/notion-media/avatar.png'});
  assert.equal(value.name,'Craft4Fun');assert.equal(value.avatar.src,'/notion-media/avatar.png');assert.equal(value.author.email,'hello@example.com');
  assert.deepEqual(value.social,[{label:'GitHub',href:'https://github.com/example'},{label:'邮箱',href:'mailto:hello@example.com'}]);
  assert.deepEqual(value.features,{rss:true,theme:false});
  properties.GitHub.url='javascript:alert(1)';
  await assert.rejects(()=>collectSiteConfig({config:{siteConfig},request,media:async()=>''}),/HTTPS/);
});
