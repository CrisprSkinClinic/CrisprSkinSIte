# CRISPR Skin and Hair Clinic — Website

Astro 4 + Tailwind + Netlify site for CRISPR Skin and Hair Clinic, KK Nagar, Chennai.

Forked from the architecture of an existing clinic site (same stack, component
patterns, and Supabase-backed booking system), rebuilt entirely for
dermatology: content, branding, color palette, and service taxonomy are all
specific to this clinic.

## Stack

- **Astro 4** (static site generation) + **Tailwind CSS**
- **Content collections** (`src/content/`) for services, conditions, FAQs,
  blog posts, and paid-ad landing pages — all Markdown/JSON, no external CMS
  required (though a Decap-style admin UI is scaffolded at `/staff-admin`)
- **Supabase** — booking system (appointments, doctor schedules, blocked
  slots) via Netlify Functions in `netlify/functions/`
- **Netlify** — hosting, serverless functions, form handling

## Getting started

```bash
npm install
npm run dev       # local dev server
npm run build     # production build to dist/
npm run check     # Astro type checking
```

## Environment variables

Set these in Netlify (Site settings → Environment variables) — not committed:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or equivalent — check
  `netlify/functions/*.js` for exact variable names in use)
- A new GA4 measurement ID (search the codebase for `G-GR0G04EY1M` — that
  placeholder is inherited and must be replaced with this clinic's own
  property before launch)

## Content structure

- `src/config/site.js` — single source of truth for clinic name, doctors,
  address, contact info, and hours. Change once here, it propagates
  everywhere (nav, footer, JSON-LD, meta tags).
- `src/content/services/*.md` — one file per service, grouped by `category`
  (hair / skin / cosmetic / pediatric) which drives the Services mega-menu
- `src/content/conditions/*.md`, `src/content/faqs/*.md`,
  `src/content/blog/*.md`, `src/content/landingPages/*.json` — supporting
  content collections, cross-linked from service pages

## Images

No clinic photography exists yet. Every image-bearing component falls back
to a generated placeholder until real files are added — see
`public/images/README.md` for exact expected paths and filenames.

## Google Ads compliance note

PRP and GFC (regenerative/platelet-rich-plasma) treatments are deliberately
**not mentioned anywhere** on this site — PRP is explicitly prohibited under
Google Ads' speculative-treatment policy, and GFC was excluded as a
precaution. Do not reintroduce these without checking current Ads policy.

## Status

Actively under construction. Hair category services complete; Skin, Cosmetic,
and Pediatric categories, plus conditions/FAQs/blog/landing-page content, are
still in progress.
