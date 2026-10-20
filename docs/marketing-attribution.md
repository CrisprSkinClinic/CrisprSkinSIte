# Website booking-source attribution

This companion to receptionist **PR #26** carries a finite source label and optional numeric campaign ID into the appointment database when a phone-verified booking succeeds. The app then reports booking source, attendance and period acquisition-cost ratios internally.

This PR is stacked on website **PR #16**, which uses the shared atomic booking engine. Deploy the source-aware wrapper migration and receptionist changes before deploying this website branch. After #16 merges, retarget this PR to main and verify its diff.

The installed Supabase migration is `20261020082815_marketing_booking_attribution`. Website booking uses `service_marketing_public_book_v1`, which commits the existing atomic booking engine result and its source metadata together. No service key is exposed to browsers. Existing OTP checks, availability checks and one-booking-per-day rules remain in place. A reschedule keeps the source of the original booking.

`public/marketing-attribution.js` captures supported URL tags and selected referrer domains, keeping only channel, numeric campaign ID, evidence and timestamp in same-tab sessionStorage, expiring after 30 days. It preserves the source during internal navigation, including Astro ViewTransitions. Storage failures do not stop booking. It never retains patient data, raw URLs/UTM text, search terms or raw click IDs in that source record.

Supported channels: Google Ads, Google Business Profile, unpaid Google Search, Meta Ads, unpaid Instagram, Practo, referral, direct and unknown. Automatic classification uses only the supported tags/referrers; arbitrary URL text is ignored. Link/referrer data is indicative, not a verified advertising conversion. A website visit without a supported tag/referrer remains unknown. This script does not propagate source to the separate portal, registration approval or phone conversations.

Use a source-labelled Business Profile website link such as:

`https://crisprdermatology.com/book/?utm_source=google_business&utm_medium=organic`

For Google Ads, retain auto-tagging and use numeric `campaign_id={campaignid}` in Google's URL settings. The raw gclid/gbraid/wbraid is not retained by the first-party source record or clinic table. For Meta, use `utm_source=meta_ads&utm_medium=paid_social&campaign_id={{campaign.id}}`. Do not put patient names, contacts or treatment names in campaign IDs. Google's own tag behavior is separate from the first-party source record.

Booking events use fixed names only: started, verified, completed, failed and rescheduled. Treatment/service names, doctor IDs and raw error messages were removed from the existing GA4 event payloads. Start fires on the first booking-form focus; number verification fires after OTP verification; completion fires after server success. Rescheduling has its own event. No patient/appointment IDs are sent to Analytics. Google Signals and ad-personalization signals are disabled in the shared GA4 configs; the site's consent and account settings still require release review.

The receptionist report reads GA4 sessions with each booking event independently. These are not a sequential patient-level funnel and cannot be directly equated with clinic bookings, which also include offline routes. No attendance, revenue, customer list, enhanced conversion or medical-service purchase is uploaded to Google/Meta.

Validation: `npm run test:marketing` tests URL classification, PII rejection, expiry/storage failure, ViewTransitions preservation, event payload safety and the verified booking handler's use of the source-aware atomic RPC. Function syntax and Astro client-script syntax are checked locally. Full Astro production build and live Google/browser publication remain release checks.
