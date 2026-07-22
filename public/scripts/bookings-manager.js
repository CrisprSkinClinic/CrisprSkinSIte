// public/scripts/bookings-manager.js
//
// Client-side logic for /bookings-manager. Uses Supabase Auth directly
// in the browser (via the anon key -- safe to expose, protected by
// Supabase's own auth flow) for login, then calls the
// bookings-manager.js Netlify function (which re-verifies the session
// server-side with the service role key) for all actual data operations.

const CLINIC_DOCTORS = [
  { id: '514ff136-ee45-4d49-89b5-d128d96aef62', name: 'Dr. Karthik L', short: 'KL' },
  { id: 'd5372165-fc7e-47e8-aee6-ce02e7fefc71', name: 'Dr. Narayanan A', short: 'NA' },
  { id: '519dbd89-d3d9-4ee9-8923-5fabbe51cf2e', name: 'Dr. Narayanan B', short: 'NB' },
];
const DAY_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = { sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday' };

const state = {
  session: null,
  profile: null,
  viewDate: todayStr(),
  doctorFilter: 'all',
  typeFilter: 'all',
  statusFilter: 'all',
  appointments: [],
  editingAppointmentId: null,
  selectedSlots: [], // array of "HH:MM" strings
  currentDetailAppointment: null,
  scheduleDoctorId: CLINIC_DOCTORS[0].id,
};

let supabaseClient = null;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function dayOfWeekFor(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return DAY_ORDER[dt.getDay()];
}

function formatTime12h(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---- API helper ----
async function callFunction(action, data = {}) {
  if (!state.session) throw new Error('Not signed in.');
  const response = await fetch('/.netlify/functions/bookings-manager', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: state.session.access_token, action, data }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

// ---- Auth ----
async function initAuth() {
  // Defensive checks -- these three failure modes each give a specific,
  // readable error instead of a generic "Cannot read properties of
  // null (reading 'auth')" crash if the CDN script didn't load, or if
  // the required env vars weren't set at build time.
  if (typeof window.supabase === 'undefined' || !window.supabase) {
    showLoginScreen();
    document.getElementById('bm-login-error').textContent =
      'Could not load the Supabase library. Please check your internet connection and reload the page.';
    return;
  }
  if (!window.__BM_SUPABASE_URL__ || !window.__BM_SUPABASE_ANON_KEY__) {
    showLoginScreen();
    document.getElementById('bm-login-error').textContent =
      'This page is missing required configuration (Supabase URL/key). Contact the site administrator.';
    return;
  }

  supabaseClient = window.supabase.createClient(window.__BM_SUPABASE_URL__, window.__BM_SUPABASE_ANON_KEY__);

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    await onSignedIn(session);
  } else {
    showLoginScreen();
  }

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      state.session = null;
      state.profile = null;
      showLoginScreen();
    }
  });
}

function showLoginScreen() {
  document.getElementById('bm-login-screen').classList.remove('hidden');
  document.getElementById('bm-app').classList.add('hidden');
}

async function onSignedIn(session) {
  state.session = session;
  try {
    const { profile } = await callFunction('whoami');
    state.profile = profile;
  } catch (err) {
    // Session exists but no active staff profile -- treat as not signed in
    // rather than showing a broken app shell.
    await supabaseClient.auth.signOut();
    document.getElementById('bm-login-error').textContent = err.message;
    showLoginScreen();
    return;
  }
  document.getElementById('bm-login-screen').classList.add('hidden');
  document.getElementById('bm-app').classList.remove('hidden');
  document.getElementById('bm-staff-name').textContent = `${state.profile.full_name} (${state.profile.role})`;
  renderDatePills();
  await loadAppointments();
}

document.getElementById('bm-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('bm-login-btn');
  const errorEl = document.getElementById('bm-login-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const email = document.getElementById('bm-email').value;
    const password = document.getElementById('bm-password').value;
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await onSignedIn(data.session);
  } catch (err) {
    errorEl.textContent = err.message === 'Invalid login credentials' ? 'Invalid email or password.' : err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

document.getElementById('bm-signout').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
});

// ---- Date pills ----
function renderDatePills() {
  const container = document.getElementById('bm-date-pills');
  container.innerHTML = '';
  for (let i = -3; i <= 10; i++) {
    const dateVal = addDays(todayStr(), i);
    const isToday = dateVal === todayStr();
    const isSelected = dateVal === state.viewDate;
    const dt = new Date(dateVal + 'T00:00:00');
    const label = isToday ? 'Today' : dt.toLocaleDateString('en-US', { weekday: 'short' });
    const btn = document.createElement('button');
    btn.className = `flex flex-col items-center min-w-[56px] px-2 py-2 rounded-xl border text-xs font-bold transition ${isSelected ? 'bg-brand-900 text-white border-brand-900' : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300'}`;
    btn.innerHTML = `<span class="uppercase opacity-80">${label}</span><span class="text-base leading-none mt-1">${dt.getDate()}</span>`;
    btn.addEventListener('click', () => {
      state.viewDate = dateVal;
      renderDatePills();
      loadAppointments();
    });
    container.appendChild(btn);
    if (isSelected) setTimeout(() => btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }), 100);
  }
}

