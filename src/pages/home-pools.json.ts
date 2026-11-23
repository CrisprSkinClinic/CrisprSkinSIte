// Pools of content the home page draws from at random on every visit, so that every service, condition,
// article and question gets its turn instead of the same few being featured. Built once at build time and
// fetched by the browser after the page loads (the page itself ships a default selection for crawlers).
import { getCollection } from 'astro:content';
import { getImage } from 'astro:assets';
import { getServiceImage } from '../utils/serviceImages';

const clean = (s: string) =>
  String(s || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

async function thumb(meta: any, width: number, height: number) {
  if (!meta) return null;
  const img = await getImage({ src: meta, width, height, format: 'webp', quality: 72 });
  return img.src;
}

export async function GET() {
  const services = await getCollection('services');
  const conditions = await getCollection('conditions');
  const posts = await getCollection('blog');
  const faqs = await getCollection('faqs');

  const serviceHero: Record<string, string | undefined> = Object.fromEntries(
    services.map((s) => [s.slug, s.data.heroImage])
  );
  const imgCache = new Map<string, string | null>();
  const cached = async (key: string | undefined, w: number, h: number) => {
    if (!key) return null;
    const k = `${key}:${w}x${h}`;
    if (!imgCache.has(k)) imgCache.set(k, await thumb(getServiceImage(key), w, h));
    return imgCache.get(k) ?? null;
  };

  const pool = {
    services: await Promise.all(
      services.map(async (s) => ({
        t: s.data.heroHeadline,
        d: clean(s.data.heroSubheadline),
        u: `/services/${s.slug}`,
        i: await cached(s.data.heroImage, 500, 375),
      }))
    ),
    conditions: conditions.map((c) => ({
      t: c.data.title,
      d: clean(c.data.heroSubheadline),
      u: `/conditions/${c.slug}`,
    })),
    posts: await Promise.all(
      posts.map(async (p) => ({
        t: p.data.title,
        d: clean(p.data.description),
        u: `/blog/${p.slug}`,
        date: new Date(p.data.pubDate).toISOString(),
        m: Math.max(1, Math.round(p.body.split(/\s+/).length / 210)),
        g: p.data.tags?.[0] || '',
        i: await cached(p.data.service ? serviceHero[p.data.service] : undefined, 480, 270),
      }))
    ),
    faqs: faqs.map((f) => ({ q: f.data.question, a: clean(f.body) })),
  };

  return new Response(JSON.stringify(pool), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
