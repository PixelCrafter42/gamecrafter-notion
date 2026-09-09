import { defineCollection } from "astro:content";
import { file } from "astro/loaders";
import { z } from "astro/zod";

const blog = defineCollection({
  loader: file("src/data/notion-posts.json"),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      html: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      heroImage: image().optional(),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    }),
});

export const collections = { blog };