document.getElementById('bm-doctor-filter').addEventListener('change', (e) => {
  state.doctorFilter = e.target.value;
  renderAppointmentFeed();
});
document.getElementById('bm-type-filter').addEventListener('change', (e) => {
  state.typeFilter = e.target.value;
  renderAppointmentFeed();
});
document.getElementById('bm-status-filter').addEventListener('change', (e) => {
  state.statusFilter = e.target.value;
  renderAppointmentFeed();
});

// ---- Appointments ----
async function loadAppointments() {
  const feed = document.getElementById('bm-appointment-feed');
  feed.innerHTML = '<p class="text-slate-400 text-sm text-center py-10">Loading...</p>';
  try {
    const { appointments } = await callFunction('list_appointments', { date: state.viewDate });
    state.appointments = appointments;
    renderAppointmentFeed();
  } catch (err) {
    feed.innerHTML = `<p class="text-red-600 text-sm text-center py-10">${err.message}</p>`;
  }
}

function renderAppointmentFeed() {
  const feed = document.getElementById('bm-appointment-feed');
  let list = state.statusFilter === 'all' ? state.appointments.filter((a) => a.status !== 'cancelled') : state.appointments.filter((a) => a.status === state.statusFilter);
  if (state.doctorFilter !== 'all') list = list.filter((a) => a.doctor_id === state.doctorFilter);
  if (state.typeFilter !== 'all') {
    list = list.filter((a) => {
      // "New" and "Review" are stored verbatim at the start of notes
      // (see the booking form's appointmentType construction), so those
      // two match by literal prefix. "Procedure" bookings store the
      // actual procedure name instead (e.g. "Chemical Peel"), not the
      // literal word -- so Procedure is detected by exclusion (neither
      // New nor Review) rather than a direct text match.
      const serviceLabel = (a.notes || '').split('|')[0].trim();
      if (state.typeFilter === 'Procedure') {
        return serviceLabel !== 'New' && serviceLabel !== 'Review';
      }
      return serviceLabel === state.typeFilter;
    });
  }
  list.sort((a, b) => a.slot_time.localeCompare(b.slot_time));

  if (list.length === 0) {
    feed.innerHTML = '<p class="text-slate-400 text-sm text-center py-10">No appointments for this day.</p>';
    return;
  }

  feed.innerHTML = '';
  list.forEach((appt) => {
    const doctor = CLINIC_DOCTORS.find((d) => d.id === appt.doctor_id);
    const statusColors = {
      booked: 'bg-slate-800',
      arrived: 'bg-green-600',
      complete: 'bg-slate-400',
      no_show: 'bg-red-600',
      cancelled: 'bg-slate-300',
    };
    const serviceLabel = (appt.notes || '').split('|')[0].trim() || 'Appointment';
    // booked_by is null for public self-service bookings
    // (public-book-appointment.js always sets it to null) and set to
    // the staff member's profile id when created here in Bookings
    // Manager -- this is what actually distinguishes the two sources.
    const sourceLabel = appt.booked_by
      ? `Booked by ${appt.booked_by_profile?.full_name || 'Staff'}`
      : 'Booked online';
    const card = document.createElement('div');
    card.className = `${statusColors[appt.status] || 'bg-slate-800'} text-white rounded-2xl p-4 shadow-sm cursor-pointer transition active:scale-[0.99]`;
    card.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <span class="font-mono font-bold text-lg">${formatTime12h(appt.slot_time)}</span>
        <span class="text-xs font-bold bg-white/20 px-2 py-1 rounded-full">${doctor ? doctor.short : '?'}</span>
      </div>
      <p class="font-bold text-base mb-1 truncate">${appt.patients?.name || 'Unknown patient'}</p>
      <p class="text-sm opacity-90 mb-1">${serviceLabel}${appt.linked_group_id ? ' · Multi-slot' : ''}</p>
      <p class="text-[11px] opacity-70 font-semibold uppercase tracking-wide">${sourceLabel}</p>
    `;
    card.addEventListener('click', () => openDetailModal(appt));
    feed.appendChild(card);
  });
}

// ---- Detail modal ----
function openDetailModal(appt) {
  state.currentDetailAppointment = appt;
  const doctor = CLINIC_DOCTORS.find((d) => d.id === appt.doctor_id);
  const serviceLabel = (appt.notes || '').split('|')[0].trim() || 'Appointment';
  const sourceLabel = appt.booked_by
    ? `Staff (${appt.booked_by_profile?.full_name || 'Unknown staff member'})`
    : 'Online (public website)';
  document.getElementById('bm-detail-body').innerHTML = `
    <button id="bm-open-patient-from-detail" class="text-left w-full hover:opacity-70 transition">
      <h3 class="text-xl font-bold text-slate-900 mb-1 underline decoration-dotted underline-offset-4">${appt.patients?.name || 'Unknown patient'}</h3>
    </button>
    <p class="text-sm text-slate-500 mb-4">${appt.patients?.phone || 'No phone on file'}</p>
    <div class="space-y-3">
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Time</span><span class="font-semibold text-slate-800">${formatTime12h(appt.slot_time)} · ${appt.slot_date}</span></div>
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Doctor</span><span class="font-semibold text-slate-800">${doctor ? doctor.name : 'Unknown'}</span></div>
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Service</span><span class="font-semibold text-slate-800">${serviceLabel}</span></div>
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Status</span><span class="font-semibold text-slate-800 capitalize">${appt.status.replace('_', ' ')}</span></div>
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Booked Via</span><span class="font-semibold text-slate-800">${sourceLabel}</span></div>
    </div>
  `;

  // WhatsApp: pre-fill a confirmation message with the patient's own
  // number, using wa.me's ?text= param. Only shown when a phone number
  // is actually on file -- there's nothing to link to otherwise.
  const whatsappBtn = document.getElementById('bm-whatsapp-appt');
  const rawPhone = (appt.patients?.phone || '').replace(/[^\d]/g, '');
  if (rawPhone) {
    // wa.me needs a country code; assume India (+91) if a 10-digit
    // local number was stored without one -- matches the clinic's own
    // number format (+91 96984 44888) used elsewhere on the site.
    const fullNumber = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;
    const dateFormatted = new Date(appt.slot_date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    const message = `Hi ${appt.patients?.name || ''}, this is a confirmation of your appointment at CRISPR Skin and Hair Clinic with ${doctor ? doctor.name : 'our doctor'} on ${dateFormatted} at ${formatTime12h(appt.slot_time)} for ${serviceLabel}. Please arrive 10 minutes early. Call us at +91 96984 44888 if you need to reschedule.`;
    whatsappBtn.href = `https://wa.me/${fullNumber}?text=${encodeURIComponent(message)}`;
    whatsappBtn.classList.remove('hidden');
  } else {
    whatsappBtn.classList.add('hidden');
  }

  document.getElementById('bm-detail-modal').classList.remove('hidden');
  document.getElementById('bm-open-patient-from-detail')?.addEventListener('click', () => {
    if (appt.patient_id) openPatientDetail(appt.patient_id);
  });
}

document.getElementById('bm-close-detail').addEventListener('click', closeDetailModal);
document.getElementById('bm-detail-backdrop').addEventListener('click', closeDetailModal);
function closeDetailModal() {
  document.getElementById('bm-detail-modal').classList.add('hidden');
  state.currentDetailAppointment = null;
}

document.querySelectorAll('.bm-status-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!state.currentDetailAppointment) return;
    try {
      await callFunction('update_appointment_status', { id: state.currentDetailAppointment.id, status: btn.dataset.status });
      closeDetailModal();
      await loadAppointments();
    } catch (err) {
      alert(err.message);
    }
  });
});

