import managedSite from './data/site-config.json';

type ManagedSite = {
  name: string;
  title: string;
  description: string;
  avatar: null | { src: string; alt: string };
  author: { name: string; bio: string; email: string };
  social: Array<{ label: string; href: string }>;
  features: { theme: boolean; rss: boolean };
};

export const site = {
  ...(managedSite as ManagedSite),
  url: 'https://gamecrafter.fun',
} as const;
