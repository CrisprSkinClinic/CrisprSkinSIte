// netlify/functions/lib/clinic.cjs
//
// The only booking setting that differs between the CRISPR Skin and Crispr Eye Care
// websites; every other file under netlify/functions is kept identical on both.
//
// CRISPR Skin and Hair Clinic's dermatologists, the doctors open to online booking.
// The AppointmentManager database is shared with Crispr Eye Care, so every patient-history
// lookup, the per-day limits and Manage My Appointment only look at these doctors.
module.exports = {
  CLINIC_DOCTOR_IDS: [
    "514ff136-ee45-4d49-89b5-d128d96aef62", // Karthik L
    "d5372165-fc7e-47e8-aee6-ce02e7fefc71", // Narayanan A
    "519dbd89-d3d9-4ee9-8923-5fabbe51cf2e", // Narayanan B
  ],
};
