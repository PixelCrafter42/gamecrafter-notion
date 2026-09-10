import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSections,collectSiteConfig,collectSnapshot,discoverSources,metadata} from './sync-notion.mjs';
import {richText,renderBlocks} from './notion-render.mjs';

const rt=text=>[{type:'text',plain_text:text,text:{content:text}}];
const block=text=>({id:'block',type:'paragraph',paragraph:{rich_text:rt(text)}});
const common={title:'标题',description:'摘要',status:'发布状态',published:'已发布',date:'发布日期',tags:'标签',slug:'路径',featured:'精选',cover:'封面'};
const settingsFields={name:'站点名称',description:'简介',authorName:'作者名称',authorBio:'作者简介',avatar:'头像',email:'邮箱',github:'GitHub',x:'X',rss:'显示 RSS',theme:'显示明暗切换'};
const sectionFields={name:'栏目',key:'标识',path:'路径',layout:'布局',enabled:'启用',navLabel:'导航名称',showInNav:'显示在导航',navOrder:'导航排序',eyebrow:'页眉',heading:'页面标题',description:'页面简介',showOnHome:'首页展示',homeTitle:'首页标题',homeDescription:'首页简介',homeLimit:'首页数量',contentSource:'内容数据源'};
const projectFields={projectStatus:'项目状态',projectType:'项目类型',projectUrl:'项目主页',repository:'代码仓库'};
const config={
  databaseId:'cms',site:'https://gamecrafter.fun',
  sources:{
    settings:{name:'站点设置',fields:settingsFields},sections:{name:'栏目管理',fields:sectionFields},
    content:{commonFields:common,layouts:{'文章列表':{kind:'article'},'项目网格':{kind:'project',fields:projectFields}}},
  },
};
const sources={byName:new Map([['站点设置','settings'],['栏目管理','sections'],['写作','writing'],['项目','projects']])};
const section=(key='writing',overrides={})=>({key,name:key==='projects'?'项目':'写作',path:key==='projects'?'/projects':'/blog',layout:key==='projects'?'项目网格':'文章列表',enabled:true,navLabel:key,showInNav:true,navOrder:1,eyebrow:'',heading:key,description:'',showOnHome:true,homeTitle:key,homeDescription:'',homeLimit:5,contentSource:key==='projects'?'项目':'写作',sourceId:key==='projects'?'projects':'writing',sourcePageId:key+'-section',html:'',mediaIndex:{},...overrides});
const page=(id='one',status='已发布',sourceId='writing')=>({id,created_time:'2026-09-09T00:00:00Z',last_edited_time:'2026-09-09T00:00:00Z',parent:{data_source_id:sourceId},properties:{标题:{title:rt(id)},摘要:{rich_text:[]},发布状态:{select:{name:status}},发布日期:{date:null},标签:{multi_select:[]},路径:{rich_text:rt(id)},精选:{checkbox:false},封面:{files:[]},项目状态:{select:null},项目类型:{rich_text:[]},项目主页:{url:null},代码仓库:{url:null}}});
const contentSchema=(kind='article')=>({properties:Object.fromEntries([
  ['title','title'],['description','rich_text'],['status','select'],['date','date'],['tags','multi_select'],['slug','rich_text'],['featured','checkbox'],['cover','files'],
  ...(kind==='project'?[['projectStatus','select'],['projectType','rich_text'],['projectUrl','url'],['repository','url']]:[]),
].map(([key,type])=>[(kind==='project'&&projectFields[key])||common[key],{type}]))});

test('database discovery uses source names and rejects an incomplete CMS',async()=>{
  const request=async()=>({data_sources:[{id:'settings',name:'站点设置'},{id:'sections',name:'栏目管理'},{id:'writing',name:'写作'}]});
  const value=await discoverSources({request,config});
  assert.equal(value.byName.get('写作'),'writing');
  await assert.rejects(()=>discoverSources({request:async()=>({data_sources:[]}),config}),/缺少数据源/);
});

