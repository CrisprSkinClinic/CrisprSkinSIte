export const siteConfig = {
  name: "CRISPR Skin and Hair Clinic",

  // ✅ Use final domain (IMPORTANT)
  url: "https://crisprdermatology.com",

  description: "Leading skin, hair & aesthetic dermatology clinic in KK Nagar, Chennai. AIIMS-trained dermatologists offering hair transplant, acne, psoriasis, vitiligo, pediatric dermatology and cosmetic treatments with evidence-based care.",

  // Primary/lead doctor -- used by shared landing-page components (DoctorSection,
  // DoctorsPerspective, LandingHero) and the single-physician JSON-LD block in
  // MainLayout, which only support one doctor at a time.
  doctor: {
    name: "Dr. Karthik L",
    specialization: "Consultant Dermatologist, Dermatosurgeon & Hair Transplant Surgeon"
  },

  // Full clinical team -- used on the team/about page and individual bio pages.
  doctors: [
    {
      slug: "dr-karthik-l",
      name: "Dr. Karthik L",
      designation: "Consultant Dermatologist, Dermatosurgeon & Hair Transplant Surgeon",
      qualifications: "MBBS, MD (Dermatology) - AIIMS New Delhi, DNB (Dermatology), MRCP (SCE), UK",
      qualificationsShort: "MD (AIIMS), DNB, MRCP (SCE)",
      expertise: [
        "Hair transplantation (FUE)",
        "Hair loss disorders",
        "Acne & acne scars",
        "Pigmentary disorders (Melasma)",
        "Psoriasis",
        "Vitiligo",
        "Urticaria",
        "Dermatosurgery",
        "Clinical dermatology",
        "Cosmetic dermatology"
      ],
      bio: "Dr. Karthik L completed his dermatology training at AIIMS, New Delhi, followed by advanced training at Atal Bihari Vajpayee Institute of Medical Sciences, New Delhi. He has expertise in both medical and surgical dermatology, with a special focus on hair restoration and dermatosurgery. His practice emphasizes evidence-based treatment plans, individualized patient care, and detailed counselling."
    },
    {
      slug: "dr-narayanan-a",
      name: "Dr. Narayanan A",
      designation: "Consultant Dermatologist & Paediatric Dermatologist",
      qualifications: "MBBS, MD (Dermatology) - AIIMS New Delhi, DNB (Dermatology), MNAMS, PDCC (Paediatric Dermatology) - JIPMER Puducherry, MRCP (SCE), UK",
      qualificationsShort: "MD (AIIMS), DNB, MNAMS, PDCC (JIPMER), MRCP (SCE)",
      expertise: [
        "Paediatric dermatology",
        "Eczema",
        "Atopic dermatitis",
        "Birthmarks",
        "Acne",
        "Hair disorders",
        "Skin allergies",
        "Chronic inflammatory skin diseases",
        "General dermatology"
      ],
      bio: "Dr. Narayanan A trained in Dermatology at AIIMS, New Delhi and completed a superspecialty fellowship (PDCC) in Paediatric Dermatology at JIPMER, Puducherry. He is known for his meticulous clinical examination, detailed patient counselling, and child-friendly approach. He has also served as Senior Resident at AIIMS New Delhi, AIIMS Bhubaneswar, JIPMER Puducherry, and AIIMS Jodhpur. He received the Dr. K. C. Kandhari Book Prize for the best postgraduate student in Dermatology at AIIMS, New Delhi."
    },
    {
      slug: "dr-narayanan-b",
      name: "Dr. Narayanan B",
      designation: "Consultant Dermatologist & Dermatosurgeon",
      qualifications: "MBBS, MD (Dermatology) - AIIMS New Delhi",
      qualificationsShort: "MD (AIIMS, New Delhi)",
      expertise: [
        "Dermatosurgery",
        "Skin surgery",
        "Clinical dermatology",
        "Hair disorders",
        "Aesthetic dermatology",
        "Chronic skin diseases",
        "Skin, hair and nail disorders"
      ],
      bio: "Dr. Narayanan B completed his dermatology training at AIIMS, New Delhi and further refined his clinical and surgical skills at the Postgraduate Institute of Medical Education and Research (PGIMER), Chandigarh. His interests include dermatosurgery, aesthetic dermatology, and comprehensive management of skin and hair disorders. He is recognized for combining surgical precision with a compassionate, patient-centred approach."
    }
  ],

  contact: {
    phone: "+91 96984 44888",
    email: "crisprdermatology@gmail.com",

    address: {
      street: "39/2, RK Shanmugam Salai",
      locality: "KK Nagar",
      city: "Chennai",
      state: "Tamil Nadu",
      postalCode: "600078",
      country: "India"
    },

    geo: {
      latitude: "13.0418",   // approximate KK Nagar
      longitude: "80.1960"
    },

    whatsapp: "https://wa.me/919698444888",

    // Machine-readable, schema.org format -- used ONLY in JSON-LD structured data.
    // Mon-Sat 4-9pm; Sunday 9am-1pm & 4-9pm.
    workingHours: "Mo-Sa 16:00-21:00, Su 09:00-13:00,16:00-21:00",

    // Human-readable, used for on-page display (top bar, contact page, etc.)
    workingHoursDisplay: "Mon-Sat: 4:00-9:00 PM | Sun: 9:00 AM-1:00 PM & 4:00-9:00 PM"
  }
};
