import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import remarkFaqGroups from './src/utils/remark-faq-groups.mjs';

const SITE = 'https://crisprdermatology.com';

// Pages that must not be offered to search engines: ad landing pages, transactional/utility pages and the 404.
const NOT_FOR_SEARCH = /\/(lp|register|manage-appointment|success|404)(\/|$)/;

// Last-modified dates for the sitemap: blog posts carry a publication date in their front matter. Other pages
// have no reliable date, so they are left without one rather than given an inaccurate build date.
const blogDates = new Map();
try {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src/content/blog');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const m = fs.readFileSync(path.join(dir, file), 'utf8').match(/^pubDate:\s*"?([0-9-]+)/m);
    if (m) blogDates.set(`${SITE}/blog/${file.replace(/\.md$/, '')}/`, new Date(m[1]).toISOString());
  }
} catch { /* the sitemap still builds without dates */ }

// Internal links are written without a trailing slash (e.g. /services/acne) but every page lives at
// /services/acne/. Rewriting them in the built HTML saves visitors and crawlers a 301 on every click.
function trailingSlashLinks() {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.html') ? [path.join(dir, e.name)] : []);
  return {
    name: 'trailing-slash-links',
    hooks: {
      'astro:build:done': ({ dir }) => {
        for (const file of walk(fileURLToPath(dir))) {
          const html = fs.readFileSync(file, 'utf8');
          const out = html.replace(/(\bhref=")(\/[^"#?]*)([#?][^"]*)?"/g, (match, attr, pth, rest = '') => {
            if (pth.endsWith('/') || pth.startsWith('//') || /\.[a-z0-9]+$/i.test(pth) || /^\/(\.netlify|_astro)\//.test(pth)) return match;
            return `${attr}${pth}/${rest}"`;
          });
          if (out !== html) fs.writeFileSync(file, out);
        }
      },
    },
  };
}

export default defineConfig({
  site: SITE,
  trailingSlash: 'always',
  markdown: { remarkPlugins: [remarkFaqGroups] },
  prefetch: true,
  integrations: [
    tailwind(),
    sitemap({
      filter: (page) => !NOT_FOR_SEARCH.test(page),
      serialize: (item) => {
        const lastmod = blogDates.get(item.url);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
    trailingSlashLinks(),
  ],
});
