/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Navy palette for CRISPR Skin and Hair Clinic, replacing the
        // original Warm Luxury forest-green + gold scheme with a single
        // navy accent -- same "brand" shade numbers so every existing
        // rounded/shadowed component keeps working unchanged, just
        // recolored. Gold's old CTA/highlight role is now filled by the
        // lighter/darker ends of this same navy scale rather than a
        // second hue -- confirmed with the user: just navy, not navy +
        // a second accent.
        brand: {
          50: '#EEF0F6',
          100: '#DBE0ED',
          200: '#B3BFDA',
          300: '#8698C2',
          400: '#5A70A5',
          500: '#334B7D',
          600: '#2A3D68',
          700: '#223154', // primary -- Deep Navy
          800: '#1A2540',
          900: '#12131A',
          950: '#0B0C10',
        },
        // Champagne Beige -- secondary surfaces, subtle backgrounds
        // (kept as a warm neutral pairing; not a color the user flagged)
        champagne: {
          50: '#FDFCFA',
          100: '#F7F2EB',
          200: '#E9DDCF',
          300: '#DBC9B3',
          400: '#CCB496',
        },
        // Warm White -- page background
        warmwhite: '#FAF8F5',
        // Charcoal -- body text
        charcoal: '#2F2F2F',
        // Gold role retired -- CTAs/highlights now use `brand` shades
        // directly (e.g. brand-500/600 for buttons that were gold-500/600).
        // Kept as an alias pointing at navy so any missed gold-* class in
        // a file we haven't touched yet still resolves to navy instead of
        // silently rendering unstyled.
        gold: {
          50: '#EEF0F6',
          100: '#DBE0ED',
          300: '#8698C2',
          400: '#5A70A5',
          500: '#334B7D',
          600: '#2A3D68',
          700: '#223154',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