test('drafts, archived and trashed pages never publish',()=>{
  const context={section:section(),common,adapter:{kind:'article'}};
  assert.equal(metadata(page('draft','草稿'),context),null);
  assert.equal(metadata({...page(),in_trash:true},context),null);
  assert.equal(metadata({...page(),is_archived:true},context),null);
  assert.equal(metadata(page(),context).moduleKey,'writing');
});

test('different module sources keep their own schema and routes',()=>{
  const value=page('tool','已发布','projects');
  value.properties.精选.checkbox=true;value.properties.项目状态.select={name:'进行中'};value.properties.项目类型.rich_text=rt('网站');value.properties.项目主页.url='https://example.com';
  const result=metadata(value,{section:section('projects'),common,adapter:{kind:'project',fields:projectFields}});
  assert.equal(result.kind,'project');assert.equal(result.modulePath,'/projects');assert.equal(result.projectStatus,'进行中');assert.equal(result.projectType,'网站');
});

test('incremental publication reads one target and preserves other modules',async()=>{
  const sections=[section(),section('projects')];
  const old=[{id:'one',moduleKey:'writing',modulePath:'/blog',sourcePageId:'one',html:'old A',mediaIndex:{}},{id:'tool',moduleKey:'projects',modulePath:'/projects',sourcePageId:'tool',html:'old B',mediaIndex:{}}];
  const calls=[];
  const request=async path=>{
    calls.push(path);
    if(path==='data_sources/writing')return contentSchema();
    if(path==='data_sources/projects')return contentSchema('project');
    if(path==='pages/one')return page('one');
    if(path.startsWith('blocks/one/'))return {results:[block('new A')],has_more:false};
    throw new Error('unexpected '+path);
  };
  const items=await collectSnapshot({config,request,media:async()=>'',previous:old,targets:[{id:'one',type:'article-button'}],sources,sections});
  assert.equal(items.find(item=>item.id==='one').html,'<p>new A</p>');
  assert.deepEqual(items.find(item=>item.id==='tool'),old[1]);
  assert.equal(calls.filter(path=>path.includes('/query')).length,0);
});

test('drafting, deleting, or moving an item removes only that item',async()=>{
  const sections=[section()];
  const previous=[{id:'one',moduleKey:'writing',modulePath:'/blog',sourcePageId:'one'},{id:'two',moduleKey:'writing',modulePath:'/blog',sourcePageId:'two'}];
  for(const value of [page('one','草稿'),{...page('one'),parent:{data_source_id:'other'}},null]){
    const request=async path=>{
      if(path==='data_sources/writing')return contentSchema();
      if(value)return value;
      const error=new Error('missing');error.status=404;throw error;
    };
    const items=await collectSnapshot({config,request,previous,targets:[{id:'one',type:'page.deleted'}],sources,sections});
    assert.deepEqual(items,[previous[1]]);
    if(!value)await assert.rejects(()=>collectSnapshot({config,request,previous,targets:[{id:'one',type:'article-button'}],sources,sections}),/missing/);
  }
});

test('full reconciliation follows pagination and scopes duplicate paths by module',async()=>{
  const sections=[section(),section('projects')];let writingQueries=0;
  const request=async(path,opts)=>{
    if(path==='data_sources/writing')return contentSchema();
    if(path==='data_sources/projects')return contentSchema('project');
    if(path==='data_sources/writing/query'){writingQueries++;return opts.body.start_cursor?{results:[page('two')],has_more:false}:{results:[page('same')],has_more:true,next_cursor:'next'};}
    if(path==='data_sources/projects/query')return {results:[page('same','已发布','projects')],has_more:false};
    if(path.startsWith('blocks/'))return {results:[],has_more:false};
    if(path.startsWith('pages/'))return path.includes('projects')?page('same','已发布','projects'):page(path.split('/').at(-1));
    throw new Error('unexpected '+path);
  };
  const items=await collectSnapshot({config,request,media:async()=>'',sources,sections});
  assert.equal(items.length,3);assert.equal(writingQueries,2);
});

