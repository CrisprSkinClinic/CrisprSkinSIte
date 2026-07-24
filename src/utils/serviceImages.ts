import type { ImageMetadata } from 'astro';

// Eagerly import every service image so Astro can optimize them at build time
const modules = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/services/*.{jpg,jpeg,png,webp}',
  { eager: true }
);

const imageMap: Record<string, ImageMetadata> = {};

for (const [path, mod] of Object.entries(modules)) {
  // path looks like: /src/assets/services/acne.jpg
  const filename = path.split('/').pop() ?? '';
  const slug = filename.replace(/\.(jpe?g|png|webp)$/i, '');
  imageMap[slug] = mod.default;
}

export function getServiceImage(slug?: string | null): ImageMetadata | undefined {
  if (!slug) return undefined;
  return imageMap[slug];
}
