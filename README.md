# Craft4Fun 博客

基于 Astro 官方博客模板，使用静态生成，部署至 Cloudflare Pages。

## 本地运行

需要 Node.js 22.18.0 或兼容版本。

```sh
npm ci
npm run dev
npm run build
npm run preview
```

## 写文章

在 `src/content/blog/` 新建 `文章英文短名.md`：

```md
---
title: "文章标题"
description: "一句话摘要"
pubDate: "2026-09-09"
tags: ["随笔"]
draft: false
---

正文使用 Markdown。
```

文件名对应地址 `/blog/文章英文短名/`。支持 Markdown / MDX。
设置 `draft: true` 后不会生成公开页面，也不会出现在首页、归档、RSS 或 sitemap 中。
图片可以放在 `public/images/`，用 `![说明](/images/图片名.jpg)` 引用。
可选 `updatedDate` 记录更新时间。修改站点名及简介请编辑 `src/consts.ts`。

## Cloudflare Pages

- GitHub 仓库：cc4share/gamecrafter-blog
- 生产分支：main
- 框架：Astro
- 构建命令：npm run build
- 构建输出目录：dist
- Node.js：22.18.0
- 正式域名：https://gamecrafter.fun

连接 Git 后，推送 main 自动发布，PR 可生成预览部署。域名更改时同步修改 `astro.config.mjs` 与 `public/robots.txt`。
无 SSR、数据库、密钥或付费服务依赖。RSS 位于 /rss.xml，站点地图位于 /sitemap-index.xml。

## 内容与隐私

站点带一篇开站说明及关于页。未启用广告、评论或统计。
未设置 ads.txt：没有广告账户或发布商 ID 时无需填写虚假信息。
