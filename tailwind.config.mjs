/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // CRISPR logo palette: clear violet, orchid, magenta and pink.
        // Deep values stay violet (not wine/plum) for accessible text.
        brand: {
          50: '#FAF5FF',
          100: '#F3E8FF',
          200: '#E9D5FF',
          300: '#D8B4FE',
          400: '#C084FC',
          500: '#A855F7',
          600: '#9333EA',
          700: '#7E22CE',
          800: '#6B21A8',
          900: '#4C1D95',
          950: '#2E1065',
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
        warmwhite: '#FFFCFD',
        // Charcoal -- body text
        charcoal: '#2F2F2F',
        // Gold role retired -- CTAs/highlights now use `brand` shades
        // directly (e.g. brand-500/600 for buttons that were gold-500/600).
        // Kept as an alias pointing at navy so any missed gold-* class in
        // a file we haven't touched yet still resolves to navy instead of
        // silently rendering unstyled.
        gold: {
          50: '#FDF2F8',
          100: '#FCE7F3',
          300: '#F9A8D4',
          400: '#F472B6',
          500: '#EC4899',
          600: '#DB2777',
          700: '#BE185D',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
