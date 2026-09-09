import test from 'node:test';
import assert from 'node:assert/strict';
import {metadata,collectSnapshot} from './sync-notion.mjs';
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