document.getElementById('bm-delete-appt').addEventListener('click', async () => {
  if (!state.currentDetailAppointment) return;
  if (!confirm(`Delete this appointment for ${state.currentDetailAppointment.patients?.name || 'this patient'}?`)) return;
  try {
    await callFunction('delete_appointment', { id: state.currentDetailAppointment.id });
    closeDetailModal();
    await loadAppointments();
  } catch (err) {
    alert(err.message);
  }
});

// ---- New/Edit appointment overlay ----
document.getElementById('bm-fab-new').addEventListener('click', () => openBookingOverlay());
document.getElementById('bm-close-booking').addEventListener('click', closeBookingOverlay);

function openBookingOverlay() {
  document.getElementById('bm-form-date').value = state.viewDate;
  document.getElementById('bm-booking-overlay').classList.remove('hidden');
  document.getElementById('bm-booking-overlay').classList.add('flex');
  refreshTimeSlots();
}
function closeBookingOverlay() {
  document.getElementById('bm-booking-overlay').classList.add('hidden');
  document.getElementById('bm-booking-overlay').classList.remove('flex');
  resetBookingForm();
}
function resetBookingForm() {
  document.getElementById('bm-patient-name').value = '';
  document.getElementById('bm-patient-phone').value = '';
  document.getElementById('bm-phone-lookup-status').textContent = '';
  document.getElementById('bm-procedure-name').value = '';
  document.getElementById('bm-multi-slot-toggle').checked = false;
  document.querySelectorAll('input[name="bm-doctor"], input[name="bm-type"]').forEach((el) => (el.checked = false));
  document.getElementById('bm-procedure-config').classList.add('hidden');
  state.selectedSlots = [];
  state.editingAppointmentId = null;
  document.getElementById('bm-edit-banner').classList.add('hidden');
  document.getElementById('bm-booking-error').textContent = '';
}

