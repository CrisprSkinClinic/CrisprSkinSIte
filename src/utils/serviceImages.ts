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

export const serviceImageAlts: Record<string, string> = {
  'hair-transplant-fue': 'FUE hair transplant procedure by dermatologist in KK Nagar, Chennai',
  'hair-loss': 'Hair loss evaluation and treatment consultation',
  'female-hair-loss': 'Female pattern hair loss assessment by dermatologist',
  'alopecia-areata': 'Alopecia areata patchy hair loss on scalp',
  'acne': 'Acne treatment consultation with dermatologist',
  'acne-scars': 'Acne scar treatment and skin texture evaluation',
  'pigmentation': 'Pigmentation and dark spot treatment consultation',
  'melasma': 'Melasma facial pigmentation treatment',
  'psoriasis': 'Psoriasis skin patches during clinical evaluation',
  'vitiligo': 'Vitiligo depigmented skin patches',
  'eczema': 'Eczema and dry inflamed skin treatment',
  'atopic-dermatitis': 'Atopic dermatitis care for sensitive skin',
  'urticaria': 'Urticaria (hives) skin allergy evaluation',
  'skin-allergy': 'Skin allergy testing and treatment consultation',
  'fungal-infections': 'Fungal skin infection diagnosis and treatment',
  'viral-skin-infections': 'Viral skin infection evaluation by dermatologist',
  'dandruff': 'Dandruff and scalp condition treatment',
  'nail-disorders': 'Nail disorder examination and treatment',
  'warts-moles-skin-tags': 'Wart, mole, and skin tag removal consultation',
  'birthmarks': 'Birthmark evaluation in pediatric dermatology',
  'pediatric-dermatology': 'Pediatric dermatology consultation for children',
  'chemical-peels': 'Chemical peel treatment for skin rejuvenation',
  'laser-hair-reduction': 'Laser hair reduction treatment session',
  'botox': 'Botox consultation for facial anti-ageing',
  'fillers': 'Dermal filler treatment consultation',
  'anti-ageing': 'Anti-ageing dermatology treatment consultation',
  'skin-rejuvenation': 'Skin rejuvenation treatment at dermatology clinic',
};

export function getServiceImageAlt(
  slug?: string | null,
  fallback = 'Dermatology service at CRISPR Skin and Hair Clinic'
): string {
  if (!slug) return fallback;
  return serviceImageAlts[slug] ?? fallback;
}
