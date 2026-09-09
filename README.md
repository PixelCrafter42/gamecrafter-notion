# Craft4Fun：Notion 博客

网站：https://gamecrafter.fun
管理：[Notion 博客管理](https://www.notion.so/3d67448d2ab181ddb9b2c516e26bf75b)

## 写作与发布

1. 在「博客文章」新建文章，填写标题，打开页面写正文。
2. 填写摘要、发布日期、标签。文章链接可留空，或填写小写英文短名，如 my-first-post。
3. 将「发布状态」改成「已发布」即可触发发布；改为草稿或删除文章会触发下线。
4. 标题等属性变化也自动更新。正文编辑完成后，点击管理页「发布到博客」按钮更新。

只发布状态为「已发布」的文章。按钮会更新全部已发布文章，不会发布草稿。
两种 Webhook 最终都触发 Cloudflare Pages 构建，生效需等待构建完成；Notion 自动事件还可能聚合延迟。
没有 GitHub 定时任务。代码提交仍会触发正常部署，也会读取当前已发布内容。
发布日期用于排序，不是定时发布开关。修改文章链接会改变 URL，旧地址不自动跳转。
不要重命名数据库字段，除非同时修改 notion.config.json。

支持段落、标题、列表、代码、引用、折叠、待办、表格、图片和常见附件。
Notion 上传附件复制到本站，单文件上限 20 MB。外链媒体保留原地址。
特殊区块不支持时本轮构建失败，保留线上版本。错误可查看 Pages 构建日志。

## 配置

Notion → Cloudflare Worker → Pages Deploy Hook → 构建时读取 Notion → 静态网站。

- Pages 生产环境加密密钥：NOTION_TOKEN。内部连接只读，范围仅博客文章库。
- Worker 位于 workers/notion-webhook，Wrangler 配置自动创建 SQLite Durable Object。
- Worker 加密密钥：SETUP_KEY、PUBLISH_KEY、DEPLOY_HOOK_URL。
- 自动订阅：page.created、page.properties_updated、page.deleted、page.undeleted、page.moved。
- 自动端点：/notion/<SETUP_KEY>。验证令牌暂存于 Durable Object，通过 /setup/<SETUP_KEY> 读取后填入 Notion；第一个有效签名事件到达后此读取入口关闭。
- 手动按钮：Send webhook，POST /publish/<PUBLISH_KEY>。
- 不订阅 page.content_updated。按钮 URL 是私密凭据，只放在私人管理页按钮配置中。

自动事件校验 HMAC 签名和工作区，去重并合并连续触发。构建失败有限重试，根路径返回发布状态。
Pages 构建缺失密钥、读取失败、数据异常时停止部署，保留旧网站。
生成内容单向来自 Notion，不要直接修改 src/data/notion-posts.json。
下线不清除旧部署或互联网缓存。

## 开发

Node.js 22.19 或更新维护版本。

```sh
npm ci
npm test
npm run build
npm run dev
```

本地无密钥时使用已提交内容快照；有 NOTION_TOKEN 时构建读取 Notion。
本机可用 NOTION_CLI_SCRIPT 指向已登录 ntn 的入口，不将 CLI 登录凭据部署到云端。

Pages 构建命令 npm run build，输出 dist，分支 main。
Worker 根目录 workers/notion-webhook，部署命令 npx wrangler deploy。
站点标题简介 src/consts.ts，样式 src/styles/global.css。
