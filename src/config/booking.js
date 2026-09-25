// Site-specific settings for BookingCalendar.astro. The component itself is kept identical
// on the CRISPR Skin and Crispr Eye Care websites; only this file differs.
import { siteConfig } from './site.js';

const address = siteConfig.contact.address;
const addressLine = [address.street, address.locality, address.city, address.postalCode].filter(Boolean).join(', ');

export const bookingConfig = {
  clinicName: siteConfig.name,
  clinicPhone: siteConfig.contact.phone,
  addressLine,
  mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${siteConfig.name}, ${addressLine}`)}`,
  // Doctors open to online booking; must match netlify/functions/lib/clinic.cjs.
  doctors: siteConfig.doctors.map((doctor) => ({ id: doctor.dbId, name: doctor.name })),
  services: [
    { group: null, items: [['General Consultation', 'General Dermatology Consultation']] },
    { group: 'Hair', items: [['Hair Transplant (FUE)'], ['Hair Loss'], ['Female Hair Loss'], ['Alopecia Areata'], ['Dandruff']] },
    { group: 'Skin', items: [['Acne'], ['Acne Scars'], ['Pigmentation'], ['Melasma'], ['Vitiligo'], ['Psoriasis'], ['Eczema'], ['Urticaria'], ['Skin Allergy'], ['Fungal Infections'], ['Warts, Moles & Skin Tags'], ['Nail Disorders']] },
    { group: 'Cosmetic', items: [['Chemical Peels'], ['Botox'], ['Fillers'], ['Laser Hair Reduction'], ['Anti-ageing'], ['Skin Rejuvenation']] },
    { group: 'Pediatric', items: [['Pediatric Dermatology'], ['Birthmarks'], ['Atopic Dermatitis'], ['Viral Skin Infections']] },
  ],
  defaultService: 'General Consultation',
};
