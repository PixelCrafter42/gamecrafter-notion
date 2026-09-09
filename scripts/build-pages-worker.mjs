import { readFile, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const files = await readdir('dist/blog', { recursive: true });
const articlePaths = files.filter(file => file.replaceAll('\\', '/').endsWith('/index.html'))
  .flatMap(file => {
    const path = '/blog/' + file.replaceAll('\\', '/').slice(0, -11);
    return [path, path + '/', path + '/index.html'];
  });
const template = await readFile('scripts/pages-worker.mjs', 'utf8');
await writeFile('dist/_worker.js', template
  .replace('"BUILD_VERSION"', JSON.stringify(randomUUID()))
  .replace('["ARTICLE_PATHS"]', JSON.stringify(articlePaths)));
await writeFile('dist/_routes.json', JSON.stringify({
  version: 1, include: ['/*'], exclude: ['/_astro/*', '/notion-media/*', '/fonts/*'],
}));