// Phone-lookup autofill: typing a phone number looks up an existing
// patient and pre-fills their name, and -- since this is most useful
// for Review visits with a returning patient -- suggests the doctor
// they last saw. Debounced so it doesn't fire on every keystroke; only
// triggers once a plausible number length is reached, and never
// overwrites a name the staff member has already typed manually.
let phoneLookupTimeout = null;
document.getElementById('bm-patient-phone').addEventListener('input', (e) => {
  clearTimeout(phoneLookupTimeout);
  const phone = e.target.value.trim();
  const statusEl = document.getElementById('bm-phone-lookup-status');
  if (phone.replace(/\D/g, '').length < 10) {
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = 'Looking up...';
  statusEl.className = 'text-xs min-h-[1rem] mb-2 px-1 text-slate-400';
  phoneLookupTimeout = setTimeout(async () => {
    try {
      const result = await callFunction('lookup_patient_by_phone', { phone });
      if (result.found) {
        const nameField = document.getElementById('bm-patient-name');
        // Don't clobber a name the staff member already typed for a
        // *different* patient at this phone number (e.g. a family
        // member's phone reused for multiple patients) -- only
        // autofill when the name field is still empty.
        if (!nameField.value.trim()) {
          nameField.value = result.patient.name;
        }
        const lastSeenText = result.lastDoctorName
          ? ` · Last seen by ${result.lastDoctorName}${result.lastVisitDate ? ` on ${result.lastVisitDate}` : ''}`
          : '';
        statusEl.textContent = `Existing patient found${lastSeenText}`;
        statusEl.className = 'text-xs min-h-[1rem] mb-2 px-1 text-green-600 font-medium';

        // Suggest (but don't force) the doctor they last saw, if the
        // doctor field hasn't already been chosen -- most useful for
        // Review visits with the same doctor as before.
        const doctorAlreadyChosen = document.querySelector('input[name="bm-doctor"]:checked');
        if (!doctorAlreadyChosen && result.lastDoctorId) {
          const suggestedDoctorInput = document.querySelector(`input[name="bm-doctor"][value="${result.lastDoctorId}"]`);
          if (suggestedDoctorInput) {
            suggestedDoctorInput.checked = true;
            refreshTimeSlots();
          }
        }
      } else {
        statusEl.textContent = 'New patient (no match found)';
        statusEl.className = 'text-xs min-h-[1rem] mb-2 px-1 text-slate-400';
      }
    } catch (err) {
      statusEl.textContent = '';
    }
  }, 500);
});

document.getElementById('bm-form-date').addEventListener('change', (e) => {
  state.viewDate = e.target.value;
  refreshTimeSlots();
});
document.querySelectorAll('input[name="bm-doctor"]').forEach((el) => el.addEventListener('change', refreshTimeSlots));
document.querySelectorAll('input[name="bm-type"]').forEach((el) =>
  el.addEventListener('change', () => {
    const isProcedure = el.value === 'Procedure';
    document.getElementById('bm-procedure-config').classList.toggle('hidden', !isProcedure);
    state.selectedSlots = [];
    refreshTimeSlots();
  })
);
document.getElementById('bm-multi-slot-toggle').addEventListener('change', () => {
  state.selectedSlots = [];
  refreshTimeSlots();
});

function getSelectedDuration() {
  const type = document.querySelector('input[name="bm-type"]:checked')?.value;
  if (type === 'New') return 30;
  if (type === 'Review') return 15;
  return 15; // Procedure: base unit is 15 min, multiple slots combine
}

async function refreshTimeSlots() {
  const grid = document.getElementById('bm-time-slots-grid');
  const doctorEl = document.querySelector('input[name="bm-doctor"]:checked');
  const typeEl = document.querySelector('input[name="bm-type"]:checked');
  const dateVal = document.getElementById('bm-form-date').value;

  if (!doctorEl || !typeEl || !dateVal) {
    grid.innerHTML = '<p class="col-span-3 text-slate-400 text-sm text-center py-6">Select doctor, type, and date first.</p>';
    return;
  }

  grid.innerHTML = '<p class="col-span-3 text-slate-400 text-sm text-center py-6">Checking availability...</p>';

  try {
    const doctorId = doctorEl.value;
    const doctorsToCheck = doctorId === 'any' ? CLINIC_DOCTORS.map((d) => d.id) : [doctorId];
    const dayName = dayOfWeekFor(dateVal);

    // Fetch schedule + overrides + existing appointments for each
    // candidate doctor, then compute genuinely free slots -- mirrors
    // the capacity logic in the old Firebase tool but against the real
    // Supabase schema.
    const perDoctorFreeSlots = {};
    for (const docId of doctorsToCheck) {
      const [{ sessions }, { overrides }, { appointments }] = await Promise.all([
        callFunction('list_schedule', { doctor_id: docId }),
        callFunction('list_overrides', { doctor_id: docId }),
        callFunction('list_appointments', { date: dateVal, doctor_id: docId }),
      ]);

      const todaysOverrides = overrides.filter((o) => o.override_date === dateVal);
      if (todaysOverrides.some((o) => o.override_type === 'leave')) {
        perDoctorFreeSlots[docId] = new Set();
        continue;
      }
      const blockedTimes = new Set(todaysOverrides.filter((o) => o.override_type === 'blocked_slot').map((o) => o.blocked_slot?.slice(0, 5)));
      const modifiedOverride = todaysOverrides.find((o) => o.override_type === 'modified');

      let windows = modifiedOverride
        ? [{ session_start: modifiedOverride.modified_start, session_end: modifiedOverride.modified_end }]
        : sessions.filter((s) => s.day_of_week === dayName && s.is_active);

      const bookedTimes = new Set(appointments.filter((a) => a.status !== 'cancelled').map((a) => a.slot_time.slice(0, 5)));

      const free = new Set();
      for (const w of windows) {
        let cursor = timeToMinutes(w.session_start.slice(0, 5));
        const end = timeToMinutes(w.session_end.slice(0, 5));
        while (cursor < end) {
          const t = minutesToTime(cursor);
          if (!blockedTimes.has(t) && !bookedTimes.has(t)) free.add(t);
          cursor += 15;
        }
      }
      perDoctorFreeSlots[docId] = free;
    }

    // Preserved (not just the merged set) so a "New" (30 min) booking
    // can verify BOTH 15-min sub-slots are free for the SAME doctor --
    // the merged set alone can't tell us that, since it would show a
    // slot as available even if only a different candidate doctor is
    // free there than the one free at the first slot.
    state.perDoctorFreeSlots = perDoctorFreeSlots;
    state.currentDoctorsToCheck = doctorsToCheck;

    // Merge: a slot is shown if at least one candidate doctor is free at it.
    const mergedSlots = new Set();
    for (const docId of doctorsToCheck) {
      perDoctorFreeSlots[docId].forEach((t) => mergedSlots.add(t));
    }

    const sortedSlots = Array.from(mergedSlots).sort();
    if (sortedSlots.length === 0) {
      grid.innerHTML = '<p class="col-span-3 text-slate-400 text-sm text-center py-6">No available slots for this date.</p>';
      return;
    }

    grid.innerHTML = '';
    const isMulti = typeEl.value === 'Procedure' && document.getElementById('bm-multi-slot-toggle').checked;
    sortedSlots.forEach((t) => {
      const isSelected = state.selectedSlots.includes(t);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `py-2.5 rounded-lg text-xs font-bold border transition ${isSelected ? 'bg-brand-900 text-white border-brand-900' : 'bg-white text-slate-700 border-slate-200 hover:border-brand-300'}`;
      btn.textContent = formatTime12h(t);
      btn.addEventListener('click', () => {
        if (isMulti) {
          state.selectedSlots = state.selectedSlots.includes(t) ? state.selectedSlots.filter((s) => s !== t) : [...state.selectedSlots, t];
        } else if (typeEl.value === 'New') {
          // New patient consultations are 30 min -- automatically
          // reserve this slot plus the next consecutive 15-min slot,
          // but only if some single doctor among the current
          // candidates is free for BOTH (not just each slot
          // individually across possibly-different doctors).
          const nextSlot = minutesToTime(timeToMinutes(t) + 15);
          const doctorFreeForBoth = doctorsToCheck.find(
            (docId) => state.perDoctorFreeSlots[docId]?.has(t) && state.perDoctorFreeSlots[docId]?.has(nextSlot)
          );
          if (!doctorFreeForBoth) {
            alert(`This slot is only 15 minutes free -- a New patient consultation needs 30 minutes with the same doctor. Please choose a different time.`);
            return;
          }
          state.selectedSlots = [t, nextSlot];
        } else {
          state.selectedSlots = [t];
        }
        updateDurationLabel();
        refreshTimeSlots();
      });
      grid.appendChild(btn);
    });
    updateDurationLabel();
  } catch (err) {
    grid.innerHTML = `<p class="col-span-3 text-red-600 text-sm text-center py-6">${err.message}</p>`;
  }
}

function updateDurationLabel() {
  const label = document.getElementById('bm-duration-label');
  const typeEl = document.querySelector('input[name="bm-type"]:checked');
  const isMulti = typeEl?.value === 'Procedure' && document.getElementById('bm-multi-slot-toggle').checked;
  if (isMulti) {
    label.textContent = state.selectedSlots.length ? `${state.selectedSlots.length} slot(s) · ${state.selectedSlots.length * 15} min` : 'Select slots';
  } else {
    label.textContent = state.selectedSlots.length ? `${getSelectedDuration()} min` : '';
  }
}

document.getElementById('bm-submit-booking').addEventListener('click', async () => {
  const errorEl = document.getElementById('bm-booking-error');
  errorEl.textContent = '';
  const patientName = document.getElementById('bm-patient-name').value.trim();
  const patientPhone = document.getElementById('bm-patient-phone').value.trim();
  const doctorEl = document.querySelector('input[name="bm-doctor"]:checked');
  const typeEl = document.querySelector('input[name="bm-type"]:checked');
  const dateVal = document.getElementById('bm-form-date').value;

  if (!patientName || !doctorEl || !typeEl || !dateVal || state.selectedSlots.length === 0) {
    errorEl.textContent = 'Please fill in patient name, doctor, type, and select at least one time slot.';
    return;
  }

  const appointmentType = typeEl.value === 'Procedure' ? document.getElementById('bm-procedure-name').value.trim() || 'Procedure' : typeEl.value;
  const btn = document.getElementById('bm-submit-booking');
  btn.disabled = true;
  btn.textContent = 'Booking...';

  try {
    await callFunction('create_appointment', {
      patientName,
      patientPhone,
      doctorId: doctorEl.value,
      date: dateVal,
      slots: state.selectedSlots.sort(),
      appointmentType,
      notes: `${appointmentType} | Booked via Bookings Manager`,
    });
    closeBookingOverlay();
    state.viewDate = dateVal;
    renderDatePills();
    await loadAppointments();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm & Book';
  }
});

// ---- Patient Detail (Profile + Visit History) ----
let currentPatientId = null;

async function openPatientDetail(patientId) {
  currentPatientId = patientId;
  document.getElementById('bm-patient-overlay').classList.remove('hidden');
  document.getElementById('bm-patient-overlay').classList.add('flex');
  switchPatientTab('profile');
  await loadPatientProfile(patientId);
}

document.getElementById('bm-close-patient').addEventListener('click', () => {
  document.getElementById('bm-patient-overlay').classList.add('hidden');
  document.getElementById('bm-patient-overlay').classList.remove('flex');
  currentPatientId = null;
});

document.querySelectorAll('.bm-patient-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchPatientTab(tab.dataset.patientTab));
});