test('sections drive navigation and ordinary page bodies',async()=>{
  const properties=(key,path,layout,source='')=>({
    栏目:{title:rt(key)},标识:{rich_text:rt(key)},路径:{rich_text:rt(path)},布局:{select:{name:layout}},启用:{checkbox:true},导航名称:{rich_text:rt(key)},显示在导航:{checkbox:true},导航排序:{number:1},页眉:{rich_text:[]},页面标题:{rich_text:rt(key)},页面简介:{rich_text:[]},首页展示:{checkbox:false},首页标题:{rich_text:[]},首页简介:{rich_text:[]},首页数量:{number:0},内容数据源:{rich_text:rt(source)},
  });
  const sectionSchema={properties:Object.fromEntries(Object.entries({name:'title',key:'rich_text',path:'rich_text',layout:'select',enabled:'checkbox',navLabel:'rich_text',showInNav:'checkbox',navOrder:'number',eyebrow:'rich_text',heading:'rich_text',description:'rich_text',showOnHome:'checkbox',homeTitle:'rich_text',homeDescription:'rich_text',homeLimit:'number',contentSource:'rich_text'}).map(([key,type])=>[sectionFields[key],{type}]))};
  const request=async path=>path==='data_sources/sections'?sectionSchema:path==='data_sources/sections/query'?{results:[{id:'home',properties:properties('home','/','首页')},{id:'about',properties:properties('about','/about','普通页面')}],has_more:false}:path.startsWith('blocks/about/')?{results:[block('关于正文')],has_more:false}:{results:[],has_more:false};
  const value=await collectSections({request,config,sources,media:async()=>''});
  assert.equal(value.find(item=>item.key==='about').html,'<p>关于正文</p>');
});

test('site settings combine with section rows into public configuration',async()=>{
  const properties={站点名称:{title:rt('Craft4Fun')},简介:{rich_text:rt('记录。')},作者名称:{rich_text:rt('Crafter')},作者简介:{rich_text:rt('慢慢写。')},头像:{files:[{type:'file',file:{url:'https://example.com/avatar.png'}}]},邮箱:{email:'hello@example.com'},GitHub:{url:'https://github.com/example'},X:{url:null},'显示 RSS':{checkbox:true},显示明暗切换:{checkbox:false}};
  const schema={properties:Object.fromEntries(Object.entries({name:'title',description:'rich_text',authorName:'rich_text',authorBio:'rich_text',avatar:'files',email:'email',github:'url',x:'url',rss:'checkbox',theme:'checkbox'}).map(([key,type])=>[settingsFields[key],{type}]))};
  const sections=[section('home',{path:'/',contentSource:'',sourceId:'',navLabel:'首页'}),section(),section('projects'),section('about',{path:'/about',layout:'普通页面',contentSource:'',sourceId:'',navLabel:'关于',heading:'关于我',html:'<p>关于正文</p>'})];
  const request=async path=>path==='data_sources/settings'?schema:{results:[{id:'settings-page',properties}],has_more:false};
  const value=await collectSiteConfig({config,request,media:async()=>'/notion-media/avatar.png',sources,sections});
  assert.equal(value.name,'Craft4Fun');assert.equal(value.avatar.src,'/notion-media/avatar.png');assert.equal(value.pages.about.html,'<p>关于正文</p>');
  assert.deepEqual(value.social,[{label:'GitHub',href:'https://github.com/example'},{label:'邮箱',href:'mailto:hello@example.com'}]);
  properties.GitHub.url='javascript:alert(1)';
  await assert.rejects(()=>collectSiteConfig({config,request,media:async()=>'',sources,sections}),/HTTPS/);
});

test('rich text and block rendering remain safe',async()=>{
  assert.equal(richText([{type:'text',plain_text:'<script>bad</script>',href:'javascript:alert(1)'}]),'&lt;script&gt;bad&lt;/script&gt;');
  const list=[{id:'1',type:'numbered_list_item',has_children:true,numbered_list_item:{rich_text:rt('one')}},{id:'2',type:'numbered_list_item',numbered_list_item:{rich_text:rt('two')}}];
  assert.equal(await renderBlocks(list,{children:async()=>[block('nested')],media:async()=>''}),'<ol><li>one<p>nested</p></li><li>two</li></ol>');
  await assert.rejects(()=>renderBlocks([{type:'synced_block'}],{children:async()=>[],media:async()=>''}),/不支持/);
});
