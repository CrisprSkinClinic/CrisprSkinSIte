/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // CRISPR's plum-and-orchid identity, tuned for accessible text,
        // quiet editorial surfaces, and high-contrast clinical CTAs.
        brand: {
          50: '#FCF5FA',
          100: '#F8E7F4',
          200: '#F0CFE8',
          300: '#E4A8D7',
          400: '#D578C0',
          500: '#B94DA5',
          600: '#963A88',
          700: '#742A6B',
          800: '#561D50',
          900: '#351231',
          950: '#210A1E',
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
          50: '#FFF4F8',
          100: '#FFE3EF',
          300: '#F6A7C8',
          400: '#EE7EAE',
          500: '#E54D92',
          600: '#CA3277',
          700: '#A82461',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