function switchPatientTab(tabName) {
  document.querySelectorAll('.bm-patient-tab').forEach((t) => {
    const isActive = t.dataset.patientTab === tabName;
    t.classList.toggle('text-brand-600', isActive);
    t.classList.toggle('border-b-2', isActive);
    t.classList.toggle('border-brand-600', isActive);
    t.classList.toggle('text-slate-500', !isActive);
  });
  document.getElementById('bm-patient-tab-profile').classList.toggle('hidden', tabName !== 'profile');
  document.getElementById('bm-patient-tab-history').classList.toggle('hidden', tabName !== 'history');
  if (tabName === 'history' && currentPatientId) loadPatientHistory(currentPatientId);
}

function calculateAge(dobStr) {
  if (!dobStr) return '';
  const dob = new Date(dobStr);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return `${age} years old`;
}

async function loadPatientProfile(patientId) {
  const saveMsg = document.getElementById('bm-profile-save-msg');
  saveMsg.textContent = '';
  try {
    const { patient } = await callFunction('get_patient_profile', { patient_id: patientId });
    document.getElementById('bm-patient-overlay-name').textContent = patient.name || 'Patient';
    document.getElementById('bm-profile-name').value = patient.name || '';
    document.getElementById('bm-profile-phone').value = patient.phone || '';
    document.getElementById('bm-profile-dob').value = patient.dob || '';
    document.getElementById('bm-profile-gender').value = patient.gender || '';
    document.getElementById('bm-profile-address').value = patient.address || '';
    document.getElementById('bm-profile-uhid').value = patient.uhid || 'Not yet registered';
    document.getElementById('bm-profile-age').textContent = calculateAge(patient.dob);
  } catch (err) {
    saveMsg.textContent = err.message;
    saveMsg.className = 'text-sm text-center text-red-600';
  }
}

