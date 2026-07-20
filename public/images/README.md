# Image Assets

This folder is currently empty except for placeholders referenced in code.
Every component that displays a photo falls back to a generated placeholder
(via placehold.co) until a real file is added at the expected path, so the
site builds and looks reasonable before photography is ready.

## Expected paths

- `public/images/hero-doctor.jpg` — homepage/landing page hero photo
- `public/images/services/<slug>.jpg` — one photo per service page, where
  `<slug>` matches the service's `heroImage` frontmatter field
  (e.g. `hair-transplant-fue.jpg`, `acne.jpg`)
- `public/images/doctors/<doctor-slug>.jpg` — one headshot per doctor,
  matching the `slug` field in `src/config/site.js` → `doctors[]`
  (e.g. `dr-karthik-l.jpg`, `dr-narayanan-a.jpg`, `dr-narayanan-b.jpg`)
- `public/images/clinic/*.jpg` — clinic interior photos for the gallery
  section on the homepage (see `src/components/ClinicGallery.astro`
  for the exact filenames expected)
- `public/logo.png` — site logo, if/when a wordmark or icon is added
  beyond the current text-based logo in the navbar

## Adding real photos

Once photography exists, drop files at the paths above with matching
filenames — no code changes needed, the placeholder fallbacks are
automatically bypassed. For better performance, consider switching the
affected components from plain `<img>` back to Astro's optimized
`<Image>` (`astro:assets`) at that point — see the comments in
`ServiceCard.astro`, `ClinicGallery.astro`, and
`services/[slug].astro` for exactly where.
