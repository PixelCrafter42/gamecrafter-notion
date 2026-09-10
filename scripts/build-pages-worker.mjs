import { readFile, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const contentPaths=[];
for (const section of ['blog','projects']) {
  const files = await readdir('dist/'+section, { recursive: true });
  contentPaths.push(...files.filter(file => file.replaceAll('\\', '/').endsWith('/index.html'))
    .flatMap(file => {
      const path = '/'+section+'/' + file.replaceAll('\\', '/').slice(0, -11);
      return [path, path + '/', path + '/index.html'];
    }));
}
const template = await readFile('scripts/pages-worker.mjs', 'utf8');
await writeFile('dist/_worker.js', template
  .replace('"BUILD_VERSION"', JSON.stringify(randomUUID()))
  .replace('["CONTENT_PATHS"]', JSON.stringify(contentPaths)));
await writeFile('dist/_routes.json', JSON.stringify({
  version: 1, include: ['/*'], exclude: ['/_astro/*', '/notion-media/*', '/fonts/*'],
}));