document.getElementById('bm-profile-dob').addEventListener('change', (e) => {
  document.getElementById('bm-profile-age').textContent = calculateAge(e.target.value);
});

document.getElementById('bm-save-profile').addEventListener('click', async () => {
  if (!currentPatientId) return;
  const saveMsg = document.getElementById('bm-profile-save-msg');
  const btn = document.getElementById('bm-save-profile');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await callFunction('update_patient_profile', {
      patient_id: currentPatientId,
      name: document.getElementById('bm-profile-name').value.trim(),
      phone: document.getElementById('bm-profile-phone').value.trim(),
      dob: document.getElementById('bm-profile-dob').value,
      gender: document.getElementById('bm-profile-gender').value,
      address: document.getElementById('bm-profile-address').value.trim(),
    });
    saveMsg.textContent = 'Saved.';
    saveMsg.className = 'text-sm text-center text-green-600';
    await loadAppointments(); // patient name/phone may have changed
  } catch (err) {
    saveMsg.textContent = err.message;
    saveMsg.className = 'text-sm text-center text-red-600';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Profile';
  }
});

async function loadPatientHistory(patientId) {
  const container = document.getElementById('bm-patient-tab-history');
  container.innerHTML = '<p class="text-slate-400 text-sm text-center py-10">Loading...</p>';
  try {
    const { visits } = await callFunction('get_patient_history', { patient_id: patientId });
    if (visits.length === 0) {
      container.innerHTML = '<p class="text-slate-400 text-sm text-center py-10">No past visits on record.</p>';
      return;
    }
    container.innerHTML = '';
    visits.forEach((v) => {
      const serviceLabel = (v.notes || '').split('|')[0].trim() || 'Appointment';
      const row = document.createElement('div');
      row.className = 'bg-white rounded-xl p-3 border border-slate-200';
      row.innerHTML = `
        <div class="flex justify-between items-start mb-1">
          <span class="font-semibold text-slate-800 text-sm">${v.slot_date} · ${formatTime12h(v.slot_time)}</span>
          <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">${v.status.replace('_', ' ')}</span>
        </div>
        <p class="text-sm text-slate-600">${v.doctors?.name || 'Unknown doctor'} · ${serviceLabel}</p>
      `;
      container.appendChild(row);
    });
  } catch (err) {
    container.innerHTML = `<p class="text-red-600 text-sm text-center py-10">${err.message}</p>`;
  }
}

