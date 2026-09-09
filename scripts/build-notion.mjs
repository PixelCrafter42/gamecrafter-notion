import { runSync } from './sync-notion.mjs';
if (process.env.NOTION_TOKEN || process.env.NOTION_CLI_SCRIPT) {
  await runSync();
} else if (process.env.CF_PAGES || process.env.NOTION_REQUIRED === '1') {
  throw new Error('Cloudflare Pages 缺少 NOTION_TOKEN：停止构建，保留线上版本');
} else {
  console.log('本地构建使用已保存的 Notion 内容快照。');
}
