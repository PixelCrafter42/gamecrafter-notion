import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { contentPaths } from './content-routes.mjs';

const content=[
  ...JSON.parse(await readFile('src/data/notion-posts.json','utf8')),
  ...JSON.parse(await readFile('src/data/notion-projects.json','utf8')),
];
const publishedPaths=contentPaths(content);
const template = await readFile('scripts/pages-worker.mjs', 'utf8');
await writeFile('dist/_worker.js', template
  .replace('"BUILD_VERSION"', JSON.stringify(randomUUID()))
  .replace('["CONTENT_PATHS"]', JSON.stringify(publishedPaths)));
await writeFile('dist/_routes.json', JSON.stringify({
  version: 1, include: ['/*'], exclude: ['/_astro/*', '/notion-media/*', '/fonts/*'],
}));
