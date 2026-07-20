/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // "Medically Authentic" palette for CRISPR Skin and Hair Clinic.
        // Deep Plum accent ties back to the clinic's existing logo, kept
        // to ONE accent color -- executed flat (hairline borders, no
        // shadows, no soft rounded corners) rather than the soft/rounded
        // "beauty clinic" treatment the same plum is often paired with.
        // The user was explicit: authentic and medical, not a spa.
        // `brand` keeps its name so existing component classes
        // (brand-600, brand-900, etc.) resolve unchanged.
        brand: {
          50: '#F3F0F6',
          100: '#E4DCEB',
          200: '#C7B4D6',
          300: '#A587BD',
          400: '#8768A3',
          500: '#6B4A8F', // primary accent -- Deep Plum
          600: '#5A3D78',
          700: '#4A3263',
          800: '#3A274E',
          900: '#1A1D1F', // near-black ink, cool undertone -- doubles as darkest brand shade
          950: '#0F1112',
        },
        // Warm paper -- neutral section-alternation background.
        paper: {
          DEFAULT: '#F5F4F1',
          50: '#FAF9F7',
          100: '#F5F4F1',
          200: '#EAE7E2',
        },
        // Warm grey -- secondary text, hairline borders, quiet UI.
        stone: {
          400: '#A6A199',
          500: '#8A8578',
          600: '#6B675D',
        },
        ink: '#1A1D1F', // primary text color -- cool near-black, not warm charcoal
      },
      fontFamily: {
        // Display: a real serif with character, used only for headlines
        // -- not the same grotesk as the body. Fraunces is distinctive,
        // has a soft/warm optical feel appropriate to skin & hair care,
        // and is not the generic "premium serif" default (Playfair).
        display: ['"Fraunces"', 'ui-serif', 'Georgia', 'serif'],
        // Body/UI: a clean, slightly narrow grotesk for readability and
        // a calm clinical tone.
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
