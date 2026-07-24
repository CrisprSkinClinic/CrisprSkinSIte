// public/scripts/prescription-shell.js
//
// Handles login, patient selection, and mounting/tearing-down the Rx
// workspace (prescription-app.js). Kept separate from the ported Rx
// app itself so the auth/patient-selection layer -- which is new,
// not part of the old Apps Script tool -- doesn't get tangled up with
// the large ported file.

const rxShellState = {
  session: null,
  profile: null,
  selectedPatient: null, // { id, name, phone, dob, gender }
};

let rxSupabaseClient = null;

// ---- API helper, shared with prescription-app.js via window ----
window.rxCallFunction = async function rxCallFunction(action, data = {}) {
  if (!rxShellState.session) throw new Error('Not signed in.');
  const response = await fetch('/.netlify/functions/prescription-manager', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: rxShellState.session.access_token, action, data }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
};

// Exposes the current session's access token for prescription-app.js's
// driveProxyUrl() helper -- direct <img>/<iframe> src attributes can't
// carry an Authorization header, so the token has to be embedded in
// the URL itself (see drive-file-proxy.js's header comment). Reading
// it fresh through this function each time (rather than prescription-app.js
// capturing rxShellState.session.access_token once) means a token
// refresh mid-session is picked up automatically.
window.rxGetCurrentAccessToken = function () {
  return rxShellState.session ? rxShellState.session.access_token : '';
};

// ---- Auth ----
async function initRxAuth() {
  if (typeof window.supabase === 'undefined' || !window.supabase) {
    showRxLoginScreen();
    document.getElementById('rx-login-error').textContent =
      'Could not load the Supabase library. Please check your internet connection and reload the page.';
    return;
  }
  if (!window.__RX_SUPABASE_URL__ || !window.__RX_SUPABASE_ANON_KEY__) {
    showRxLoginScreen();
    document.getElementById('rx-login-error').textContent =
      'This page is missing required configuration (Supabase URL/key). Contact the site administrator.';
    return;
  }

  rxSupabaseClient = window.supabase.createClient(window.__RX_SUPABASE_URL__, window.__RX_SUPABASE_ANON_KEY__);

  const { data: { session } } = await rxSupabaseClient.auth.getSession();
  if (session) {
    await onRxSignedIn(session);
  } else {
    showRxLoginScreen();
  }
}

async function onRxSignedIn(session) {
  rxShellState.session = session;
  try {
    const { profile } = await window.rxCallFunction('whoami');
    rxShellState.profile = profile;
    showRxPatientSelectScreen();
  } catch (err) {
    // whoami fails with 403 if the signed-in account isn't a doctor --
    // surface that clearly rather than a generic error, and sign them
    // back out so they're not stuck on a broken screen.
    await rxSupabaseClient.auth.signOut();
    showRxLoginScreen();
    document.getElementById('rx-login-error').textContent = err.message;
  }
}

function showRxLoginScreen() {
  document.getElementById('rx-login-screen').classList.remove('hidden');
  document.getElementById('rx-patient-select-screen').classList.add('hidden');
  document.getElementById('rx-workspace-screen').classList.add('hidden');
}

function showRxPatientSelectScreen() {
  document.getElementById('rx-login-screen').classList.add('hidden');
  document.getElementById('rx-patient-select-screen').classList.remove('hidden');
  document.getElementById('rx-workspace-screen').classList.add('hidden');
  document.getElementById('rx-patient-search').value = '';
  document.getElementById('rx-search-results').classList.add('hidden');
  document.getElementById('rx-landing-doctor-name').textContent = rxShellState.profile?.full_name || '';
  rxShellState.selectedPatient = null;
  loadRxDoctorQueue();
}

function showRxWorkspaceScreen() {
  document.getElementById('rx-login-screen').classList.add('hidden');
  document.getElementById('rx-patient-select-screen').classList.add('hidden');
  document.getElementById('rx-workspace-screen').classList.remove('hidden');
}

