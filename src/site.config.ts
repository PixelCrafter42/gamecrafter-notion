import managedSite from './data/site-config.json';

type ManagedSite = {
  name: string;
  title: string;
  description: string;
  avatar: null | { src: string; alt: string };
  author: { name: string; bio: string; email: string };
  social: Array<{ label: string; href: string }>;
  navigation: { home: string; writing: string; projects: string; about: string };
  pages: {
    home: { writingTitle: string; aboutTitle: string; aboutDescription: string };
    writing: { eyebrow: string; title: string };
    projects: { eyebrow: string; title: string; description: string };
    about: { eyebrow: string; title: string; description: string; html: string };
  };
  features: { theme: boolean; rss: boolean; projects: boolean; about: boolean };
};

export const site = {
  ...(managedSite as ManagedSite),
  url: 'https://gamecrafter.fun',
} as const;