// ---- Schedule manager ----
document.getElementById('bm-open-schedule').addEventListener('click', () => {
  document.getElementById('bm-schedule-overlay').classList.remove('hidden');
  document.getElementById('bm-schedule-overlay').classList.add('flex');
  loadScheduleEditor(state.scheduleDoctorId);
});
document.getElementById('bm-close-schedule').addEventListener('click', () => {
  document.getElementById('bm-schedule-overlay').classList.add('hidden');
  document.getElementById('bm-schedule-overlay').classList.remove('flex');
});
document.querySelectorAll('.bm-schedule-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.bm-schedule-tab').forEach((t) => {
      t.classList.remove('text-brand-600', 'border-b-2', 'border-brand-600');
      t.classList.add('text-slate-500');
    });
    tab.classList.add('text-brand-600', 'border-b-2', 'border-brand-600');
    tab.classList.remove('text-slate-500');
    state.scheduleDoctorId = tab.dataset.scheduleDoctor;
    loadScheduleEditor(state.scheduleDoctorId);
  });
});

async function loadScheduleEditor(doctorId) {
  const rowsContainer = document.getElementById('bm-weekly-schedule-rows');
  const exceptionsContainer = document.getElementById('bm-exceptions-list');
  rowsContainer.innerHTML = '<p class="text-slate-400 text-sm">Loading...</p>';
  exceptionsContainer.innerHTML = '';
  try {
    const [{ sessions }, { overrides }] = await Promise.all([
      callFunction('list_schedule', { doctor_id: doctorId }),
      callFunction('list_overrides', { doctor_id: doctorId }),
    ]);

    rowsContainer.innerHTML = '';
    for (const day of DAY_ORDER) {
      const daySessions = sessions.filter((s) => s.day_of_week === day);
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between p-3 bg-slate-50 rounded-lg';
      const blocksHtml = daySessions.length
        ? daySessions.map((s) => `<span class="text-xs font-semibold text-slate-700">${formatTime12h(s.session_start.slice(0, 5))}-${formatTime12h(s.session_end.slice(0, 5))} <button data-remove-block="${s.id}" class="text-red-500 ml-1">✕</button></span>`).join(', ')
        : '<span class="text-xs text-slate-400">Closed</span>';
      row.innerHTML = `<span class="font-semibold text-slate-700 text-sm w-24">${DAY_LABELS[day]}</span><div class="flex-1 flex flex-wrap gap-2">${blocksHtml}</div>`;
      rowsContainer.appendChild(row);
    }
    rowsContainer.querySelectorAll('[data-remove-block]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await callFunction('delete_schedule_block', { id: btn.dataset.removeBlock });
        loadScheduleEditor(doctorId);
      });
    });

    const upcomingOverrides = overrides.filter((o) => o.override_date >= todayStr()).sort((a, b) => a.override_date.localeCompare(b.override_date));
    if (upcomingOverrides.length === 0) {
      exceptionsContainer.innerHTML = '<p class="text-sm text-slate-400">No upcoming exceptions.</p>';
    } else {
      upcomingOverrides.forEach((o) => {
        const desc = o.override_type === 'leave' ? '<span class="font-bold text-red-600">Full-day leave</span>' : o.override_type === 'modified' ? `${formatTime12h(o.modified_start?.slice(0, 5))}-${formatTime12h(o.modified_end?.slice(0, 5))}` : `Blocked ${formatTime12h(o.blocked_slot?.slice(0, 5))}`;
        const li = document.createElement('div');
        li.className = 'flex justify-between items-center p-2.5 bg-slate-50 rounded-lg text-sm';
        li.innerHTML = `<span><span class="font-semibold text-slate-800">${o.override_date}</span> — ${desc}</span><button data-remove-override="${o.id}" class="text-red-500 text-xs font-bold">Remove</button>`;
        exceptionsContainer.appendChild(li);
      });
      exceptionsContainer.querySelectorAll('[data-remove-override]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await callFunction('remove_override', { id: btn.dataset.removeOverride });
          loadScheduleEditor(doctorId);
        });
      });
    }
  } catch (err) {
    rowsContainer.innerHTML = `<p class="text-red-600 text-sm">${err.message}</p>`;
  }
}