document.getElementById('rx-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('rx-login-error');
  const btn = document.getElementById('rx-login-btn');
  errorEl.textContent = '';
  const email = document.getElementById('rx-email').value.trim();
  const password = document.getElementById('rx-password').value;

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const { data, error } = await rxSupabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await onRxSignedIn(data.session);
  } catch (err) {
    errorEl.textContent = err.message || 'Sign in failed.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

document.getElementById('rx-signout-btn').addEventListener('click', async () => {
  await rxSupabaseClient.auth.signOut();
  rxShellState.session = null;
  rxShellState.profile = null;
  showRxLoginScreen();
});

// ---- Today's queue, replacing the old bare phone-number entry.
// Clicking a queue row or a search result both funnel into the same
// selectPatientAndEnterWorkspace() so there's exactly one path into
// the Rx workspace regardless of how the patient was found. ----
window.rxReloadQueue = loadRxDoctorQueue;
async function loadRxDoctorQueue() {
  const listEl = document.getElementById('rx-queue-list');
  const emptyEl = document.getElementById('rx-queue-empty');
  const loadingEl = document.getElementById('rx-queue-loading');
  const countEl = document.getElementById('rx-queue-count');

  listEl.innerHTML = '';
  emptyEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');

  if (!rxShellState.profile?.doctorId) {
    loadingEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    emptyEl.querySelector('p').textContent = 'Your account isn\'t linked to a doctor record yet -- contact the site administrator.';
    return;
  }

  try {
    const { queue } = await window.rxCallFunction('get_doctor_queue', { doctorId: rxShellState.profile.doctorId });
    loadingEl.classList.add('hidden');
    countEl.textContent = `${queue.length} ${queue.length === 1 ? 'patient' : 'patients'}`;

    if (!queue || queue.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }

    const statusColors = {
      booked: 'bg-champagne-100 text-brand-700',
      arrived: 'bg-blue-50 text-blue-700',
      seen: 'bg-green-50 text-green-700',
      complete: 'bg-slate-100 text-slate-500',
      no_show: 'bg-red-50 text-red-600',
    };

    listEl.innerHTML = queue.map((appt) => {
      const timeLabel = formatTime12h(appt.slot_time);
      const statusClass = statusColors[appt.status] || 'bg-slate-100 text-slate-500';
      return `
        <button class="w-full text-left bg-white border border-champagne-200 rounded-2xl p-4 flex items-center justify-between hover:border-brand-300 hover:shadow-md transition-all group"
                onclick="window.rxSelectPatientFromQueue('${appt.patient_id}', '${escapeAttr(appt.patient_name)}', '${appt.patient_phone || ''}', '${appt.patient_dob || ''}', '${appt.patient_gender || ''}')">
          <div class="flex items-center gap-4">
            <div class="w-11 h-11 rounded-xl bg-champagne-100 text-brand-700 font-bold flex items-center justify-center text-sm">
              ${timeLabel.replace(/[^0-9:]/g, '').split(':')[0]}
            </div>
            <div>
              <p class="font-bold text-brand-900 group-hover:text-brand-700 transition">${escapeHtmlShell(appt.patient_name || 'Patient')}</p>
              <p class="text-xs text-charcoal/50">${timeLabel} &middot; ${escapeHtmlShell(appt.notes || 'Consultation')}</p>
            </div>
          </div>
          <span class="text-xs font-semibold px-2.5 py-1 rounded-full ${statusClass} capitalize">${appt.status.replace('_', ' ')}</span>
        </button>`;
    }).join('');
  } catch (err) {
    loadingEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    emptyEl.querySelector('p').textContent = 'Error: ' + err.message;
  }
}

function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

function escapeHtmlShell(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return (text || '').replace(/'/g, "\\'");
}

// Called from the inline onclick handlers built above (queue rows)
window.rxSelectPatientFromQueue = function (id, name, phone, dob, gender) {
  selectPatientAndEnterWorkspace({ id, name, phone, dob: dob || null, gender: gender || null });
};

function selectPatientAndEnterWorkspace(patient) {
  rxShellState.selectedPatient = patient;
  showRxWorkspaceScreen();
  if (typeof window.mountPrescriptionWorkspace === 'function') {
    window.mountPrescriptionWorkspace(patient, rxShellState.profile);
  }
}

// ---- Search: any patient by name or phone, via search_patients
// (through prescription-manager.js -- unlike the old phone-only
// version, this doesn't need to cross-call bookings-manager.js since
// search_patients handles both name and phone lookups itself). ----
let rxSearchTimeout = null;
document.getElementById('rx-patient-search').addEventListener('input', (e) => {
  clearTimeout(rxSearchTimeout);
  const query = e.target.value.trim();
  const resultsEl = document.getElementById('rx-search-results');

  if (query.length < 2) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }

  rxSearchTimeout = setTimeout(async () => {
    try {
      const { patients } = await window.rxCallFunction('search_patients', { query });
      if (!patients || patients.length === 0) {
        resultsEl.innerHTML = '<div class="p-4 text-sm text-charcoal/40 text-center">No matching patients found.</div>';
        resultsEl.classList.remove('hidden');
        return;
      }
      resultsEl.innerHTML = patients.map((p) => `
        <button class="w-full text-left px-4 py-3 hover:bg-champagne-50 transition flex items-center justify-between"
                onclick="window.rxSelectPatientFromQueue('${p.id}', '${escapeAttr(p.name)}', '${p.phone || ''}', '${p.dob || ''}', '${p.gender || ''}')">
          <div>
            <p class="font-semibold text-brand-900 text-sm">${escapeHtmlShell(p.name || 'Patient')}</p>
            <p class="text-xs text-charcoal/50">${p.phone || 'No phone on file'}</p>
          </div>
          <span class="text-xs text-charcoal/40">${p.gender || ''}</span>
        </button>`).join('');
      resultsEl.classList.remove('hidden');
    } catch (err) {
      resultsEl.innerHTML = `<div class="p-4 text-sm text-red-600">${err.message}</div>`;
      resultsEl.classList.remove('hidden');
    }
  }, 350);
});

document.addEventListener('DOMContentLoaded', initRxAuth);
