import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { contentPaths } from './content-routes.mjs';
import { buildSectionPaths } from '../src/section-routes.mjs';

const source = (await readFile(new URL('./pages-worker.mjs', import.meta.url), 'utf8'))
  .replace('"BUILD_VERSION"', '"revision-test"')
  .replace('["CONTENT_PATHS"]', '["/blog/live", "/blog/live/", "/blog/live/index.html", "/projects/tool", "/projects/tool/", "/projects/tool/index.html"]');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('published paths follow each Notion module path',()=>{
  assert.deepEqual(contentPaths([{id:'note',modulePath:'/research'}]),['/research/note','/research/note/','/research/note/index.html']);
  assert.throws(()=>contentPaths([{id:'../secret',modulePath:'/research'}]),/无效路径/);
});
test('a new article-list section produces index and detail routes without code changes',()=>{
  const section={key:'research',path:'/research',layout:'文章列表',enabled:true};
  const post={id:'first-note',data:{moduleKey:'research'}};
  const routes=buildSectionPaths({sections:[section],posts:[post],projects:[]});
  assert.deepEqual(routes.map(route=>route.params.path),['research','research/first-note']);
  assert.equal(routes[0].props.view,'archive');
  assert.equal(routes[1].props.view,'article');
});

test('withdrawn article cannot serve a stale body, including direct index.html access', async () => {
  for (const path of ['/blog/draft/', '/blog/draft', '/blog/draft/index.html']) {
    const result = await worker.fetch(new Request('https://example.com' + path), { ASSETS: {
      fetch: async request => new Response(new URL(request.url).pathname === '/404.html' ? 'Not found' : 'STALE ARTICLE'),
    }});
    assert.equal(result.status, 404);
    assert.equal(await result.text(), 'Not found');
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});
test('withdrawn project cannot serve a stale body', async () => {
  const result = await worker.fetch(new Request('https://example.com/projects/retired/'), { ASSETS: {
    fetch: async request => new Response(new URL(request.url).pathname === '/404.html' ? 'Not found' : 'STALE PROJECT'),
  }});
  assert.equal(result.status, 404);
  assert.equal(await result.text(), 'Not found');
});
test('published article uses build-specific asset cache and ignores old conditional requests', async () => {
  const result = await worker.fetch(new Request('https://example.com/blog/live/?__deployment=old', {
    headers: { 'If-None-Match': 'old' },
  }), { ASSETS: { fetch: async request => {
    assert.equal(new URL(request.url).searchParams.get('__deployment'), 'revision-test');
    assert.equal(request.headers.has('If-None-Match'), false);
    return new Response('CURRENT ARTICLE');
  }}});
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'CURRENT ARTICLE');
});
test('canonical redirect does not expose internal version query', async () => {
  const result = await worker.fetch(new Request('https://example.com/blog/live'), { ASSETS: {
    fetch: async () => new Response(null, { status: 308, headers: { Location: 'https://example.com/blog/live/?__deployment=revision-test' } }),
  }});
  assert.equal(result.status, 308);
  assert.equal(result.headers.get('Location'), 'https://example.com/blog/live/');
});
