import { defineCollection, z } from 'astro:content';

const faqCollection = defineCollection({
  type: 'content',
  schema: z.object({
    question: z.string(),
    order: z.number().optional(),
    // Optional tags for browsing/discovery when picking faqIds for a
    // page (e.g. "retina", "cataract", "diabetic-eye"). Pages reference
    // FAQs by explicit ID, not by auto-filtering on tags -- this keeps
    // selection predictable and avoids the generic-answer problem we
    // hit before with tag-based filtering on landing pages.
    tags: z.array(z.string()).optional().default([]),
  }),
});

const blogCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    description: z.string(),
    author: z.string().optional(),
    tags: z.array(z.string()).optional(),
    image: z.string().optional(),

    // Optional links into the conditions/services collections.
    // Per governance rules, every article should eventually declare
    // both -- optional for now so the 13 existing posts validate
    // without changes, but new articles should set these going forward.
    condition: z.string().optional(),
    service: z.string().optional(),
  }),
});

// Curated patient testimonials, shown on Testimonials.astro. Content
// lives here (not hardcoded in the component) specifically so staff can
// add/edit/remove them via /staff-admin without a code change or
// redeploy request -- see create-content.js's "testimonial" contentType.
const testimonialCollection = defineCollection({
  type: 'content',
  schema: z.object({
    // Patient name as it should display -- full name as written on
    // Google, or a shortened form, per whatever the staff member enters.
    name: z.string(),
    rating: z.number().min(1).max(5).default(5),
    // Optional: which doctor this testimonial is attributed to, for
    // internal reference/filtering. Not required -- some reviews (e.g.
    // ones that don't name a specific doctor) can omit this.
    doctorSlug: z.string().optional(),
    doctorName: z.string().optional(),
    // Whether this testimonial is currently shown on the site. Lets
    // staff deactivate one without deleting it (e.g. to swap which 5-6
    // are featured) rather than losing the content entirely.
    active: z.boolean().default(true),
    order: z.number().optional(),
  }),
});

