import { getCollection } from "astro:content";
import rss from "@astrojs/rss";
import { site } from "../site.config";
export async function GET(context) {
  const posts = (await getCollection("blog", ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );
  return rss({
    title: site.title,
    description: site.description,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: post.data.modulePath + "/" + post.id + "/",
    })),
    customData: "<language>zh-cn</language>",
  });
}
