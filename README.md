# Craft4Fun：Notion 博客

网站：https://gamecrafter.fun
管理：[Notion 博客管理](https://www.notion.so/3d67448d2ab181ddb9b2c516e26bf75b)

## 写作与发布

「博客后台 · gamecrafter.fun」是统一的多数据源数据库。通过顶部标签进入「写作」「想法」「项目」「站点设置」和「栏目管理」。各内容数据源拥有自己的字段，状态为「已发布」才会出现在网站。

- 修改文章属性（包括发布状态）：只同步该篇文章。
- 编辑正文后点击该行的「发布」按钮字段：只同步该篇文章。
- 管理页「全量更新」按钮：重新读取全部已发布文章，适合主动批量发布或修复缓存。
- 改成草稿、删除或移出文章库：移除该篇已发布缓存。

「想法」用于短内容。标题直接显示为动态正文；摘要和页面正文可选，适合补充链接、图片或较长说明。发布日期可以精确到时间。想法列表采用单列时间流，按发布日期倒序排列，每条想法也有独立链接。栏目管理中可控制它是否显示在导航和首页，以及首页显示数量。

单篇发布沿用其他文章上一次发布的内容，不读取其他文章未发布的正文修改。
同一批待处理的文章会一起同步。按钮不改变文章状态，草稿不会因点击按钮而公开。
每次同步后仍重新构建静态网站，使首页、归档、RSS、站点地图保持一致。
Notion 事件可能聚合延迟，触发后还需等待构建完成；无 GitHub 定时任务。
代码提交没有新的内容事件时只使用已发布缓存，不重新读取 Notion。

文章链接可留空，或填写小写英文短名，如 my-first-post。修改后旧 URL 不自动跳转。
发布日期用于排序，不是定时发布。不要重命名字段，除非同时更新 notion.config.json。
支持段落、标题、列表、代码、引用、折叠、待办、表格、图片和常见附件。
Notion 附件上限 20 MB。未变化的上传附件从已发布 CDN 复用，不重复请求 Notion 附件地址。
静态部署仍需携带全站文件；文章数和媒体总量增长后，全站构建及文件传输仍会增长。

## 同步逻辑

Notion Webhook → Cloudflare Worker 记录文章 ID 与递增版本 → Pages Deploy Hook → 单篇读取 → 全站构建。

Worker Durable Object 保存每篇文章最后一次请求的版本及全量请求版本。
构建先取线上 /_notion-content.json 已发布快照，再用 /plan?since=<revision> 获取尚未发布的目标文章。
只替换目标文章，其他内容和媒体索引保持不变。整个成功部署同时发布新快照和 /_notion-sync.json 版本标记。
处理过程中到达的新事件版本不会被旧构建确认清除。失败有限重试，旧线上版本保留。
首次初始化缺少快照时必须主动全量更新，不会将缓存读取错误隐式降级为全量发布。
快照只包含已发布内容，不含草稿、Notion token 或原始附件签名 URL。

## 配置

「站点设置」只保存站点名称、简介、作者资料、头像、邮箱、社交链接、RSS 和明暗模式。「栏目管理」每行代表一个栏目，管理路径、导航、页面标题、首页展示和内容数据源；“关于”记录的页面正文就是网站关于页正文。属性修改会自动触发增量发布，正文修改完成后点击对应行的「发布」按钮。头像和正文附件会下载到站点资源中，不依赖会过期的 Notion 文件地址。`src/site.config.ts` 只负责读取同步生成的配置并固定正式域名。

文章、想法和项目使用独立数据源，但复用同一个发布按钮和增量机制。项目可填写状态、项目类型、项目主页、代码仓库、封面和“精选”；精选项目优先出现在首页。

扩展栏目时遵循“控制信息在栏目管理、内容字段在独立数据源”的结构。所有内容数据源共享标题、摘要、发布状态、发布日期、标签、路径、封面和精选字段，再增加模块专属字段。使用现有布局只需新增数据源和栏目记录；增加新的页面形态时，在 `notion.config.json` 注册布局适配器并为主题增加对应组件，同步核心和其他数据源无需改动。同步开始时会从数据库容器发现各数据源 ID，因此移动或新增数据源不需要增加 Cloudflare 环境变量。

当前主题是 [A Quiet Publication](https://github.com/Liyuk/astro-fourfold)，主题组件位于 `src/themes/quiet-publication/`，`src/theme.ts` 是页面使用的主题入口。Notion 同步与主题目录彼此独立；以后接入其他主题时实现相同的页面组件，再在 `src/theme.ts` 切换导出即可，不需要修改同步 Worker。

主题专属的视觉配置位于 `src/themes/quiet-publication/theme.config.ts`；首页首屏的字号和留白可以直接在这里调整。

Pages 生产环境加密密钥：NOTION_TOKEN（博客后台只读）、SYNC_KEY（与 Worker PUBLISH_KEY 一致）。
Worker 位于 workers/notion-webhook，密钥为 SETUP_KEY、PUBLISH_KEY、DEPLOY_HOOK_URL。

- 自动事件：page.created、page.properties_updated、page.deleted、page.undeleted、page.moved。
- 自动端点：/notion/<SETUP_KEY>，验证 Notion HMAC 签名。
- 数据库按钮端点：/article/<PUBLISH_KEY>，从 Notion 标准按钮请求的 data.id 获取任意内容或栏目页面 ID。
- 全量按钮端点：/publish/<PUBLISH_KEY>。
- 构建计划端点：/plan，Authorization: Bearer <SYNC_KEY>。

不订阅 page.content_updated。私密 Webhook 地址只保存在私人 Notion 管理页或按钮配置。
发布错误查看 Pages 构建日志。下线不清除旧部署或互联网缓存。

## 开发

Node.js 22.19 或更新维护版本。

```sh
npm ci
npm test
npm run build
npm run dev
```

本地无 Notion 密钥时使用已提交快照。
NOTION_CLI_SCRIPT 可指向已登录 ntn 入口，在本地显式全量同步；CLI 凭据不部署到云端。
配置 NOTION_TOKEN 和 SYNC_KEY 时执行云端同样的增量流程。
Pages 构建命令 npm run build，输出 dist，分支 main。
Worker 根目录 workers/notion-webhook，部署命令 npx wrangler deploy。
当前主题样式位于 `src/themes/quiet-publication/styles/`。