// Ad / Google Ads landing pages -- one entry per campaign/ad group.
const landingPageCollection = defineCollection({
  type: 'data',
  schema: z.object({
    headline: z.string(),
    subheadline: z.string(),
    urgent: z.boolean().optional().default(false),
    metaDescription: z.string(),

    // Page-specific differentiators, appended to the 3 universal cards
    whyPatientsChoose: z.array(z.object({
      title: z.string(),
      description: z.string(),
    })).optional().default([]),

    showSymptomCheck: z.boolean().optional().default(false),
    symptoms: z.array(z.string()).optional(),

    processSteps: z.array(z.object({
      title: z.string(),
      description: z.string(),
    })).optional(),

// Page-specific objection-handling FAQs, written directly per page
    // rather than filtered from the global faqs collection. Each page's
    // booking objections are genuinely different (Cataract vs. LASIK
    // vs. Diabetic Eye) -- keyword filtering produced generic,
    // educational answers, not objection-handling ones. Exactly 3 per
    // page: condition-specific objection, urgency, trust.
    landingFaqs: z.array(z.object({
      question: z.string(),
      answer: z.string(),
    })).optional(),

    // Optional supplement to landingFaqs: explicit IDs into the central
    // faqs collection, for pages that want to ALSO surface a few shared
    // general-education FAQs below their inline objection-handling set.
    // Additive only -- landingFaqs remains the primary, frozen
    // objection-handling content and is never replaced by this.
    baseFaqIds: z.array(z.string()).optional(),

    // Optional single understated link to a deeper content-cluster
    // page (service or condition), for ad visitors who want to learn
    // more before booking. Rendered as a single subtle text line at
    // the very end of the page, after ClinicPhotoStrip and before
    // BookingSection -- never competing visually with MidPageCTA or
    // the booking flow itself. Omitted entirely if not set.
    learnMoreLink: z.object({
      text: z.string(),
      url: z.string(),
    }).optional(),

        // Pre-selects a service in the booking form's dropdown, matching
    // this page's topic, so a visitor doesn't have to re-select
    // something the landing page already told them about. Must match
    // one of the literal <option value="..."> strings in
    // BookingCalendar.astro's service dropdown exactly, or it's
    // silently ignored (falls back to the unselected placeholder).
    defaultService: z.string().optional(),

    // Pre-selects a doctor in the booking form's dropdown, for services
    // with an obvious single-doctor match (e.g. pediatric-dermatology ->
    // Narayanan A). Must match one of siteConfig.doctors[].dbId exactly.
    // Left unset for services without a natural single-doctor fit, so the
    // patient picks -- this deliberately does NOT default to any one
    // doctor when omitted (see the doctor-neutrality fix elsewhere in
    // this codebase).
    defaultDoctorId: z.string().optional(),

    // Renders ServicesOverviewGrid (full 8-service grid, reusing
    // ServiceCard) in place of a single psychology-specific block, for
    // broad/local-intent pages (e.g. "Eye Clinic KK Nagar") that have
    // no single condition to anchor causeExploration/decisionSupport/
    // educationalInsight around.
    showServicesGrid: z.boolean().optional().default(false),

    // Renders LocalAreaSection (named landmarks + neighbourhood list)
    // right after ConvenienceSection, for hyper-local pages only.
    showLocalArea: z.boolean().optional().default(false),
    
    // Condition-specific "what could be causing this" content.
    // Only populated on symptom-intent pages where the cause is
    // genuinely ambiguous (e.g. blurred vision, eye pain) -- not
    // service-intent pages where the diagnosis is already known.
    causeExploration: z.object({
      title: z.string(),
      causesIntro: z.string(),
      commonCauses: z.array(z.string()),
      causesOutro: z.string().optional(),
      urgentTitle: z.string(),
      urgentIntro: z.string(),
      urgentScenarios: z.array(z.string()),
    }).optional(),

    // Personal, first-person framing from one of the clinic's doctors --
    // the one thing a corporate hospital chain cannot replicate at scale.
    // doctorSlug identifies which of the clinic's doctors is speaking
    // (matches siteConfig.doctors[].slug) so the quote is explicitly
    // attributed per page rather than defaulting to any single doctor
    // across the whole site.
    doctorsPerspective: z.string().optional(),
    doctorsPerspectiveDoctorSlug: z.string().optional(),

    // Decision-support: "what happens after evaluation" pathways,
    // mapped by possible finding -> next step. Replaces vague
    // reassurance with a concrete sense of what to expect.
    afterEvaluation: z.array(z.object({
      finding: z.string(),
      nextStep: z.string(),
    })).optional(),

    // Reusable across any "patient feels fine, doesn't realize they
    // need screening" page (Diabetic Eye, future Glaucoma, future
    // Retina). One configurable component instead of forking a new
    // one per condition -- keeps this maintainable past 11 pages.
    educationalInsight: z.object({
      title: z.string(),
      body: z.string(),
      pathway: z.object({
        steps: z.array(z.string()),
        branches: z.array(z.object({
          finding: z.string(),
          outcome: z.string(),
        })).optional(),
      }).optional(),
      prioritizeIf: z.array(z.string()).optional(),
    }).optional(),

    // Standardized structure for doctorsPerspective, replacing the
    // free-form string for NEW pages going forward. Keeps a consistent
    // "patient concern -> doctor response" shape across pages while
    // content stays page-specific. doctorSlug identifies which of the
    // clinic's doctors is speaking (matches siteConfig.doctors[].slug).
    doctorsPerspectiveStructured: z.object({
      patientConcern: z.string(),
      response: z.string(),
      doctorSlug: z.string().optional(),
    }).optional(),

    // Surgical decision-support, distinct from CauseExploration and
    // educationalInsight. Used on LASIK/Cataract -- the patient already
    // knows the condition; the anxiety is whether/when to proceed.
    decisionSupport: z.object({
      suitabilityTitle: z.string(),
      suitabilityIntro: z.string(),
      evaluationSteps: z.array(z.string()),
      notSuitableTitle: z.string().optional(),
      notSuitableReasons: z.array(z.string()).optional(),
      lensOptions: z.array(z.object({
        name: z.string(),
        benefit: z.string(),
      })).optional(),
    }).optional(),
  }),
});

