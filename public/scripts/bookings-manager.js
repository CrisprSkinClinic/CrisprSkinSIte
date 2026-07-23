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
  isReschedule: false,
  isWalkIn: false,
  isOverbook: false,
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
  await updateRegistrationsBadge();
}

async function updateRegistrationsBadge() {
  try {
    const { requests } = await callFunction('list_registration_requests', { status: 'pending' });
    const badge = document.getElementById('bm-registrations-badge');
    if (requests.length > 0) {
      badge.textContent = requests.length > 9 ? '9+' : String(requests.length);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (err) {
    // Non-fatal -- the badge is a convenience indicator, not core
    // functionality, so a failed check here shouldn't disrupt sign-in.
    console.error('Could not check pending registrations:', err);
  }
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

  // Group rows sharing a linked_group_id into one card. A "New" (30
  // min) booking creates 2 linked rows (two consecutive 15-min slots),
  // and a multi-slot Procedure can create several -- both should show
  // as one card spanning the full time range, not one card per
  // underlying row.
  const grouped = [];
  const seenGroupIds = new Set();
  for (const appt of list) {
    if (appt.linked_group_id) {
      if (seenGroupIds.has(appt.linked_group_id)) continue;
      seenGroupIds.add(appt.linked_group_id);
      const groupRows = list
        .filter((a) => a.linked_group_id === appt.linked_group_id)
        .sort((a, b) => a.slot_time.localeCompare(b.slot_time));
      grouped.push({ ...groupRows[0], _groupRows: groupRows, _endTime: groupRows[groupRows.length - 1].slot_time });
    } else {
      grouped.push({ ...appt, _groupRows: [appt], _endTime: appt.slot_time });
    }
  }

  feed.innerHTML = '';
  grouped.forEach((appt) => {
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
    // For a grouped multi-slot booking, show the actual end of the
    // last slot (+15 min) so the displayed range reflects the true
    // occupied duration, not just the start of the final row.
    const timeDisplay = appt._groupRows.length > 1
      ? `${formatTime12h(appt.slot_time)} – ${formatTime12h(minutesToTime(timeToMinutes(appt._endTime.slice(0, 5)) + 15))}`
      : formatTime12h(appt.slot_time);
    card.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <span class="font-mono font-bold text-lg">${timeDisplay}</span>
        <span class="text-xs font-bold bg-white/20 px-2 py-1 rounded-full">${doctor ? doctor.short : '?'}</span>
      </div>
      <p class="font-bold text-base mb-1 truncate">${appt.patients?.name || 'Unknown patient'}</p>
      <p class="text-sm opacity-90 mb-1">${serviceLabel}</p>
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
  const timeDisplay = appt._groupRows && appt._groupRows.length > 1
    ? `${formatTime12h(appt.slot_time)} – ${formatTime12h(minutesToTime(timeToMinutes(appt._endTime.slice(0, 5)) + 15))}`
    : formatTime12h(appt.slot_time);
  document.getElementById('bm-detail-body').innerHTML = `
    <button id="bm-open-patient-from-detail" class="text-left w-full hover:opacity-70 transition">
      <h3 class="text-xl font-bold text-slate-900 mb-1 underline decoration-dotted underline-offset-4">${appt.patients?.name || 'Unknown patient'}</h3>
    </button>
    <p class="text-sm text-slate-500 mb-4">${appt.patients?.phone || 'No phone on file'}</p>
    <div class="space-y-3">
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Time</span><span class="font-semibold text-slate-800">${timeDisplay} · ${appt.slot_date}</span></div>
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

document.getElementById('bm-edit-appt').addEventListener('click', () => {
  if (!state.currentDetailAppointment) return;
  openEditOrReschedule(state.currentDetailAppointment, false);
});

document.getElementById('bm-reschedule-appt').addEventListener('click', () => {
  if (!state.currentDetailAppointment) return;
  openEditOrReschedule(state.currentDetailAppointment, true);
});

// ---- New/Edit appointment overlay ----
document.getElementById('bm-fab-new').addEventListener('click', () => openBookingOverlay());
document.getElementById('bm-fab-walkin').addEventListener('click', () => openWalkInOverlay());
document.getElementById('bm-close-booking').addEventListener('click', closeBookingOverlay);

function openBookingOverlay() {
  document.getElementById('bm-form-date').value = state.viewDate;
  document.getElementById('bm-booking-overlay').classList.remove('hidden');
  document.getElementById('bm-booking-overlay').classList.add('flex');
  refreshTimeSlots();
}

// Walk-ins still go through the normal slot grid -- the clinic's whole
// capacity system (schedules, overrides, the public site's own
// availability check) is built around 15-min slot alignment, so
// inventing an "off-grid, whatever time it actually is" booking type
// would silently break capacity tracking elsewhere. Instead, this
// defaults to today and auto-selects the EARLIEST available slot
// across all doctors, since speed is the actual point of a walk-in --
// staff can still change the doctor/time manually before confirming
// if the auto-picked one isn't right.
async function openWalkInOverlay() {
  state.isWalkIn = true;
  const today = todayStr();
  document.getElementById('bm-form-date').value = today;
  document.getElementById('bm-booking-overlay').classList.remove('hidden');
  document.getElementById('bm-booking-overlay').classList.add('flex');
  document.querySelector('input[name="bm-doctor"][value="any"]').checked = true;
  document.querySelector('input[name="bm-type"][value="Review"]').checked = true;

  // Walk-ins skip picking a date/time entirely -- the system still
  // assigns a real slot behind the scenes (needed for schedule/capacity
  // tracking elsewhere), it's just never shown to staff, since a
  // walk-in is being seen right now, not at a time worth choosing.
  document.getElementById('bm-form-date-section').classList.add('hidden');
  document.getElementById('bm-time-slots-section').classList.add('hidden');
  document.getElementById('bm-walkin-status-section').classList.remove('hidden');
  document.getElementById('bm-walkin-status-detail').textContent = 'Checking availability...';

  await refreshTimeSlots();

  // Auto-select the earliest currently-showing slot (refreshTimeSlots
  // already filters to genuinely free ones), same "New needs 2
  // consecutive slots for one doctor" logic as a normal click, since
  // Review defaults here but staff may switch to New before confirming.
  const firstSlotBtn = document.querySelector('#bm-time-slots-grid button');
  if (firstSlotBtn) {
    firstSlotBtn.click();
    document.getElementById('bm-walkin-status-detail').textContent = `Assigned: ${formatTime12h(state.selectedSlots[0])}`;
  } else {
    // No free slots at all -- refreshTimeSlots already rendered the
    // walk-in overbook option into #bm-time-slots-grid (hidden), so
    // surface that same option here in the visible status section
    // instead of leaving staff looking at an empty "Checking
    // availability..." message with no way to proceed.
    document.getElementById('bm-walkin-status-detail').innerHTML = `
      No free slots today -- fully booked.
      <button id="bm-walkin-override-btn" type="button" class="block mx-auto mt-2 bg-amber-500 hover:bg-amber-600 text-white font-bold px-4 py-2 rounded-xl text-xs transition">
        Book Anyway (Overbook Walk-In)
      </button>
    `;
    document.getElementById('bm-walkin-override-btn')?.addEventListener('click', () => {
      const overrideBtn = document.getElementById('bm-time-slots-grid').querySelector('#bm-override-slot-btn');
      overrideBtn?.click();
      if (state.selectedSlots[0]) {
        document.getElementById('bm-walkin-status-detail').textContent = `Overbooking: ${formatTime12h(state.selectedSlots[0])} (no free capacity)`;
      }
    });
  }
}

// Pre-fills the booking form from an existing appointment for Edit or
// Reschedule. `lockSlotOnly` distinguishes the two: Reschedule keeps
// patient/service fixed and focuses on date/time/doctor, while Edit
// keeps the same slot selected by default but leaves everything
// editable, including patient details. Both ultimately submit through
// the same update_appointment path (see submit handler below), which
// creates the replacement booking before removing the original.
function openEditOrReschedule(appt, isReschedule) {
  state.editingAppointmentId = appt.id;
  state.isReschedule = isReschedule;
  document.getElementById('bm-detail-modal').classList.add('hidden');
  openBookingOverlay();

  document.getElementById('bm-form-date').value = appt.slot_date;
  document.getElementById('bm-patient-name').value = appt.patients?.name || '';
  document.getElementById('bm-patient-phone').value = appt.patients?.phone || '';

  const serviceLabel = (appt.notes || '').split('|')[0].trim() || 'New';
  const knownType = ['New', 'Review'].includes(serviceLabel) ? serviceLabel : 'Procedure';
  const typeInput = document.querySelector(`input[name="bm-type"][value="${knownType}"]`);
  if (typeInput) {
    typeInput.checked = true;
    document.getElementById('bm-procedure-config').classList.toggle('hidden', knownType !== 'Procedure');
    if (knownType === 'Procedure') document.getElementById('bm-procedure-name').value = serviceLabel;
  }

  const doctorInput = document.querySelector(`input[name="bm-doctor"][value="${appt.doctor_id}"]`);
  if (doctorInput) doctorInput.checked = true;

  state.selectedSlots = appt._groupRows
    ? appt._groupRows.map((r) => r.slot_time.slice(0, 5))
    : [appt.slot_time.slice(0, 5)];

  const banner = document.getElementById('bm-edit-banner');
  banner.querySelector('span').textContent = isReschedule ? 'Rescheduling Appointment' : 'Editing Appointment';
  banner.classList.remove('hidden');

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
  state.isReschedule = false;
  state.isWalkIn = false;
  state.isOverbook = false;
  document.getElementById('bm-edit-banner').classList.add('hidden');
  document.getElementById('bm-booking-error').textContent = '';
  // Restore normal (non-walk-in) section visibility, since the same
  // overlay is reused for regular bookings, edit/reschedule, and
  // walk-ins -- without this, closing a walk-in booking would leave
  // the date/time sections hidden for the next normal booking too.
  document.getElementById('bm-form-date-section').classList.remove('hidden');
  document.getElementById('bm-time-slots-section').classList.remove('hidden');
  document.getElementById('bm-walkin-status-section').classList.add('hidden');
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
      // Only walk-ins get an override path here -- a normal future
      // booking with no free slots is a genuine scheduling conflict
      // that shouldn't be silently double-booked, but a walk-in
      // patient standing at the desk right now is a real situation
      // staff need a way to handle rather than turn away outright.
      if (state.isWalkIn) {
        grid.innerHTML = `
          <div class="col-span-3 text-center py-6">
            <p class="text-slate-500 text-sm mb-3">No free slots today -- fully booked.</p>
            <button id="bm-override-slot-btn" type="button" class="bg-amber-500 hover:bg-amber-600 text-white font-bold px-4 py-2.5 rounded-xl text-xs transition">
              Book Anyway (Overbook Walk-In)
            </button>
          </div>
        `;
        document.getElementById('bm-override-slot-btn').addEventListener('click', () => {
          state.isOverbook = true;
          // Falls back to the current time rounded to the nearest 15
          // min, and whichever doctor is currently selected (or the
          // first clinic doctor if "any" was chosen, since an
          // overbooked slot needs one specific doctor of record, not
          // an ambiguous "any").
          const now = new Date();
          const roundedMinutes = Math.round(now.getMinutes() / 15) * 15;
          const overrideTime = minutesToTime(now.getHours() * 60 + roundedMinutes);
          state.selectedSlots = [overrideTime];
          if (doctorEl.value === 'any') {
            const specificDoctor = document.querySelector('input[name="bm-doctor"]:not([value="any"])');
            if (specificDoctor) specificDoctor.checked = true;
          }
          updateDurationLabel();
          renderOverbookNotice(overrideTime);
        });
      } else {
        grid.innerHTML = '<p class="col-span-3 text-slate-400 text-sm text-center py-6">No available slots for this date.</p>';
      }
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

// Shows the overbook slot that was just auto-picked (current time,
// rounded to the nearest 15 min) after staff confirms they want to
// book anyway despite no free capacity. Lets them switch to a
// different doctor -- since the override always lands on whichever
// doctor happened to be selected, or the first one if "any" -- without
// re-running the full availability check (there's deliberately no
// "free" slot to re-check against here).
function renderOverbookNotice(overrideTime) {
  const grid = document.getElementById('bm-time-slots-grid');
  const currentDoctor = document.querySelector('input[name="bm-doctor"]:checked');
  grid.innerHTML = `
    <div class="col-span-3 bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
      <p class="text-amber-800 font-bold text-sm mb-1">⚠ Overbooking ${formatTime12h(overrideTime)}</p>
      <p class="text-amber-700 text-xs">This slot is already at capacity for ${CLINIC_DOCTORS.find((d) => d.id === currentDoctor?.value)?.name || 'the selected doctor'}. Booking will proceed anyway and is flagged in the notes.</p>
    </div>
  `;
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

document.getElementById('bm-cancel-edit').addEventListener('click', () => {
  closeBookingOverlay();
});

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
  const isEditing = !!state.editingAppointmentId;
  btn.disabled = true;
  btn.textContent = isEditing ? 'Saving...' : 'Booking...';

  try {
    const payload = {
      patientName,
      patientPhone,
      doctorId: doctorEl.value,
      date: dateVal,
      slots: state.selectedSlots.sort(),
      appointmentType,
      notes: `${appointmentType} | Booked via Bookings Manager${state.isWalkIn ? ' (Walk-In)' : ''}${state.isOverbook ? ' (OVERBOOKED - no free capacity)' : ''}`,
      allowOverbook: state.isOverbook,
    };
    if (isEditing) {
      payload.originalAppointmentId = state.editingAppointmentId;
      payload.isReschedule = !!state.isReschedule;
      await callFunction('update_appointment', payload);
    } else {
      await callFunction('create_appointment', payload);
    }
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

// ---- Record Payment (categorized, split-mode, standalone-capable) ----
const CONSULTATION_PRICES = { new: 700, review: 600, free: 0 };
const CATEGORY_LABELS = { consultation: 'Consultation', pharmacy: 'Pharmacy', lab: 'Lab', vaccination: 'Vaccination', procedure: 'Procedure' };
let paymentContext = null; // { appointmentId, patientId, patientName } or null for standalone entry
let categoryLineAmounts = {}; // { consultation: { subtype: 'new', amount: 700 }, pharmacy: { amount: 250 }, ... }

let editingPaymentEntryId = null;

async function openPaymentModal(context) {
  paymentContext = context;
  editingPaymentEntryId = null;
  const isStandalone = !context;
  document.getElementById('bm-payment-patient-picker').classList.toggle('hidden', !isStandalone);
  document.getElementById('bm-payment-patient-name').textContent = isStandalone
    ? 'New payment entry'
    : `For ${context.patientName || 'this patient'}`;

  if (isStandalone) {
    document.getElementById('bm-payment-patient-phone').value = '';
    document.getElementById('bm-payment-patient-name-input').value = '';
    document.getElementById('bm-payment-phone-lookup-status').textContent = '';
  }

  // Default to just Consultation checked, matching the most common
  // single-category visit -- staff check additional boxes (pharmacy,
  // lab, etc.) for a visit spanning multiple categories at once.
  document.querySelectorAll('[data-category-checkbox]').forEach((el) => {
    el.checked = el.dataset.categoryCheckbox === 'consultation';
  });
  categoryLineAmounts = { consultation: { subtype: 'new', amount: CONSULTATION_PRICES.new } };
  splitRows = [{ mode: 'cash', amount: null }];
  document.getElementById('bm-payment-notes').value = '';
  document.getElementById('bm-payment-error').textContent = '';
  document.getElementById('bm-payment-modal').classList.remove('hidden');
  document.getElementById('bm-payment-save').textContent = 'Save';

  // If this appointment already has a payment recorded, load and
  // pre-fill it instead of the blank default above, so reopening the
  // modal shows what was actually entered and lets staff edit it in
  // place rather than accidentally creating a second, duplicate entry.
  if (context?.appointmentId) {
    try {
      const { payment } = await callFunction('get_payment_for_appointment', { appointmentId: context.appointmentId });
      if (payment) {
        editingPaymentEntryId = payment.id;
        document.getElementById('bm-payment-notes').value = payment.notes || '';
        document.getElementById('bm-payment-save').textContent = 'Update';

        categoryLineAmounts = {};
        document.querySelectorAll('[data-category-checkbox]').forEach((el) => (el.checked = false));
        (payment.payment_line_items || []).forEach((li) => {
          const checkbox = document.querySelector(`[data-category-checkbox="${li.category}"]`);
          if (checkbox) checkbox.checked = true;
          categoryLineAmounts[li.category] = li.category === 'consultation'
            ? { subtype: li.consultation_subtype, amount: Number(li.amount) }
            : { amount: Number(li.amount) };
        });

        splitRows = (payment.payment_splits || []).length > 0
          ? payment.payment_splits.map((s) => ({ mode: s.mode, amount: Number(s.amount) }))
          : [{ mode: 'cash', amount: null }];
      }
    } catch (err) {
      // Non-fatal -- if the lookup fails, just proceed with the blank
      // default rather than blocking the whole modal from opening.
      console.error('Could not load existing payment:', err);
    }
  }

  renderCategoryLines();
}

document.getElementById('bm-record-payment-btn').addEventListener('click', () => {
  const appt = state.currentDetailAppointment;
  if (!appt?.patient_id) return;
  openPaymentModal({ appointmentId: appt.id, patientId: appt.patient_id, patientName: appt.patients?.name });
});

document.getElementById('bm-fab-payment-only').addEventListener('click', () => openPaymentModal(null));

function closePaymentModal() {
  document.getElementById('bm-payment-modal').classList.add('hidden');
  paymentContext = null;
  editingPaymentEntryId = null;
}
document.getElementById('bm-payment-cancel').addEventListener('click', closePaymentModal);
document.getElementById('bm-payment-backdrop').addEventListener('click', closePaymentModal);

// Standalone entries need their own phone lookup (same debounced
// pattern as the booking form, but a separate listener/fields since
// this modal can be open independently of the booking overlay).
let paymentPhoneLookupTimeout = null;
document.getElementById('bm-payment-patient-phone').addEventListener('input', (e) => {
  clearTimeout(paymentPhoneLookupTimeout);
  const phone = e.target.value.trim();
  const statusEl = document.getElementById('bm-payment-phone-lookup-status');
  if (phone.replace(/\D/g, '').length < 10) {
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = 'Looking up...';
  statusEl.className = 'text-xs min-h-[1rem] mb-2 px-1 text-slate-400';
  paymentPhoneLookupTimeout = setTimeout(async () => {
    try {
      const result = await callFunction('lookup_patient_by_phone', { phone });
      if (result.found) {
        document.getElementById('bm-payment-patient-name-input').value = result.patient.name;
        statusEl.textContent = 'Existing patient found';
        statusEl.className = 'text-xs min-h-[1rem] mb-2 px-1 text-green-600 font-medium';
        paymentContext = { appointmentId: null, patientId: result.patient.id, patientName: result.patient.name };
      } else {
        statusEl.textContent = 'New patient (no match found) -- enter their name below';
        statusEl.className = 'text-xs min-h-[1rem] mb-2 px-1 text-slate-400';
        paymentContext = { appointmentId: null, patientId: null, patientName: null, newPatientPhone: phone };
      }
    } catch (err) {
      statusEl.textContent = '';
    }
  }, 500);
});

document.querySelectorAll('[data-category-checkbox]').forEach((el) => {
  el.addEventListener('change', () => {
    const category = el.dataset.categoryCheckbox;
    if (el.checked) {
      categoryLineAmounts[category] = category === 'consultation' ? { subtype: 'new', amount: CONSULTATION_PRICES.new } : { amount: null };
    } else {
      delete categoryLineAmounts[category];
    }
    renderCategoryLines();
  });
});

// Renders one block per checked category with its own amount input
// (consultation gets the New/Review/Free tiles instead of a free-typed
// amount, auto-filling and locking the price same as before). Grand
// total is the sum across all checked categories' amounts, and that's
// what the payment splits need to add up to.
function renderCategoryLines() {
  const container = document.getElementById('bm-payment-category-lines');
  container.innerHTML = '';

  Object.keys(categoryLineAmounts).forEach((category) => {
    const block = document.createElement('div');
    if (category === 'consultation') {
      const subtype = categoryLineAmounts.consultation.subtype;
      block.innerHTML = `
        <label class="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1 block">Consultation Type</label>
        <div class="grid grid-cols-3 gap-2">
          <label class="cursor-pointer">
            <input type="radio" name="bm-consult-subtype" value="new" class="peer sr-only" ${subtype === 'new' ? 'checked' : ''} />
            <div class="peer-checked:bg-brand-900 peer-checked:text-white text-center py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-bold transition">New<span class="block text-[10px] opacity-70 font-normal">₹700</span></div>
          </label>
          <label class="cursor-pointer">
            <input type="radio" name="bm-consult-subtype" value="review" class="peer sr-only" ${subtype === 'review' ? 'checked' : ''} />
            <div class="peer-checked:bg-brand-900 peer-checked:text-white text-center py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-bold transition">Review<span class="block text-[10px] opacity-70 font-normal">₹600</span></div>
          </label>
          <label class="cursor-pointer">
            <input type="radio" name="bm-consult-subtype" value="free" class="peer sr-only" ${subtype === 'free' ? 'checked' : ''} />
            <div class="peer-checked:bg-brand-900 peer-checked:text-white text-center py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-bold transition">Free<span class="block text-[10px] opacity-70 font-normal">₹0</span></div>
          </label>
        </div>
      `;
      container.appendChild(block);
      block.querySelectorAll('input[name="bm-consult-subtype"]').forEach((el) => {
        el.addEventListener('change', (e) => {
          categoryLineAmounts.consultation = { subtype: e.target.value, amount: CONSULTATION_PRICES[e.target.value] };
          renderSplitRows();
          updateGrandTotal();
        });
      });
    } else {
      const line = categoryLineAmounts[category];
      block.innerHTML = `
        <label class="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1 block">${CATEGORY_LABELS[category]} Amount (₹)</label>
        <input type="number" data-category-amount="${category}" min="0" step="1" value="${line.amount ?? ''}" placeholder="0" class="w-full text-base font-bold px-4 py-2.5 border border-slate-300 rounded-xl" />
      `;
      container.appendChild(block);
      block.querySelector(`[data-category-amount="${category}"]`).addEventListener('input', (e) => {
        categoryLineAmounts[category].amount = Number(e.target.value) || null;
        renderSplitRows();
        updateGrandTotal();
      });
    }
  });

  updateGrandTotal();
  renderSplitRows();
}

function getGrandTotal() {
  return Object.values(categoryLineAmounts).reduce((sum, line) => sum + (line.amount || 0), 0);
}

function updateGrandTotal() {
  document.getElementById('bm-payment-grand-total').textContent = `₹${getGrandTotal()}`;
}


// Split payment rows: each row is one { mode, amount } pair. Starts
// with exactly one row (the common case -- a single mode covering the
// full amount); "+ Split Payment" adds more for genuine splits.
let splitRows = [{ mode: 'cash', amount: null }];

function renderSplitRows() {
  const container = document.getElementById('bm-payment-splits-rows');
  const totalAmount = getGrandTotal();
  container.innerHTML = '';
  splitRows.forEach((row, idx) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'flex gap-2 items-center';
    rowEl.innerHTML = `
      <select data-split-mode="${idx}" class="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm">
        <option value="cash" ${row.mode === 'cash' ? 'selected' : ''}>Cash</option>
        <option value="upi" ${row.mode === 'upi' ? 'selected' : ''}>UPI</option>
        <option value="card" ${row.mode === 'card' ? 'selected' : ''}>Card</option>
        <option value="other" ${row.mode === 'other' ? 'selected' : ''}>Other</option>
      </select>
      <input data-split-amount="${idx}" type="number" min="1" step="1" value="${row.amount ?? ''}" placeholder="Amount" class="w-28 px-3 py-2 border border-slate-300 rounded-lg text-sm" />
      ${splitRows.length > 1 ? `<button data-remove-split="${idx}" class="text-red-500 text-xs font-bold px-1">✕</button>` : ''}
    `;
    container.appendChild(rowEl);
  });

  container.querySelectorAll('[data-split-mode]').forEach((el) => {
    el.addEventListener('change', (e) => {
      splitRows[Number(e.target.dataset.splitMode)].mode = e.target.value;
    });
  });
  container.querySelectorAll('[data-split-amount]').forEach((el) => {
    el.addEventListener('input', (e) => {
      splitRows[Number(e.target.dataset.splitAmount)].amount = Number(e.target.value) || null;
      updateSplitsRemainder();
    });
  });
  container.querySelectorAll('[data-remove-split]').forEach((el) => {
    el.addEventListener('click', (e) => {
      splitRows.splice(Number(e.target.dataset.removeSplit), 1);
      renderSplitRows();
      updateSplitsRemainder();
    });
  });

  // Auto-fill a single split row's amount to match the total, since
  // that's the common (non-split) case and shouldn't require re-typing
  // the same number twice.
  if (splitRows.length === 1 && totalAmount > 0) {
    splitRows[0].amount = totalAmount;
    const onlyAmountInput = container.querySelector('[data-split-amount="0"]');
    if (onlyAmountInput) onlyAmountInput.value = totalAmount;
  }
  updateSplitsRemainder();
}

function updateSplitsRemainder() {
  const totalAmount = getGrandTotal();
  const splitSum = splitRows.reduce((sum, r) => sum + (r.amount || 0), 0);
  const remainder = totalAmount - splitSum;
  const remainderEl = document.getElementById('bm-payment-splits-remainder');
  if (remainder === 0 && totalAmount > 0) {
    remainderEl.textContent = `✓ Splits match total (₹${totalAmount})`;
    remainderEl.className = 'text-xs text-green-600 font-medium mb-3';
  } else if (totalAmount > 0) {
    remainderEl.textContent = `Splits must add up to ₹${totalAmount} (currently ₹${splitSum}, ${remainder > 0 ? `₹${remainder} short` : `₹${Math.abs(remainder)} over`})`;
    remainderEl.className = 'text-xs text-amber-600 font-medium mb-3';
  } else {
    remainderEl.textContent = '';
  }
}

document.getElementById('bm-add-split-row').addEventListener('click', () => {
  splitRows.push({ mode: 'upi', amount: null });
  renderSplitRows();
});

document.getElementById('bm-payment-save').addEventListener('click', async () => {
  const errorEl = document.getElementById('bm-payment-error');
  errorEl.textContent = '';

  if (Object.keys(categoryLineAmounts).length === 0) {
    errorEl.textContent = 'Please select at least one category.';
    return;
  }

  // Build one line-item per checked category. A category (other than
  // a free consultation) needs a real amount entered -- catches the
  // case where a box was checked but the amount field was left blank.
  const lineItems = [];
  for (const [category, line] of Object.entries(categoryLineAmounts)) {
    if (category === 'consultation') {
      lineItems.push({ category, consultationSubtype: line.subtype, amount: line.amount });
    } else {
      if (!line.amount || line.amount <= 0) {
        errorEl.textContent = `Please enter a valid amount for ${CATEGORY_LABELS[category]}.`;
        return;
      }
      lineItems.push({ category, amount: line.amount });
    }
  }

  const grandTotal = getGrandTotal();
  const isEntirelyFree = grandTotal === 0;

  // Resolve the patient: either the existing appointment context, an
  // already-found standalone patient, or a brand new one to create.
  let patientId = paymentContext?.patientId || null;
  if (!patientId) {
    const nameInput = document.getElementById('bm-payment-patient-name-input');
    const phoneInput = document.getElementById('bm-payment-patient-phone');
    if (!nameInput.value.trim()) {
      errorEl.textContent = 'Please enter the patient name.';
      return;
    }
    paymentContext = {
      ...paymentContext,
      newPatientName: nameInput.value.trim(),
      newPatientPhone: phoneInput.value.trim(),
    };
  }

  if (!isEntirelyFree && splitRows.some((r) => !r.amount || r.amount <= 0)) {
    errorEl.textContent = 'Please enter a valid amount for every payment row.';
    return;
  }
  const splitSum = splitRows.reduce((sum, r) => sum + (r.amount || 0), 0);
  if (!isEntirelyFree && Math.abs(splitSum - grandTotal) > 0.01) {
    errorEl.textContent = `Payment splits (₹${splitSum}) must add up to the total (₹${grandTotal}).`;
    return;
  }

  const btn = document.getElementById('bm-payment-save');
  btn.disabled = true;
  btn.textContent = editingPaymentEntryId ? 'Updating...' : 'Saving...';
  try {
    const finalSplits = isEntirelyFree ? [] : splitRows.map((r) => ({ mode: r.mode, amount: r.amount }));
    const notes = document.getElementById('bm-payment-notes').value.trim();
    if (editingPaymentEntryId) {
      await callFunction('update_payment', {
        paymentEntryId: editingPaymentEntryId,
        lineItems,
        splits: finalSplits,
        notes,
      });
    } else {
      await callFunction('record_payment', {
        appointment_id: paymentContext?.appointmentId || null,
        patient_id: patientId,
        new_patient_name: paymentContext?.newPatientName || null,
        new_patient_phone: paymentContext?.newPatientPhone || null,
        lineItems,
        splits: finalSplits,
        notes,
      });
    }
    closePaymentModal();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = editingPaymentEntryId ? 'Update' : 'Save';
  }
});

// ---- Day Close / Cash Reconciliation ----
document.getElementById('bm-open-dayclose').addEventListener('click', () => {
  document.getElementById('bm-dayclose-overlay').classList.remove('hidden');
  document.getElementById('bm-dayclose-overlay').classList.add('flex');
  document.getElementById('bm-dayclose-date').value = todayStr();
  document.getElementById('bm-reconciliation-result').classList.add('hidden');
  loadDayClose(todayStr());
  loadCashSession(todayStr());
});
document.getElementById('bm-close-dayclose').addEventListener('click', () => {
  document.getElementById('bm-dayclose-overlay').classList.add('hidden');
  document.getElementById('bm-dayclose-overlay').classList.remove('flex');
});
document.getElementById('bm-dayclose-date').addEventListener('change', (e) => {
  document.getElementById('bm-reconciliation-result').classList.add('hidden');
  loadDayClose(e.target.value);
  loadCashSession(e.target.value);
});

let currentDayClosePayments = [];
let currentDayCloseExpenses = [];

async function loadDayClose(date) {
  const totalsEl = document.getElementById('bm-dayclose-totals');
  const listEl = document.getElementById('bm-dayclose-list');
  totalsEl.innerHTML = '<p class="text-slate-400 text-sm">Loading...</p>';
  listEl.innerHTML = '<p class="text-slate-400 text-sm">Loading...</p>';
  try {
    const [{ payments }, { expenses }] = await Promise.all([
      callFunction('list_payments_for_date', { date }),
      callFunction('list_expenses_for_date', { date }),
    ]);
    currentDayClosePayments = payments;
    currentDayCloseExpenses = expenses;

    // Totals by mode, computed from each payment's splits (a split
    // payment contributes to more than one mode's total). Totals by
    // category computed from each payment's line-items, since one
    // payment event can now span multiple categories.
    const totalsByMode = { cash: 0, upi: 0, card: 0, other: 0 };
    const totalsByCategory = { consultation: 0, pharmacy: 0, lab: 0, vaccination: 0, procedure: 0 };
    payments.forEach((p) => {
      (p.payment_line_items || []).forEach((li) => {
        totalsByCategory[li.category] = (totalsByCategory[li.category] || 0) + Number(li.amount);
      });
      (p.payment_splits || []).forEach((s) => {
        totalsByMode[s.mode] = (totalsByMode[s.mode] || 0) + Number(s.amount);
      });
    });
    const grandTotal = Object.values(totalsByCategory).reduce((sum, v) => sum + v, 0);
    const expensesTotal = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

    const modeLabels = { cash: 'Cash', upi: 'UPI', card: 'Card', other: 'Other' };
    const categoryLabels = { consultation: 'Consultation', pharmacy: 'Pharmacy', lab: 'Lab', vaccination: 'Vaccination', procedure: 'Procedure' };

    totalsEl.innerHTML = `
      <div class="grid grid-cols-2 gap-x-6 gap-y-1 mb-3 pb-3 border-b border-slate-100">
        <div>
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">By Mode</p>
          ${Object.entries(modeLabels).map(([mode, label]) => `
            <div class="flex justify-between text-sm py-0.5"><span class="text-slate-600">${label}</span><span class="font-semibold text-slate-800">₹${totalsByMode[mode].toFixed(2)}</span></div>
          `).join('')}
        </div>
        <div>
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">By Category</p>
          ${Object.entries(categoryLabels).map(([cat, label]) => `
            <div class="flex justify-between text-sm py-0.5"><span class="text-slate-600">${label}</span><span class="font-semibold text-slate-800">₹${totalsByCategory[cat].toFixed(2)}</span></div>
          `).join('')}
        </div>
      </div>
      <div class="flex justify-between items-center py-1">
        <span class="text-sm font-bold text-slate-900">Total Collected</span>
        <span class="font-extrabold text-lg text-slate-900">₹${grandTotal.toFixed(2)}</span>
      </div>
      <div class="flex justify-between items-center py-1">
        <span class="text-sm font-bold text-red-600">Total Expenses</span>
        <span class="font-bold text-red-600">− ₹${expensesTotal.toFixed(2)}</span>
      </div>
    `;

    // ---- Reconciliation table ----
    if (payments.length === 0) {
      listEl.innerHTML = '<p class="text-slate-400 text-sm">No payments recorded for this date.</p>';
    } else {
      const modeSummary = (splits) => (splits || []).map((s) => `${modeLabels[s.mode]} ₹${Number(s.amount).toFixed(0)}`).join(' + ');
      listEl.innerHTML = `
        <div class="overflow-x-auto -mx-5 px-5">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide border-b border-slate-200">
                <th class="py-2 pr-2">Time</th>
                <th class="py-2 pr-2">Patient</th>
                <th class="py-2 pr-2">Category</th>
                <th class="py-2 pr-2">Mode</th>
                <th class="py-2 pr-2 text-right">Amount</th>
                <th class="py-2 pr-2">Staff</th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              ${payments.map((p) => {
                const time = new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const categoryDisplay = (p.payment_line_items || [])
                  .map((li) => (li.category === 'consultation' ? `Consultation (${li.consultation_subtype})` : categoryLabels[li.category]))
                  .join(', ') || 'Unknown';
                return `
                  <tr class="border-b border-slate-50">
                    <td class="py-2 pr-2 whitespace-nowrap text-slate-500">${time}</td>
                    <td class="py-2 pr-2 font-medium text-slate-800">${p.patients?.name || 'Unknown'}</td>
                    <td class="py-2 pr-2 text-slate-600">${categoryDisplay}</td>
                    <td class="py-2 pr-2 text-slate-500 text-xs">${modeSummary(p.payment_splits) || '—'}</td>
                    <td class="py-2 pr-2 text-right font-bold text-slate-900">₹${Number(p.total_amount).toFixed(2)}</td>
                    <td class="py-2 pr-2 text-slate-400 text-xs">${p.collected_by_profile?.full_name || 'Staff'}</td>
                    <td class="py-2"><button data-delete-payment="${p.id}" class="text-red-500 text-xs font-bold">✕</button></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
      listEl.querySelectorAll('[data-delete-payment]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this payment entry?')) return;
          await callFunction('delete_payment', { id: btn.dataset.deletePayment });
          loadDayClose(date);
        });
      });
    }

    renderExpensesList(date);
  } catch (err) {
    totalsEl.innerHTML = `<p class="text-red-600 text-sm">${err.message}</p>`;
    listEl.innerHTML = '';
  }
}

// ---- Expenses ----
function renderExpensesList(date) {
  const listEl = document.getElementById('bm-expenses-list');
  if (currentDayCloseExpenses.length === 0) {
    listEl.innerHTML = '<p class="text-slate-400 text-sm">No expenses recorded for this date.</p>';
    return;
  }
  const categoryLabels = { bank_deposit: 'Bank Deposit', handed_to_doctor: 'Handed to Doctor', petty_expense: 'Petty Expense', other: 'Other' };
  listEl.innerHTML = '';
  currentDayCloseExpenses.forEach((e) => {
    const time = new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const row = document.createElement('div');
    row.className = 'flex justify-between items-center py-2 border-b border-slate-100 last:border-0';
    row.innerHTML = `
      <div>
        <p class="text-sm font-semibold text-slate-800">${categoryLabels[e.category]}${e.notes ? ` — ${e.notes}` : ''}</p>
        <p class="text-xs text-slate-400">${time} · by ${e.recorded_by_profile?.full_name || 'Staff'}</p>
      </div>
      <div class="flex items-center gap-2">
        <span class="font-bold text-red-600">₹${Number(e.amount).toFixed(2)}</span>
        <button data-delete-expense="${e.id}" class="text-red-500 text-xs font-bold">✕</button>
      </div>
    `;
    row.querySelector('[data-delete-expense]').addEventListener('click', async () => {
      if (!confirm('Delete this expense entry?')) return;
      await callFunction('delete_expense', { id: e.id });
      loadDayClose(date);
    });
    listEl.appendChild(row);
  });
}

document.getElementById('bm-add-expense').addEventListener('click', async () => {
  const errorEl = document.getElementById('bm-expense-error');
  const amount = document.getElementById('bm-expense-amount').value;
  const date = document.getElementById('bm-dayclose-date').value;
  if (!amount || Number(amount) <= 0) {
    errorEl.textContent = 'Please enter a valid amount.';
    return;
  }
  errorEl.textContent = '';
  try {
    await callFunction('record_expense', {
      category: document.getElementById('bm-expense-category').value,
      amount,
      notes: document.getElementById('bm-expense-notes').value.trim(),
    });
    document.getElementById('bm-expense-amount').value = '';
    document.getElementById('bm-expense-notes').value = '';
    loadDayClose(date);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---- Cash Session (opening / mid-day recount / closing) ----
function denomTotal(prefix) {
  const c50 = Number(document.getElementById(`bm-${prefix}-50`).value) || 0;
  const c100 = Number(document.getElementById(`bm-${prefix}-100`).value) || 0;
  const c200 = Number(document.getElementById(`bm-${prefix}-200`).value) || 0;
  const c500 = Number(document.getElementById(`bm-${prefix}-500`).value) || 0;
  return c50 * 50 + c100 * 100 + c200 * 200 + c500 * 500;
}

['open', 'recount', 'close'].forEach((prefix) => {
  ['50', '100', '200', '500'].forEach((denom) => {
    document.getElementById(`bm-${prefix}-${denom}`).addEventListener('input', () => {
      const totalId = prefix === 'open' ? 'bm-opening-total' : prefix === 'recount' ? 'bm-recount-total' : 'bm-closing-total';
      document.getElementById(totalId).textContent = `Total: ₹${denomTotal(prefix).toFixed(2)}`;
    });
  });
});

async function loadCashSession(date) {
  const cashErrorEl = document.getElementById('bm-cash-error');
  cashErrorEl.textContent = '';
  document.getElementById('bm-reconciliation-result').classList.add('hidden');
  // Reset all denomination inputs for the newly selected date -- these
  // are per-day counts, not something that should carry over visually
  // when switching dates.
  ['open', 'recount', 'close'].forEach((prefix) => {
    ['50', '100', '200', '500'].forEach((denom) => (document.getElementById(`bm-${prefix}-${denom}`).value = ''));
  });
  document.getElementById('bm-opening-total').textContent = 'Total: ₹0';
  document.getElementById('bm-recount-total').textContent = 'Total: ₹0';
  document.getElementById('bm-closing-total').textContent = 'Total: ₹0';

  try {
    const { session, previousClosingTotal } = await callFunction('get_cash_session', { date });

    const statusEl = document.getElementById('bm-opening-status');
    const prevNoticeEl = document.getElementById('bm-prev-closing-notice');
    if (session?.opening_total != null) {
      statusEl.textContent = 'Recorded';
      statusEl.className = 'text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700';
      document.getElementById('bm-open-50').value = session.opening_count_50;
      document.getElementById('bm-open-100').value = session.opening_count_100;
      document.getElementById('bm-open-200').value = session.opening_count_200;
      document.getElementById('bm-open-500').value = session.opening_count_500;
      document.getElementById('bm-opening-total').textContent = `Total: ₹${Number(session.opening_total).toFixed(2)}`;
    } else {
      statusEl.textContent = 'Not yet recorded';
      statusEl.className = 'text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700';
    }

    if (previousClosingTotal != null) {
      const openingVal = session?.opening_total ?? null;
      const matches = openingVal != null && Math.abs(Number(openingVal) - Number(previousClosingTotal)) < 0.01;
      prevNoticeEl.classList.remove('hidden');
      if (openingVal == null) {
        prevNoticeEl.className = 'text-xs mb-3 p-2.5 rounded-lg bg-slate-50 text-slate-500';
        prevNoticeEl.textContent = `Previous day closed with ₹${Number(previousClosingTotal).toFixed(2)} -- opening count for today should match this.`;
      } else if (matches) {
        prevNoticeEl.className = 'text-xs mb-3 p-2.5 rounded-lg bg-green-50 text-green-700';
        prevNoticeEl.textContent = `✓ Matches previous day's closing (₹${Number(previousClosingTotal).toFixed(2)})`;
      } else {
        prevNoticeEl.className = 'text-xs mb-3 p-2.5 rounded-lg bg-red-50 text-red-700';
        prevNoticeEl.textContent = `⚠ Does not match previous day's closing (₹${Number(previousClosingTotal).toFixed(2)}) -- till may not have been reconciled properly.`;
      }
    } else {
      prevNoticeEl.classList.add('hidden');
    }

    if (session?.closing_total != null) {
      document.getElementById('bm-close-50').value = session.closing_count_50;
      document.getElementById('bm-close-100').value = session.closing_count_100;
      document.getElementById('bm-close-200').value = session.closing_count_200;
      document.getElementById('bm-close-500').value = session.closing_count_500;
      document.getElementById('bm-closing-total').textContent = `Total: ₹${Number(session.closing_total).toFixed(2)}`;
      showReconciliationResult(Number(session.discrepancy), Number(session.expected_closing));
    }

    await loadCashRecounts(date);
  } catch (err) {
    cashErrorEl.textContent = err.message;
  }
}

function showReconciliationResult(discrepancy, expectedClosing) {
  const resultEl = document.getElementById('bm-reconciliation-result');
  resultEl.classList.remove('hidden');
  if (Math.abs(discrepancy) < 0.01) {
    resultEl.className = 'p-4 rounded-xl text-center font-bold bg-green-50 text-green-700';
    resultEl.textContent = `✓ Matches exactly. Expected: ₹${expectedClosing.toFixed(2)}`;
  } else if (discrepancy > 0) {
    resultEl.className = 'p-4 rounded-xl text-center font-bold bg-amber-50 text-amber-700';
    resultEl.textContent = `⚠ ₹${discrepancy.toFixed(2)} MORE than expected (expected ₹${expectedClosing.toFixed(2)})`;
  } else {
    resultEl.className = 'p-4 rounded-xl text-center font-bold bg-red-50 text-red-700';
    resultEl.textContent = `⚠ ₹${Math.abs(discrepancy).toFixed(2)} SHORT of expected (expected ₹${expectedClosing.toFixed(2)})`;
  }
}

document.getElementById('bm-save-opening').addEventListener('click', async () => {
  const date = document.getElementById('bm-dayclose-date').value;
  const cashErrorEl = document.getElementById('bm-cash-error');
  cashErrorEl.textContent = '';
  try {
    await callFunction('record_cash_opening', {
      date,
      count50: document.getElementById('bm-open-50').value,
      count100: document.getElementById('bm-open-100').value,
      count200: document.getElementById('bm-open-200').value,
      count500: document.getElementById('bm-open-500').value,
    });
    await loadCashSession(date);
  } catch (err) {
    cashErrorEl.textContent = err.message;
  }
});

document.getElementById('bm-save-closing').addEventListener('click', async () => {
  const date = document.getElementById('bm-dayclose-date').value;
  const cashErrorEl = document.getElementById('bm-cash-error');
  cashErrorEl.textContent = '';
  try {
    await callFunction('record_cash_closing', {
      date,
      count50: document.getElementById('bm-close-50').value,
      count100: document.getElementById('bm-close-100').value,
      count200: document.getElementById('bm-close-200').value,
      count500: document.getElementById('bm-close-500').value,
    });
    await loadCashSession(date);
  } catch (err) {
    cashErrorEl.textContent = err.message;
  }
});

document.getElementById('bm-save-recount').addEventListener('click', async () => {
  const date = document.getElementById('bm-dayclose-date').value;
  const cashErrorEl = document.getElementById('bm-cash-error');
  cashErrorEl.textContent = '';
  try {
    await callFunction('record_cash_recount', {
      date,
      count50: document.getElementById('bm-recount-50').value,
      count100: document.getElementById('bm-recount-100').value,
      count200: document.getElementById('bm-recount-200').value,
      count500: document.getElementById('bm-recount-500').value,
    });
    ['50', '100', '200', '500'].forEach((denom) => (document.getElementById(`bm-recount-${denom}`).value = ''));
    document.getElementById('bm-recount-total').textContent = 'Total: ₹0';
    await loadCashRecounts(date);
  } catch (err) {
    cashErrorEl.textContent = err.message;
  }
});

async function loadCashRecounts(date) {
  const listEl = document.getElementById('bm-recounts-list');
  try {
    const { recounts } = await callFunction('list_cash_recounts', { date });
    if (recounts.length === 0) {
      listEl.innerHTML = '';
      return;
    }
    listEl.innerHTML = recounts
      .map((r) => {
        const time = new Date(r.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div class="text-xs text-slate-500 py-1">${time} — ₹${Number(r.counted_total).toFixed(2)} (by ${r.recorded_by_profile?.full_name || 'Staff'})</div>`;
      })
      .join('');
  } catch (err) {
    listEl.innerHTML = '';
  }
}

// ---- Pending Registrations (self-registration approval) ----
document.getElementById('bm-open-registrations').addEventListener('click', () => {
  document.getElementById('bm-registrations-overlay').classList.remove('hidden');
  document.getElementById('bm-registrations-overlay').classList.add('flex');
  loadRegistrationRequests();
});
document.getElementById('bm-close-registrations').addEventListener('click', () => {
  document.getElementById('bm-registrations-overlay').classList.add('hidden');
  document.getElementById('bm-registrations-overlay').classList.remove('flex');
});

async function loadRegistrationRequests() {
  const listEl = document.getElementById('bm-registrations-list');
  listEl.innerHTML = '<p class="text-slate-400 text-sm text-center py-10">Loading...</p>';
  try {
    const { requests } = await callFunction('list_registration_requests', { status: 'pending' });
    if (requests.length === 0) {
      listEl.innerHTML = '<p class="text-slate-400 text-sm text-center py-10">No pending registrations.</p>';
      return;
    }
    listEl.innerHTML = '';
    requests.forEach((req) => {
      const submittedDate = new Date(req.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      const card = document.createElement('div');
      card.className = 'bg-white rounded-2xl p-4 shadow-sm border border-slate-200';
      const genderLabel = req.gender ? req.gender.charAt(0).toUpperCase() + req.gender.slice(1) : 'Not specified';
      card.innerHTML = `
        <div class="flex justify-between items-start mb-3">
          <div>
            <p class="font-bold text-slate-900">${req.name}</p>
            <p class="text-xs text-slate-400">Submitted ${submittedDate}</p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 text-sm mb-4">
          <div><span class="text-slate-400 text-xs block">Phone</span><span class="text-slate-700 font-medium">${req.phone || '—'}</span></div>
          <div><span class="text-slate-400 text-xs block">Date of Birth</span><span class="text-slate-700 font-medium">${req.dob || '—'}</span></div>
          <div><span class="text-slate-400 text-xs block">Gender</span><span class="text-slate-700 font-medium">${genderLabel}</span></div>
          <div><span class="text-slate-400 text-xs block">Address</span><span class="text-slate-700 font-medium">${req.address || '—'}</span></div>
        </div>
        <div class="flex gap-2">
          <button data-approve-request="${req.id}" class="flex-1 bg-green-100 hover:bg-green-200 text-green-800 font-bold py-2 rounded-xl text-sm transition">Approve</button>
          <button data-reject-request="${req.id}" class="flex-1 bg-red-50 hover:bg-red-100 text-red-700 font-bold py-2 rounded-xl text-sm border border-red-200 transition">Reject</button>
        </div>
      `;
      card.querySelector('[data-approve-request]').addEventListener('click', async () => {
        if (!confirm(`Approve registration for ${req.name}? This will create (or update) a real patient record.`)) return;
        try {
          await callFunction('approve_registration_request', { requestId: req.id });
          await loadRegistrationRequests();
          await updateRegistrationsBadge();
        } catch (err) {
          alert(err.message);
        }
      });
      card.querySelector('[data-reject-request]').addEventListener('click', async () => {
        const reason = prompt(`Reason for rejecting ${req.name}'s registration (optional):`);
        if (reason === null) return; // user cancelled the prompt
        try {
          await callFunction('reject_registration_request', { requestId: req.id, reason: reason || undefined });
          await loadRegistrationRequests();
          await updateRegistrationsBadge();
        } catch (err) {
          alert(err.message);
        }
      });
      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = `<p class="text-red-600 text-sm text-center py-10">${err.message}</p>`;
  }
}

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
