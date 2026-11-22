/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // CRISPR logo palette: clear violet, orchid, magenta and pink.
        // Deep values stay violet (not wine/plum) for accessible text.
        brand: {
          50: '#FBF8FC',
          100: '#F3ECF5',
          200: '#E4D5E8',
          300: '#CEB5D5',
          400: '#AE89B8',
          500: '#93639F',
          600: '#7E4D8B',
          700: '#673C72',
          800: '#503057',
          900: '#38223D',
          950: '#241628',
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
          50: '#FFF8FB',
          100: '#FCECF3',
          300: '#E9B7CF',
          400: '#D990B3',
          500: '#C36F9A',
          600: '#A9557E',
          700: '#8A4266',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
