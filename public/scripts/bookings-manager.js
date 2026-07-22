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

document.querySelectorAll('.bm-doctor-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.doctorFilter = btn.dataset.doctorFilter;
    document.querySelectorAll('.bm-doctor-filter-btn').forEach((b) => {
      b.classList.remove('bg-brand-900', 'text-white');
      b.classList.add('bg-slate-100', 'text-slate-600');
    });
    btn.classList.remove('bg-slate-100', 'text-slate-600');
    btn.classList.add('bg-brand-900', 'text-white');
    renderAppointmentFeed();
  });
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
  let list = state.appointments.filter((a) => a.status !== 'cancelled');
  if (state.doctorFilter !== 'all') list = list.filter((a) => a.doctor_id === state.doctorFilter);
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
    const card = document.createElement('div');
    card.className = `${statusColors[appt.status] || 'bg-slate-800'} text-white rounded-2xl p-4 shadow-sm cursor-pointer transition active:scale-[0.99]`;
    card.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <span class="font-mono font-bold text-lg">${formatTime12h(appt.slot_time)}</span>
        <span class="text-xs font-bold bg-white/20 px-2 py-1 rounded-full">${doctor ? doctor.short : '?'}</span>
      </div>
      <p class="font-bold text-base mb-1 truncate">${appt.patients?.name || 'Unknown patient'}</p>
      <p class="text-sm opacity-90">${serviceLabel}${appt.linked_group_id ? ' · Multi-slot' : ''}</p>
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
  document.getElementById('bm-detail-body').innerHTML = `
    <h3 class="text-xl font-bold text-slate-900 mb-1">${appt.patients?.name || 'Unknown patient'}</h3>
    <p class="text-sm text-slate-500 mb-4">${appt.patients?.phone || 'No phone on file'}</p>
    <div class="space-y-3">
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Time</span><span class="font-semibold text-slate-800">${formatTime12h(appt.slot_time)} · ${appt.slot_date}</span></div>
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Doctor</span><span class="font-semibold text-slate-800">${doctor ? doctor.name : 'Unknown'}</span></div>
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Service</span><span class="font-semibold text-slate-800">${serviceLabel}</span></div>
      <div class="bg-slate-50 p-3 rounded-xl"><span class="text-xs font-bold text-slate-400 uppercase block mb-1">Status</span><span class="font-semibold text-slate-800 capitalize">${appt.status.replace('_', ' ')}</span></div>
    </div>
  `;
  document.getElementById('bm-detail-modal').classList.remove('hidden');
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
  document.getElementById('bm-procedure-name').value = '';
  document.getElementById('bm-multi-slot-toggle').checked = false;
  document.querySelectorAll('input[name="bm-doctor"], input[name="bm-type"]').forEach((el) => (el.checked = false));
  document.getElementById('bm-procedure-config').classList.add('hidden');
  state.selectedSlots = [];
  state.editingAppointmentId = null;
  document.getElementById('bm-edit-banner').classList.add('hidden');
  document.getElementById('bm-booking-error').textContent = '';
}

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