document.getElementById('bm-add-block').addEventListener('click', async () => {
  const day = document.getElementById('bm-new-block-day').value;
  const start = document.getElementById('bm-new-block-start').value;
  const end = document.getElementById('bm-new-block-end').value;
  if (!start || !end || start >= end) {
    alert('Please set a valid start and end time.');
    return;
  }
  try {
    await callFunction('add_schedule_block', { doctor_id: state.scheduleDoctorId, day_of_week: day, start_time: start, end_time: end });
    document.getElementById('bm-new-block-start').value = '';
    document.getElementById('bm-new-block-end').value = '';
    loadScheduleEditor(state.scheduleDoctorId);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('bm-add-exception').addEventListener('click', async () => {
  const date = document.getElementById('bm-exception-date').value;
  const start = document.getElementById('bm-exception-start').value;
  const end = document.getElementById('bm-exception-end').value;
  const isLeave = document.getElementById('bm-exception-leave').checked;
  if (!date) {
    alert('Please select a date.');
    return;
  }
  try {
    if (isLeave) {
      await callFunction('add_override', { doctor_id: state.scheduleDoctorId, override_date: date, override_type: 'leave' });
    } else {
      if (!start || !end || start >= end) {
        alert('Please set valid modified hours, or check "Mark as full-day leave".');
        return;
      }
      await callFunction('add_override', { doctor_id: state.scheduleDoctorId, override_date: date, override_type: 'modified', modified_start: start, modified_end: end });
    }
    document.getElementById('bm-exception-date').value = '';
    document.getElementById('bm-exception-start').value = '';
    document.getElementById('bm-exception-end').value = '';
    document.getElementById('bm-exception-leave').checked = false;
    loadScheduleEditor(state.scheduleDoctorId);
  } catch (err) {
    alert(err.message);
  }
});

// ---- Audit log ----
document.getElementById('bm-open-audit').addEventListener('click', async () => {
  document.getElementById('bm-audit-overlay').classList.remove('hidden');
  document.getElementById('bm-audit-overlay').classList.add('flex');
  const list = document.getElementById('bm-audit-list');
  list.innerHTML = '<p class="text-slate-400 text-sm text-center py-10">Loading...</p>';
  try {
    const { logs } = await callFunction('list_audit_log');
    if (logs.length === 0) {
      list.innerHTML = '<p class="text-slate-400 text-sm text-center py-10">No log entries yet.</p>';
      return;
    }
    list.innerHTML = '';
    logs.forEach((log) => {
      const d = new Date(log.created_at);
      const item = document.createElement('div');
      item.className = 'bg-white rounded-xl p-3 border border-slate-200';
      item.innerHTML = `
        <div class="flex justify-between mb-1">
          <span class="text-xs font-bold text-slate-700">${log.action}</span>
          <span class="text-[10px] text-slate-400 font-semibold uppercase">${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <p class="text-sm text-slate-600 mb-1">${log.details}</p>
        <p class="text-[10px] text-slate-400 font-bold uppercase">by ${log.performed_by}</p>
      `;
      list.appendChild(item);
    });
  } catch (err) {
    list.innerHTML = `<p class="text-red-600 text-sm text-center py-10">${err.message}</p>`;
  }
});
document.getElementById('bm-close-audit').addEventListener('click', () => {
  document.getElementById('bm-audit-overlay').classList.add('hidden');
  document.getElementById('bm-audit-overlay').classList.remove('flex');
});

// ---- Init ----
initAuth();