// Service pages (e.g. Retina Care). Deliberately minimal -- no
// governance/taxonomy fields (author, reviewer, reviewDate) yet.
// Mixed-audience pages (screening-driven AND symptom-driven readers)
// use the twoPaths field to branch early rather than forcing one
// generic narrative on both reader types.
const serviceCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    metaDescription: z.string(),
    heroEyebrow: z.string().optional(),
    heroHeadline: z.string(),
    heroSubheadline: z.string(),
    heroImage: z.string().optional(),

    // Top-level grouping used to drive the Services mega-menu and the
    // 4 category landing pages (/hair, /skin, /cosmetic, /pediatric).
    category: z.enum(['hair', 'skin', 'cosmetic', 'pediatric']),

    // Early branch for mixed-audience service pages: lets a reader
    // self-identify (screening vs. symptoms) before the page commits
    // to one narrative. Optional -- single-psychology service pages
    // (a future Cataract rebuild, say) can skip this.
    twoPaths: z.object({
      screeningTitle: z.string(),
      screeningBody: z.string(),
      symptomsTitle: z.string(),
      symptomsBody: z.string(),
    }).optional(),

    diagnostics: z.array(z.string()).optional(),

    // Conditions this service manages -- slugs referencing the
    // conditions collection, used to render links automatically.
    conditionsManaged: z.array(z.string()).optional(),

    treatments: z.array(z.object({
      name: z.string(),
      description: z.string(),
    })).optional(),

    // FAQs for this page, referenced by explicit ID from the central
    // faqs collection (src/content/faqs/). Replaces the earlier inline
    // pageFaqs array -- consolidating into a shared, reusable repo
    // rather than duplicating near-identical questions across pages.
    faqIds: z.array(z.string()).optional(),

    ctaTitle: z.string().optional(),

    // Value matching one of BookingCalendar.astro's <option value="...">
    // strings exactly, used to pre-select this service in the embedded
    // booking form at the bottom of the page.
    defaultService: z.string().optional(),
  }),
});

// Condition pages (e.g. Diabetic Retinopathy). Same minimal-schema
// philosophy as serviceCollection. twoPaths lets a condition page
// branch for readers who arrive screening-driven vs. already
// noticing symptoms, before merging into shared content.
const conditionCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    metaDescription: z.string(),
    heroEyebrow: z.string().optional(),
    heroHeadline: z.string(),
    heroSubheadline: z.string(),

    parentService: z.string(), // slug into the services collection

    twoPaths: z.object({
      screeningTitle: z.string(),
      screeningBody: z.string(),
      symptomsTitle: z.string(),
      symptomsBody: z.string(),
    }).optional(),

    riskFactors: z.array(z.string()).optional(),
    symptoms: z.array(z.string()).optional(),

    treatmentOverview: z.array(z.object({
      name: z.string(),
      description: z.string(),
    })).optional(),

    urgentCareTitle: z.string().optional(),
    urgentCareBody: z.string().optional(),
    urgentScenarios: z.array(z.string()).optional(),

    // FAQs for this page, referenced by explicit ID from the central
    // faqs collection (src/content/faqs/). Replaces the earlier inline
    // pageFaqs array.
    faqIds: z.array(z.string()).optional(),

    // Other condition slugs to cross-link (e.g. Diabetic Retinopathy
    // <-> Macular Degeneration, both under Retina Care).
    relatedConditions: z.array(z.string()).optional(),

    ctaTitle: z.string().optional(),
  }),
});

export const collections = {
  'faqs': faqCollection,
  'blog': blogCollection,
  'landingPages': landingPageCollection,
  'services': serviceCollection,
  'conditions': conditionCollection,
  'testimonials': testimonialCollection,
};
