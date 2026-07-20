/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // "Warm Luxury" brand palette for CRISPR Skin and Hair Clinic.
        // `brand` (deep forest green) replaces the eye-care site's `blue`
        // usage 1:1 -- same shade numbers (600/700/900 etc.) so existing
        // component classes like `blue-900` can be mechanically swapped
        // to `brand-900` without redesigning each component's contrast.
        brand: {
          50: '#EAF0EC',
          100: '#D2E0D7',
          200: '#A8C4B1',
          300: '#7EA88B',
          400: '#4E8064',
          500: '#345E48',
          600: '#2A5140',
          700: '#234B3A', // primary -- Deep Forest Green
          800: '#1C3C2E',
          900: '#152D23',
          950: '#0D1D16',
        },
        // Champagne Beige -- secondary surfaces, subtle backgrounds
        champagne: {
          50: '#FDFCFA',
          100: '#F7F2EB',
          200: '#E9DDCF', // secondary
          300: '#DBC9B3',
          400: '#CCB496',
        },
        // Warm White -- page background (replaces slate-50)
        warmwhite: '#FAF8F5',
        // Charcoal -- body text (replaces slate-800/900 for text)
        charcoal: '#2F2F2F',
        // Soft Gold -- accents, CTAs, highlights, hover states
        gold: {
          50: '#FAF6EC',
          100: '#F1E7CC',
          300: '#D4BE8C',
          400: '#C4AC77',
          500: '#B89B5E', // accent -- Soft Gold
          600: '#A08549',
          700: '#856D3B',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
