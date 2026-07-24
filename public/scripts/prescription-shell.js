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
  document.getElementById('rx-select-phone').value = '';
  document.getElementById('rx-select-status').textContent = '';
  document.getElementById('rx-select-found').classList.add('hidden');
  rxShellState.selectedPatient = null;
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

// ---- Patient lookup, reusing the same encrypted-patients phone
// lookup RPC already used by Bookings Manager (via bookings-manager.js,
// action lookup_patient_by_phone) -- called here through
// prescription-manager.js is NOT possible since that endpoint requires
// role='doctor' and rejects non-Rx actions; patient lookup instead
// goes through the SAME bookings-manager Netlify function, since
// looking up a patient by phone isn't itself a "clinical" action and
// bookings-manager.js already exposes it correctly. ----
let rxPhoneLookupTimeout = null;
document.getElementById('rx-select-phone').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 10);
  clearTimeout(rxPhoneLookupTimeout);
  const statusEl = document.getElementById('rx-select-status');
  const foundEl = document.getElementById('rx-select-found');
  foundEl.classList.add('hidden');
  rxShellState.selectedPatient = null;

  if (e.target.value.length !== 10) {
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = 'Looking up...';
  statusEl.className = 'text-xs mt-2 min-h-[1rem] text-slate-400';

  rxPhoneLookupTimeout = setTimeout(async () => {
    try {
      const response = await fetch('/.netlify/functions/bookings-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: rxShellState.session.access_token, action: 'lookup_patient_by_phone', data: { phone: e.target.value } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Lookup failed.');

      if (result.found) {
        rxShellState.selectedPatient = result.patient;
        statusEl.textContent = '';
        document.getElementById('rx-select-found-name').textContent = result.patient.name;
        document.getElementById('rx-select-found-demo').textContent = result.patient.phone;
        foundEl.classList.remove('hidden');
      } else {
        statusEl.textContent = 'No patient found with this phone number. Please register them first via Bookings Manager.';
        statusEl.className = 'text-xs mt-2 min-h-[1rem] text-amber-600';
      }
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'text-xs mt-2 min-h-[1rem] text-red-600';
    }
  }, 400);
});

document.getElementById('rx-select-confirm-btn').addEventListener('click', () => {
  if (!rxShellState.selectedPatient) return;
  showRxWorkspaceScreen();
  // Defined in prescription-app.js -- the ported Rx workspace itself,
  // which needs the doctor profile (for save attribution) and the
  // selected patient (to load their history/labs/photos).
  if (typeof window.mountPrescriptionWorkspace === 'function') {
    window.mountPrescriptionWorkspace(rxShellState.selectedPatient, rxShellState.profile);
  }
});

document.addEventListener('DOMContentLoaded', initRxAuth);
