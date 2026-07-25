// public/scripts/pharmacy-app.js
// v2 visual rebuild. Every backend action call is unchanged from the
// working v5 build (see the list at the bottom of this comment block
// for the full audit trail) -- this pass only changes how things are
// rendered and how the user is notified of results/errors.
//
// Backend actions used (unchanged): whoami, list_suppliers,
// upsert_supplier, list_medicines, upsert_medicine, get_inventory,
// get_low_stock, get_expiring_batches, get_fifo_batches,
// create_purchase_order, receive_purchase_order, list_purchase_orders,
// execute_pharmacy_sale, void_pharmacy_sale, get_medicines_with_wac,
// list_pending_approvals, create_pending_approval,
// reject_pending_approval, commit_reviewed_invoice,
// run_physical_audit, get_predictive_reorder, list_medical_reps,
// upsert_medical_rep, extract_invoice_from_image

const phState = {
  session: null,
  profile: null,
  cart: [],
  selectedMedicine: null,
  recentSales: [],
};

let phSupabaseClient = null;

// ==========================================================
// TOAST + CONFIRM INFRASTRUCTURE (replaces alert/confirm/prompt)
// ==========================================================
function showPhToast(message, type = 'success') {
  const container = document.getElementById('ph-toast-container');
  const colors = {
    success: 'bg-brand-900 text-white',
    error: 'bg-red-600 text-white',
    info: 'bg-white text-brand-900 border border-champagne-300',
  };
  const icons = {
    success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  };
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-semibold max-w-sm ${colors[type]}`;
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(8px)';
  toast.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
  toast.innerHTML = `${icons[type]}<span>${escapePhHtml(message)}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    toast.style.transition = 'opacity 0.2s, transform 0.2s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}

function showPhConfirm(title, message, { danger = true } = {}) {
  return new Promise((resolve) => {
    document.getElementById('ph-confirm-title').textContent = title;
    document.getElementById('ph-confirm-message').textContent = message;
    const okBtn = document.getElementById('ph-confirm-ok');
    const cancelBtn = document.getElementById('ph-confirm-cancel');
    const iconWrap = document.getElementById('ph-confirm-icon');
    okBtn.className = danger
      ? 'flex-1 bg-red-600 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-red-700 transition'
      : 'flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition';
    iconWrap.className = danger
      ? 'w-11 h-11 rounded-full bg-red-50 text-red-600 flex items-center justify-center mb-4'
      : 'w-11 h-11 rounded-full bg-champagne-100 text-brand-700 flex items-center justify-center mb-4';

    const backdrop = document.getElementById('ph-confirm-backdrop');
    backdrop.classList.remove('hidden');

    const cleanup = (result) => {
      backdrop.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// A small in-flow text-prompt replacement for the one genuine prompt()
// use (payment mode when receiving a PO) -- rendered as a tiny inline
// modal rather than a browser prompt, matching the design system.
function showPhTextPrompt(title, { placeholder = '', defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    showPhModal(`
      <div class="p-6">
        <h3 class="text-lg font-bold text-brand-900 mb-4">${escapePhHtml(title)}</h3>
        <input type="text" id="ph-text-prompt-input" value="${escapePhAttr(defaultValue)}" placeholder="${escapePhAttr(placeholder)}"
               class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm mb-4" />
        <div class="flex gap-2">
          <button id="ph-text-prompt-cancel" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
          <button id="ph-text-prompt-ok" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Continue</button>
        </div>
      </div>`);
    const input = document.getElementById('ph-text-prompt-input');
    input.focus();
    document.getElementById('ph-text-prompt-ok').addEventListener('click', () => {
      const val = input.value.trim();
      closePhModal();
      resolve(val || null);
    });
    document.getElementById('ph-text-prompt-cancel').addEventListener('click', () => {
      closePhModal();
      resolve(null);
    });
  });
}

// ==========================================================
// STATUS CHIP HELPERS
// ==========================================================
function stockChip(total, reorderLevel) {
  if (total <= 0) return `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700">Out of stock</span>`;
  if (total <= reorderLevel) return `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">Low · ${total}</span>`;
  return `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">In stock · ${total}</span>`;
}

function expiryChip(expiryDate) {
  if (!expiryDate) return '';
  const days = Math.floor((new Date(expiryDate) - new Date()) / 86400000);
  if (days < 0) return `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700">Expired</span>`;
  if (days <= 90) return `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">Expires in ${days}d</span>`;
  return `<span class="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-champagne-100 text-charcoal/60">Exp ${expiryDate}</span>`;
}

function paymentStatusChip(status) {
  const map = {
    paid: 'bg-emerald-50 text-emerald-700',
    partial: 'bg-amber-50 text-amber-700',
    pending: 'bg-champagne-100 text-brand-700',
  };
  return `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full capitalize ${map[status] || 'bg-slate-100 text-slate-600'}">${escapePhHtml(status || '')}</span>`;
}

function statCard(label, value, icon, tone = 'neutral') {
  const toneClasses = {
    neutral: 'bg-white border-champagne-200',
    warn: 'bg-amber-50 border-amber-100',
    danger: 'bg-red-50 border-red-100',
    good: 'bg-emerald-50 border-emerald-100',
  };
  return `
    <div class="rounded-2xl border ${toneClasses[tone]} p-4 shadow-sm">
      <div class="flex items-center justify-between mb-1.5">
        <span class="text-[11px] font-bold uppercase tracking-wide text-charcoal/40">${escapePhHtml(label)}</span>
        <span class="text-charcoal/30">${icon}</span>
      </div>
      <p class="text-2xl font-bold text-brand-900 tabular-nums leading-none">${value}</p>
    </div>`;
}

const ICONS = {
  cart: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
  box: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  alert: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  receipt: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><line x1="8" x2="16" y1="7" y2="7"/><line x1="8" x2="16" y1="11" y2="11"/><line x1="8" x2="12" y1="15" y2="15"/></svg>',
  rupee: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3c3 0 6-1 6-5"/></svg>',
};

function emptyState(message, icon = ICONS.box) {
  return `<div class="flex flex-col items-center justify-center py-14 text-center">
    <div class="w-11 h-11 rounded-full bg-champagne-100 text-charcoal/30 flex items-center justify-center mb-3">${icon}</div>
    <p class="text-charcoal/40 text-sm max-w-xs">${escapePhHtml(message)}</p>
  </div>`;
}

function skeletonRows(n = 3) {
  return Array.from({ length: n }).map(() => `
    <div class="px-5 py-4 animate-pulse">
      <div class="h-3.5 bg-champagne-100 rounded w-1/3 mb-2"></div>
      <div class="h-3 bg-champagne-100 rounded w-1/2"></div>
    </div>`).join('');
}

// ---- API helper ----
window.phCallFunction = async function phCallFunction(action, data = {}) {
  if (!phState.session) throw new Error('Not signed in.');
  const response = await fetch('/.netlify/functions/pharmacy-manager', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: phState.session.access_token, action, data }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
};

// ---- Auth ----
async function initPhAuth() {
  if (typeof window.supabase === 'undefined' || !window.supabase) {
    showPhLoginScreen();
    document.getElementById('ph-login-error').textContent =
      'Could not load the Supabase library. Please check your internet connection and reload the page.';
    return;
  }
  if (!window.__PH_SUPABASE_URL__ || !window.__PH_SUPABASE_ANON_KEY__) {
    showPhLoginScreen();
    document.getElementById('ph-login-error').textContent =
      'This page is missing required configuration (Supabase URL/key). Contact the site administrator.';
    return;
  }

  phSupabaseClient = window.supabase.createClient(window.__PH_SUPABASE_URL__, window.__PH_SUPABASE_ANON_KEY__);

  const { data: { session } } = await phSupabaseClient.auth.getSession();
  if (session) {
    await onPhSignedIn(session);
  } else {
    showPhLoginScreen();
  }
}

async function onPhSignedIn(session) {
  phState.session = session;
  try {
    const { profile } = await window.phCallFunction('whoami');
    phState.profile = profile;
    showPhAppScreen();
  } catch (err) {
    await phSupabaseClient.auth.signOut();
    showPhLoginScreen();
    document.getElementById('ph-login-error').textContent = err.message;
  }
}

function showPhLoginScreen() {
  document.getElementById('ph-login-screen').classList.remove('hidden');
  document.getElementById('ph-app-screen').classList.add('hidden');
}

function showPhAppScreen() {
  document.getElementById('ph-login-screen').classList.add('hidden');
  document.getElementById('ph-app-screen').classList.remove('hidden');
  const fullName = phState.profile?.full_name || '';
  document.getElementById('ph-user-name-primary').textContent = fullName;
  document.getElementById('ph-user-name-role').textContent = phState.profile?.role || '';
  document.getElementById('ph-user-avatar').textContent = fullName ? fullName.trim()[0].toUpperCase() : '–';
  switchPhTab('checkout');
  refreshPhBadges();
}

document.getElementById('ph-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('ph-login-error');
  const btn = document.getElementById('ph-login-btn');
  errorEl.textContent = '';
  const email = document.getElementById('ph-email').value.trim();
  const password = document.getElementById('ph-password').value;

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const { data, error } = await phSupabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await onPhSignedIn(data.session);
  } catch (err) {
    errorEl.textContent = err.message || 'Sign in failed.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

document.getElementById('ph-signout-btn').addEventListener('click', async () => {
  await phSupabaseClient.auth.signOut();
  phState.session = null;
  phState.profile = null;
  showPhLoginScreen();
});

// ---- Sidebar navigation ----
function switchPhTab(tab) {
  document.querySelectorAll('.ph-tab-panel').forEach((el) => el.classList.add('hidden'));
  document.getElementById(`ph-tab-${tab}`).classList.remove('hidden');
  document.querySelectorAll('.ph-tab-btn').forEach((el) => {
    const active = el.dataset.phTab === tab;
    el.classList.toggle('bg-brand-900', active);
    el.classList.toggle('text-white', active);
    el.classList.toggle('text-charcoal/60', !active);
    el.classList.toggle('hover:bg-champagne-50', !active);
  });
  if (tab === 'checkout') loadPhCheckoutStats();
  if (tab === 'inventory') { loadPhInventoryStats(); loadPhInventory('all'); }
  if (tab === 'purchasing') { loadPhPoStats(); loadPhPurchaseOrders(); }
  if (tab === 'reconcile') switchPhRecView('invoices');
  closeMobileSidebar();
}
document.querySelectorAll('.ph-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchPhTab(btn.dataset.phTab));
});

// Mobile sidebar drawer (desktop keeps the sidebar permanently visible
// via md:translate-x-0 in the markup; this only matters below the md
// breakpoint).
function openMobileSidebar() {
  document.getElementById('ph-sidebar').classList.remove('-translate-x-full');
  document.getElementById('ph-sidebar-backdrop').classList.remove('hidden');
}
function closeMobileSidebar() {
  const sidebar = document.getElementById('ph-sidebar');
  const backdrop = document.getElementById('ph-sidebar-backdrop');
  if (window.innerWidth < 768) {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
  }
}
document.getElementById('ph-mobile-nav-toggle')?.addEventListener('click', openMobileSidebar);
document.getElementById('ph-mobile-nav-close')?.addEventListener('click', closeMobileSidebar);
document.getElementById('ph-sidebar-backdrop')?.addEventListener('click', closeMobileSidebar);

// Badge counts on the tab bar (the one signature element tying the
// app together) -- low stock count on Inventory, pending invoices on
// Reconcile. Silently no-ops on failure since it's a secondary
// indicator, not core functionality.
async function refreshPhBadges() {
  try {
    const { lowStock } = await window.phCallFunction('get_low_stock');
    const badge = document.getElementById('ph-badge-inventory');
    if (lowStock && lowStock.length > 0) {
      badge.textContent = lowStock.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch { /* non-critical */ }

  try {
    const { pendingApprovals } = await window.phCallFunction('list_pending_approvals');
    const badge = document.getElementById('ph-badge-reconcile');
    if (pendingApprovals && pendingApprovals.length > 0) {
      badge.textContent = pendingApprovals.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch { /* non-critical */ }
}

// ---- Helpers ----
function escapePhHtml(text) {
  if (!text && text !== 0) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function escapePhAttr(text) {
  return (text || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}
function formatRupees(amount) {
  return '₹' + Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ==========================================================
// CHECKOUT TAB
// ==========================================================
async function loadPhCheckoutStats() {
  const statsEl = document.getElementById('ph-checkout-stats');
  statsEl.innerHTML = statCard('Today', '…', ICONS.rupee) + statCard('Items in cart', phState.cart.length, ICONS.cart) + statCard('Sales this session', phState.recentSales.length, ICONS.receipt);
  try {
    const { lowStock } = await window.phCallFunction('get_low_stock');
    const sessionTotal = phState.recentSales.reduce((sum, s) => sum + Number(s.total || 0), 0);
    statsEl.innerHTML =
      statCard('This session', formatRupees(sessionTotal), ICONS.rupee) +
      statCard('Items in cart', phState.cart.length, ICONS.cart) +
      statCard('Sales this session', phState.recentSales.length, ICONS.receipt) +
      statCard('Low stock alerts', lowStock?.length || 0, ICONS.alert, lowStock?.length ? 'warn' : 'neutral');
  } catch { /* stats are supplementary */ }
}

let phMedSearchTimeout = null;
document.getElementById('ph-med-search').addEventListener('input', (e) => {
  clearTimeout(phMedSearchTimeout);
  const query = e.target.value.trim().toLowerCase();
  const resultsEl = document.getElementById('ph-med-results');
  if (query.length < 2) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }
  phMedSearchTimeout = setTimeout(async () => {
    try {
      const { medicines } = await window.phCallFunction('list_medicines');
      const matches = medicines.filter((m) => m.name.toLowerCase().includes(query)).slice(0, 8);
      if (matches.length === 0) {
        resultsEl.innerHTML = `<div class="p-4 text-sm text-charcoal/40 text-center">No matching medicines.</div>`;
        resultsEl.classList.remove('hidden');
        return;
      }
      resultsEl.innerHTML = matches.map((m) => `
        <button class="w-full text-left px-4 py-3 hover:bg-champagne-50 transition" onclick="window.phSelectMedicine('${m.id}', '${escapePhAttr(m.name)}')">
          <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(m.name)}</p>
          <p class="text-xs text-charcoal/50">${escapePhHtml(m.category || '')}</p>
        </button>`).join('');
      resultsEl.classList.remove('hidden');
    } catch (err) {
      resultsEl.innerHTML = `<div class="p-4 text-sm text-red-600">${escapePhHtml(err.message)}</div>`;
      resultsEl.classList.remove('hidden');
    }
  }, 300);
});

window.phSelectMedicine = async function (medicineId, medicineName) {
  document.getElementById('ph-med-results').classList.add('hidden');
  document.getElementById('ph-med-search').value = medicineName;
  const selectedEl = document.getElementById('ph-med-selected');
  const batchesEl = document.getElementById('ph-med-batches');
  selectedEl.classList.remove('hidden');
  document.getElementById('ph-med-selected-name').textContent = medicineName;
  batchesEl.innerHTML = `<p class="text-xs text-charcoal/40">Loading batches...</p>`;

  try {
    const qty = parseInt(document.getElementById('ph-med-qty').value, 10) || 1;
    const { batches } = await window.phCallFunction('get_fifo_batches', { medicineId, quantity: qty });
    if (!batches || batches.length === 0) {
      batchesEl.innerHTML = `<p class="text-xs text-red-600 font-medium">No stock available for this medicine.</p>`;
      phState.selectedMedicine = { id: medicineId, name: medicineName, batches: [] };
      return;
    }
    phState.selectedMedicine = { id: medicineId, name: medicineName, batches };
    batchesEl.innerHTML = batches.map((b) => `
      <p class="text-xs text-charcoal/60">Batch <span class="font-semibold text-charcoal/80">${escapePhHtml(b.batch_number)}</span> — ${b.to_dispense} unit(s) @ ${formatRupees(b.unit_price)} <span class="text-charcoal/40">(exp ${b.expiry_date})</span></p>
    `).join('');
  } catch (err) {
    batchesEl.innerHTML = `<p class="text-xs text-red-600">${escapePhHtml(err.message)}</p>`;
  }
};

document.getElementById('ph-med-qty').addEventListener('change', () => {
  if (phState.selectedMedicine) {
    window.phSelectMedicine(phState.selectedMedicine.id, phState.selectedMedicine.name);
  }
});

document.getElementById('ph-add-to-cart-btn').addEventListener('click', () => {
  const med = phState.selectedMedicine;
  if (!med || !med.batches || med.batches.length === 0) return;
  const qty = parseInt(document.getElementById('ph-med-qty').value, 10) || 1;

  med.batches.forEach((b) => {
    phState.cart.push({
      medicineId: med.id,
      medicineName: med.name,
      batchId: b.batch_id,
      batchNumber: b.batch_number,
      quantity: b.to_dispense,
      unitPrice: b.unit_price,
      gstPercent: 0,
    });
  });

  document.getElementById('ph-med-selected').classList.add('hidden');
  document.getElementById('ph-med-search').value = '';
  document.getElementById('ph-med-qty').value = 1;
  phState.selectedMedicine = null;
  renderPhCart();
  loadPhCheckoutStats();
});

function renderPhCart() {
  const listEl = document.getElementById('ph-cart-list');
  const totalEl = document.getElementById('ph-cart-total');
  const checkoutBtn = document.getElementById('ph-checkout-btn');

  if (phState.cart.length === 0) {
    listEl.innerHTML = `<p id="ph-cart-empty" class="text-charcoal/30 text-sm text-center py-8">No items added yet.</p>`;
    totalEl.textContent = formatRupees(0);
    checkoutBtn.disabled = true;
    return;
  }

  const total = phState.cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  listEl.innerHTML = phState.cart.map((item, idx) => `
    <div class="flex items-center justify-between bg-champagne-50 rounded-lg px-3 py-2.5">
      <div>
        <p class="text-sm font-semibold text-brand-900">${escapePhHtml(item.medicineName)}</p>
        <p class="text-xs text-charcoal/50">Batch ${escapePhHtml(item.batchNumber)} &middot; ${item.quantity} &times; ${formatRupees(item.unitPrice)}</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-sm font-bold text-brand-900 tabular-nums">${formatRupees(item.quantity * item.unitPrice)}</span>
        <button onclick="window.phRemoveFromCart(${idx})" class="text-charcoal/30 hover:text-red-600 transition" aria-label="Remove">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>`).join('');
  totalEl.textContent = formatRupees(total);
  checkoutBtn.disabled = false;
}

window.phRemoveFromCart = function (idx) {
  phState.cart.splice(idx, 1);
  renderPhCart();
  loadPhCheckoutStats();
};

document.getElementById('ph-checkout-btn').addEventListener('click', async () => {
  const errorEl = document.getElementById('ph-checkout-error');
  const btn = document.getElementById('ph-checkout-btn');
  errorEl.textContent = '';

  const patientName = document.getElementById('ph-cart-patient-name').value.trim();
  const patientPhone = document.getElementById('ph-cart-patient-phone').value.trim();
  const paymentMode = document.getElementById('ph-cart-payment-mode').value;

  if (!patientName) {
    errorEl.textContent = 'Patient name is required (use "Walk-in" if unknown).';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Processing...';
  try {
    const items = phState.cart.map((item) => ({
      medicine_id: item.medicineId,
      batch_id: item.batchId,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      gst_percent: item.gstPercent,
    }));
    const result = await window.phCallFunction('execute_pharmacy_sale', {
      items,
      newPatientName: patientName,
      newPatientPhone: patientPhone || null,
      paymentMode,
    });
    phState.recentSales.unshift({
      dispenseId: result.dispense_id,
      billId: result.bill_id,
      total: result.total_amount,
      patientName,
      items: [...phState.cart],
    });
    phState.cart = [];
    renderPhCart();
    renderPhRecentSales();
    loadPhCheckoutStats();
    refreshPhBadges();
    document.getElementById('ph-cart-patient-name').value = '';
    document.getElementById('ph-cart-patient-phone').value = '';
    showPhToast(`Sale complete — ${formatRupees(result.total_amount)}`, 'success');
  } catch (err) {
    errorEl.textContent = err.message;
    showPhToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Complete Sale';
  }
});

function renderPhRecentSales() {
  const listEl = document.getElementById('ph-recent-sales');
  if (phState.recentSales.length === 0) {
    listEl.innerHTML = emptyState('No sales yet this session.', ICONS.receipt);
    return;
  }
  listEl.innerHTML = phState.recentSales.map((sale) => `
    <div class="flex items-center justify-between border border-champagne-200 rounded-xl px-4 py-3">
      <div>
        <p class="text-sm font-semibold text-brand-900">${escapePhHtml(sale.patientName)}</p>
        <p class="text-xs text-charcoal/50">${sale.items.length} item(s) &middot; ${formatRupees(sale.total)}</p>
      </div>
      <button onclick="window.phVoidSale('${sale.dispenseId}')" class="text-xs font-semibold text-red-600 hover:text-red-800 transition">Void</button>
    </div>`).join('');
}

window.phVoidSale = async function (dispenseId) {
  const confirmed = await showPhConfirm('Void this sale?', 'This will restore stock and cannot be undone.');
  if (!confirmed) return;
  try {
    await window.phCallFunction('void_pharmacy_sale', { originalDispenseId: dispenseId, reason: 'Voided from checkout screen' });
    phState.recentSales = phState.recentSales.filter((s) => s.dispenseId !== dispenseId);
    renderPhRecentSales();
    loadPhCheckoutStats();
    showPhToast('Sale voided and stock restored.', 'success');
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

// ==========================================================
// INVENTORY TAB
// ==========================================================
async function loadPhInventoryStats() {
  const statsEl = document.getElementById('ph-inventory-stats');
  statsEl.innerHTML = statCard('Medicines', '…', ICONS.box) + statCard('Low stock', '…', ICONS.alert) + statCard('Expiring soon', '…', ICONS.clock);
  try {
    const [{ medicines }, { lowStock }, { expiringBatches }] = await Promise.all([
      window.phCallFunction('list_medicines'),
      window.phCallFunction('get_low_stock'),
      window.phCallFunction('get_expiring_batches', { withinDays: 90 }),
    ]);
    statsEl.innerHTML =
      statCard('Medicines', medicines?.length || 0, ICONS.box) +
      statCard('Low stock', lowStock?.length || 0, ICONS.alert, lowStock?.length ? 'warn' : 'neutral') +
      statCard('Expiring in 90d', expiringBatches?.length || 0, ICONS.clock, expiringBatches?.length ? 'warn' : 'neutral');
  } catch { /* stats supplementary */ }
}

document.querySelectorAll('.ph-inv-view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ph-inv-view-btn').forEach((b) => {
      b.classList.remove('bg-brand-700', 'text-white');
      b.classList.add('bg-champagne-100', 'text-brand-700');
    });
    btn.classList.remove('bg-champagne-100', 'text-brand-700');
    btn.classList.add('bg-brand-700', 'text-white');
    loadPhInventory(btn.dataset.phInvView);
  });
});

async function loadPhInventory(view) {
  const listEl = document.getElementById('ph-inventory-list');
  listEl.innerHTML = skeletonRows(4);
  try {
    if (view === 'low') {
      const { lowStock } = await window.phCallFunction('get_low_stock');
      if (!lowStock || lowStock.length === 0) {
        listEl.innerHTML = emptyState('Nothing is running low right now.', ICONS.box);
        return;
      }
      listEl.innerHTML = lowStock.map((m) => `
        <div class="px-5 py-4 flex items-center justify-between hover:bg-champagne-50/50 transition">
          <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(m.medicine_name)}</p>
          ${stockChip(m.total_stock, m.reorder_level)}
        </div>`).join('');
    } else if (view === 'expiring') {
      const { expiringBatches } = await window.phCallFunction('get_expiring_batches', { withinDays: 90 });
      if (!expiringBatches || expiringBatches.length === 0) {
        listEl.innerHTML = emptyState('No batches expiring within 90 days.', ICONS.clock);
        return;
      }
      listEl.innerHTML = expiringBatches.map((b) => `
        <div class="px-5 py-4 flex items-center justify-between hover:bg-champagne-50/50 transition">
          <div>
            <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(b.medicine_name)}</p>
            <p class="text-xs text-charcoal/50">Batch ${escapePhHtml(b.batch_number)} &middot; ${b.quantity_remaining} remaining</p>
          </div>
          ${expiryChip(b.expiry_date)}
        </div>`).join('');
    } else {
      const { inventory } = await window.phCallFunction('get_inventory');
      if (!inventory || inventory.length === 0) {
        listEl.innerHTML = emptyState('No medicines yet — add one to get started.', ICONS.box);
        return;
      }
      const byMedicine = {};
      inventory.forEach((row) => {
        if (!byMedicine[row.medicine_id]) {
          byMedicine[row.medicine_id] = { name: row.medicine_name, category: row.category, reorder: row.reorder_level, batches: [] };
        }
        if (row.batch_id) byMedicine[row.medicine_id].batches.push(row);
      });
      listEl.innerHTML = Object.values(byMedicine).map((m) => {
        const totalStock = m.batches.reduce((sum, b) => sum + (b.quantity_remaining || 0), 0);
        return `
          <div class="px-5 py-4 flex items-center justify-between hover:bg-champagne-50/50 transition">
            <div>
              <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(m.name)}</p>
              <p class="text-xs text-charcoal/40">${escapePhHtml(m.category || '')} &middot; ${m.batches.length} batch(es)</p>
            </div>
            ${stockChip(totalStock, m.reorder || 10)}
          </div>`;
      }).join('');
    }
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${escapePhHtml(err.message)}</p>`;
  }
}

document.getElementById('ph-new-medicine-btn').addEventListener('click', () => {
  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-4">New Medicine</h3>
      <div class="space-y-3">
        <input type="text" id="ph-new-med-name" placeholder="Name" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-med-generic" placeholder="Generic name" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-med-category" placeholder="Category" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <select id="ph-new-med-formulation" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
          <option value="tablet">Tablet</option>
          <option value="capsule">Capsule</option>
          <option value="syrup">Syrup</option>
          <option value="cream">Cream</option>
          <option value="injection">Injection</option>
          <option value="drops">Drops</option>
          <option value="inhaler">Inhaler</option>
          <option value="powder">Powder</option>
          <option value="other">Other</option>
        </select>
        <select id="ph-new-med-unit" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
          <option value="strip">Strip</option>
          <option value="bottle">Bottle</option>
          <option value="tube">Tube</option>
          <option value="vial">Vial</option>
          <option value="sachet">Sachet</option>
          <option value="piece">Piece</option>
        </select>
        <input type="number" id="ph-new-med-reorder" placeholder="Reorder level" value="10" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
      </div>
      <p id="ph-new-med-error" class="text-red-600 text-sm mt-2 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-4">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phSaveNewMedicine()" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Save</button>
      </div>
    </div>`);
});

window.phSaveNewMedicine = async function () {
  const errorEl = document.getElementById('ph-new-med-error');
  const name = document.getElementById('ph-new-med-name').value.trim();
  if (!name) {
    errorEl.textContent = 'Name is required.';
    return;
  }
  try {
    await window.phCallFunction('upsert_medicine', {
      name,
      genericName: document.getElementById('ph-new-med-generic').value.trim() || null,
      category: document.getElementById('ph-new-med-category').value.trim() || null,
      formulation: document.getElementById('ph-new-med-formulation').value,
      unit: document.getElementById('ph-new-med-unit').value,
      reorderLevel: parseInt(document.getElementById('ph-new-med-reorder').value, 10) || 10,
    });
    closePhModal();
    loadPhInventory('all');
    loadPhInventoryStats();
    refreshPhBadges();
    showPhToast(`${name} added to inventory.`, 'success');
  } catch (err) {
    errorEl.textContent = err.message;
  }
};

// ==========================================================
// PURCHASE ORDERS TAB
// ==========================================================
async function loadPhPoStats() {
  const statsEl = document.getElementById('ph-po-stats');
  statsEl.innerHTML = statCard('Total orders', '…', ICONS.box) + statCard('Awaiting receipt', '…', ICONS.clock) + statCard('Payment pending', '…', ICONS.rupee);
  try {
    const { purchaseOrders } = await window.phCallFunction('list_purchase_orders');
    const awaitingReceipt = (purchaseOrders || []).filter((po) => !po.delivery_date).length;
    const paymentPending = (purchaseOrders || []).filter((po) => po.payment_status !== 'paid').length;
    statsEl.innerHTML =
      statCard('Total orders', purchaseOrders?.length || 0, ICONS.box) +
      statCard('Awaiting receipt', awaitingReceipt, ICONS.clock, awaitingReceipt ? 'warn' : 'neutral') +
      statCard('Payment pending', paymentPending, ICONS.rupee, paymentPending ? 'warn' : 'neutral');
  } catch { /* stats supplementary */ }
}

async function loadPhPurchaseOrders() {
  const listEl = document.getElementById('ph-po-list');
  listEl.innerHTML = skeletonRows(3);
  try {
    const { purchaseOrders } = await window.phCallFunction('list_purchase_orders');
    if (!purchaseOrders || purchaseOrders.length === 0) {
      listEl.innerHTML = emptyState('No purchase orders yet — create one to receive stock.', ICONS.receipt);
      return;
    }
    listEl.innerHTML = purchaseOrders.map((po) => `
      <div class="px-5 py-4 flex items-center justify-between hover:bg-champagne-50/50 transition">
        <div>
          <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(po.po_number)}</p>
          <p class="text-xs text-charcoal/50">${formatRupees(po.total_amount)} &middot; ${po.invoice_number ? 'Invoice ' + escapePhHtml(po.invoice_number) : 'No invoice number'}</p>
        </div>
        <div class="flex items-center gap-3">
          ${paymentStatusChip(po.payment_status)}
          ${po.delivery_date ? '' : `<button onclick="window.phReceivePO('${po.id}', ${po.total_amount})" class="text-xs font-bold text-brand-700 hover:text-brand-900 transition">Receive</button>`}
        </div>
      </div>`).join('');
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${escapePhHtml(err.message)}</p>`;
  }
}

window.phReceivePO = async function (poId, totalAmount) {
  const paymentMode = await showPhTextPrompt('Payment mode', { placeholder: 'cash / upi / card', defaultValue: 'cash' });
  if (!paymentMode) return;
  try {
    await window.phCallFunction('receive_purchase_order', { poId, paymentMode, amountPaid: totalAmount });
    loadPhPurchaseOrders();
    loadPhPoStats();
    refreshPhBadges();
    showPhToast('Purchase order received — stock updated.', 'success');
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

document.getElementById('ph-new-po-btn').addEventListener('click', async () => {
  let suppliers = [];
  try {
    const result = await window.phCallFunction('list_suppliers');
    suppliers = result.suppliers || [];
  } catch (err) {
    showPhToast('Error loading suppliers: ' + err.message, 'error');
    return;
  }

  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-4">New Purchase Order</h3>
      <div class="space-y-3">
        <select id="ph-new-po-supplier" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
          <option value="">Select supplier...</option>
          ${suppliers.map((s) => `<option value="${s.id}">${escapePhHtml(s.name)}</option>`).join('')}
          <option value="__new__">+ Add new supplier</option>
        </select>
        <input type="text" id="ph-new-po-invoice" placeholder="Invoice number (optional)" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <div class="border-t border-champagne-200 pt-3">
          <p class="text-xs font-bold text-brand-700 uppercase tracking-wide mb-2">Line Item</p>
          <input type="text" id="ph-new-po-med-name" placeholder="Medicine name" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm mb-2" />
          <input type="text" id="ph-new-po-batch" placeholder="Batch number" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm mb-2" />
          <input type="date" id="ph-new-po-expiry" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm mb-2" />
          <div class="grid grid-cols-2 gap-2 mb-2">
            <input type="number" id="ph-new-po-qty" placeholder="Quantity" class="border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
            <input type="number" id="ph-new-po-free" placeholder="Free qty" value="0" class="border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          </div>
          <div class="grid grid-cols-3 gap-2">
            <input type="number" id="ph-new-po-purchase-price" placeholder="Cost ₹" class="border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
            <input type="number" id="ph-new-po-selling-price" placeholder="Sell ₹" class="border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
            <input type="number" id="ph-new-po-gst" placeholder="GST %" class="border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          </div>
        </div>
      </div>
      <p id="ph-new-po-error" class="text-red-600 text-sm mt-2 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-4">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phSaveNewPO()" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Create PO</button>
      </div>
    </div>`);

  document.getElementById('ph-new-po-supplier').addEventListener('change', async (e) => {
    if (e.target.value !== '__new__') return;
    const name = await showPhTextPrompt('New supplier name');
    if (!name) { e.target.value = ''; return; }
    try {
      const { id } = await window.phCallFunction('upsert_supplier', { name });
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      opt.selected = true;
      e.target.insertBefore(opt, e.target.lastElementChild);
    } catch (err) {
      showPhToast(err.message, 'error');
      e.target.value = '';
    }
  });
});

window.phSaveNewPO = async function () {
  const errorEl = document.getElementById('ph-new-po-error');
  const supplierId = document.getElementById('ph-new-po-supplier').value;
  const medicineName = document.getElementById('ph-new-po-med-name').value.trim();

  if (!supplierId || supplierId === '__new__') {
    errorEl.textContent = 'Please select a supplier.';
    return;
  }
  if (!medicineName) {
    errorEl.textContent = 'Medicine name is required.';
    return;
  }

  try {
    const { medicines } = await window.phCallFunction('list_medicines');
    let medicine = medicines.find((m) => m.name.toLowerCase() === medicineName.toLowerCase());
    let medicineId;
    if (medicine) {
      medicineId = medicine.id;
    } else {
      const created = await window.phCallFunction('upsert_medicine', { name: medicineName });
      medicineId = created.id;
    }

    await window.phCallFunction('create_purchase_order', {
      supplierId,
      invoiceNumber: document.getElementById('ph-new-po-invoice').value.trim() || null,
      items: [{
        medicine_id: medicineId,
        medicine_name: medicineName,
        batch_number: document.getElementById('ph-new-po-batch').value.trim(),
        expiry_date: document.getElementById('ph-new-po-expiry').value,
        quantity: parseInt(document.getElementById('ph-new-po-qty').value, 10) || 0,
        free_quantity: parseInt(document.getElementById('ph-new-po-free').value, 10) || 0,
        purchase_price: parseFloat(document.getElementById('ph-new-po-purchase-price').value) || 0,
        selling_price: parseFloat(document.getElementById('ph-new-po-selling-price').value) || 0,
        gst_percent: parseFloat(document.getElementById('ph-new-po-gst').value) || 0,
      }],
    });
    closePhModal();
    loadPhPurchaseOrders();
    loadPhPoStats();
    showPhToast('Purchase order created.', 'success');
  } catch (err) {
    errorEl.textContent = err.message;
  }
};

// ==========================================================
// RECONCILE TAB
// ==========================================================
function switchPhRecView(view) {
  document.querySelectorAll('.ph-rec-subview').forEach((el) => el.classList.add('hidden'));
  document.getElementById(`ph-rec-${view}`).classList.remove('hidden');
  document.querySelectorAll('.ph-rec-view-btn').forEach((btn) => {
    const active = btn.dataset.phRecView === view;
    btn.classList.toggle('bg-brand-700', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('bg-champagne-100', !active);
    btn.classList.toggle('text-brand-700', !active);
  });
  if (view === 'invoices') loadPhPendingApprovals();
  if (view === 'audit') loadPhAuditList();
  if (view === 'reorder') loadPhReorderSuggestions();
  if (view === 'reps') loadPhReps();
}
document.querySelectorAll('.ph-rec-view-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchPhRecView(btn.dataset.phRecView));
});

// ---- Invoice Review ----
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

document.getElementById('ph-invoice-upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('ph-invoice-upload-status');
  statusEl.classList.remove('hidden');
  statusEl.innerHTML = `<div class="flex items-center gap-2 text-sm text-brand-700 bg-champagne-50 border border-champagne-200 rounded-xl px-4 py-3">
    <svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
    Extracting invoice with AI, this can take a few seconds...
  </div>`;
  try {
    const base64 = await fileToBase64(file);
    const { aiResult } = await window.phCallFunction('extract_invoice_from_image', {
      fileData: base64,
      mimeType: file.type,
      fileName: file.name,
    });
    await window.phCallFunction('create_pending_approval', {
      fileName: file.name,
      driveUrl: aiResult.invoice?.bill_url || null,
      aiData: aiResult,
    });
    statusEl.innerHTML = `<div class="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      Extracted — review it below.
    </div>`;
    loadPhPendingApprovals();
    refreshPhBadges();
  } catch (err) {
    statusEl.innerHTML = `<div class="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3">${escapePhHtml(err.message)}</div>`;
  } finally {
    e.target.value = '';
  }
});

async function loadPhPendingApprovals() {
  const listEl = document.getElementById('ph-pending-approvals-list');
  listEl.innerHTML = skeletonRows(2);
  try {
    const { pendingApprovals } = await window.phCallFunction('list_pending_approvals');
    if (!pendingApprovals || pendingApprovals.length === 0) {
      listEl.innerHTML = emptyState('No invoices waiting for review.', ICONS.receipt);
      return;
    }
    listEl.innerHTML = pendingApprovals.map((draft) => {
      const inv = draft.ai_data?.invoice || {};
      const sup = draft.ai_data?.supplier || {};
      const itemCount = (draft.ai_data?.items || []).length;
      return `
        <div class="px-5 py-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(sup.supplier_name || 'Unknown supplier')} — ${escapePhHtml(inv.invoice_number || draft.file_name)}</p>
              <p class="text-xs text-charcoal/50">${itemCount} item(s) &middot; ${formatRupees(inv.grand_total)} &middot; ${inv.invoice_date || ''}</p>
            </div>
            <div class="flex gap-2 shrink-0">
              <button onclick="window.phCommitDraft('${draft.id}')" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-900 transition">Commit</button>
              <button onclick="window.phRejectDraft('${draft.id}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition">Reject</button>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${escapePhHtml(err.message)}</p>`;
  }
}

window.phCommitDraft = async function (draftId) {
  try {
    const { pendingApprovals } = await window.phCallFunction('list_pending_approvals');
    const draft = (pendingApprovals || []).find((d) => d.id === draftId);
    if (!draft) return showPhToast('Draft not found.', 'error');

    const aiData = draft.ai_data || {};
    await window.phCallFunction('commit_reviewed_invoice', {
      draft_id: draftId,
      supplier: { id: 'NEW', ...(aiData.supplier || {}) },
      invoice: aiData.invoice || {},
      items: aiData.items || [],
    });
    loadPhPendingApprovals();
    refreshPhBadges();
    showPhToast('Invoice committed — stock updated.', 'success');
  } catch (err) {
    showPhToast('Error committing invoice: ' + err.message, 'error');
  }
};

window.phRejectDraft = async function (draftId) {
  const confirmed = await showPhConfirm('Reject this draft?', 'It will be removed from the review queue.');
  if (!confirmed) return;
  try {
    await window.phCallFunction('reject_pending_approval', { id: draftId });
    loadPhPendingApprovals();
    refreshPhBadges();
    showPhToast('Draft rejected.', 'info');
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

// ---- Physical Audit ----
async function loadPhAuditList() {
  const listEl = document.getElementById('ph-audit-list');
  listEl.innerHTML = skeletonRows(4);
  try {
    const { medicines } = await window.phCallFunction('get_medicines_with_wac');
    if (!medicines || medicines.length === 0) {
      listEl.innerHTML = emptyState('No medicines yet.', ICONS.box);
      return;
    }
    listEl.innerHTML = medicines.map((m) => `
      <div class="px-5 py-3 flex items-center justify-between">
        <div>
          <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(m.name)}</p>
          <p class="text-xs text-charcoal/50">System stock: ${m.total_stock}</p>
        </div>
        <input type="number" data-audit-medicine-id="${m.medicine_id}" placeholder="Counted qty"
               class="w-32 border border-champagne-300 rounded-lg px-3 py-1.5 text-sm tabular-nums" />
      </div>`).join('');
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${escapePhHtml(err.message)}</p>`;
  }
}

document.getElementById('ph-submit-audit-btn').addEventListener('click', async () => {
  const resultEl = document.getElementById('ph-audit-result');
  const inputs = document.querySelectorAll('[data-audit-medicine-id]');
  const audits = [];
  inputs.forEach((input) => {
    if (input.value !== '') {
      audits.push({ medicine_id: input.dataset.auditMedicineId, counted_quantity: parseInt(input.value, 10) });
    }
  });
  if (audits.length === 0) {
    resultEl.innerHTML = `<p class="text-sm text-charcoal/50">Enter at least one counted quantity.</p>`;
    return;
  }
  try {
    const { results } = await window.phCallFunction('run_physical_audit', { audits, reason: 'Physical audit via /pharmacy' });
    const adjusted = results.filter((r) => r.adjusted);
    if (adjusted.length === 0) {
      resultEl.innerHTML = `<p class="text-sm text-emerald-700 font-medium">No discrepancies found — nothing adjusted.</p>`;
    } else {
      resultEl.innerHTML = `<p class="text-sm text-amber-700 font-medium">Adjusted ${adjusted.length} medicine(s): ` +
        adjusted.map((r) => `${r.delta > 0 ? '+' : ''}${r.delta}`).join(', ') + `</p>`;
    }
    loadPhAuditList();
    showPhToast('Audit submitted.', 'success');
  } catch (err) {
    resultEl.innerHTML = `<p class="text-sm text-red-600">${escapePhHtml(err.message)}</p>`;
  }
});

// ---- Reorder Suggestions ----
async function loadPhReorderSuggestions() {
  const listEl = document.getElementById('ph-reorder-list');
  listEl.innerHTML = skeletonRows(3);
  try {
    const { recommendations } = await window.phCallFunction('get_predictive_reorder');
    if (!recommendations || recommendations.length === 0) {
      listEl.innerHTML = emptyState('Nothing needs reordering right now.', ICONS.box);
      return;
    }
    listEl.innerHTML = recommendations.map((r) => `
      <div class="px-5 py-4">
        <div class="flex items-center justify-between mb-1">
          <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(r.medName)}</p>
          <span class="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">Reorder ${r.suggestedQty}</span>
        </div>
        <p class="text-xs text-charcoal/50">${escapePhHtml(r.reason)}</p>
      </div>`).join('');
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${escapePhHtml(err.message)}</p>`;
  }
}

// ---- Rep CRM ----
async function loadPhReps() {
  const listEl = document.getElementById('ph-reps-list');
  listEl.innerHTML = skeletonRows(3);
  try {
    const { reps } = await window.phCallFunction('list_medical_reps');
    if (!reps || reps.length === 0) {
      listEl.innerHTML = emptyState('No reps added yet.', ICONS.box);
      return;
    }
    listEl.innerHTML = reps.map((r) => `
      <div class="px-5 py-4">
        <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(r.rep_name)}</p>
        <p class="text-xs text-charcoal/50">${[r.company, r.division, r.phone].filter(Boolean).map(escapePhHtml).join(' &middot; ')}</p>
      </div>`).join('');
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${escapePhHtml(err.message)}</p>`;
  }
}

document.getElementById('ph-new-rep-btn').addEventListener('click', () => {
  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-4">New Medical Rep</h3>
      <div class="space-y-3">
        <input type="text" id="ph-new-rep-name" placeholder="Rep name" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-rep-company" placeholder="Company" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-rep-division" placeholder="Division" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-rep-phone" placeholder="Phone" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
      </div>
      <p id="ph-new-rep-error" class="text-red-600 text-sm mt-2 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-4">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phSaveNewRep()" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Save</button>
      </div>
    </div>`);
});

window.phSaveNewRep = async function () {
  const errorEl = document.getElementById('ph-new-rep-error');
  const repName = document.getElementById('ph-new-rep-name').value.trim();
  if (!repName) {
    errorEl.textContent = 'Rep name is required.';
    return;
  }
  try {
    await window.phCallFunction('upsert_medical_rep', {
      repName,
      company: document.getElementById('ph-new-rep-company').value.trim() || null,
      division: document.getElementById('ph-new-rep-division').value.trim() || null,
      phone: document.getElementById('ph-new-rep-phone').value.trim() || null,
    });
    closePhModal();
    loadPhReps();
    showPhToast(`${repName} added.`, 'success');
  } catch (err) {
    errorEl.textContent = err.message;
  }
};

// ==========================================================
// MODAL HELPERS
// ==========================================================
function showPhModal(html) {
  document.getElementById('ph-modal-content').innerHTML = html;
  document.getElementById('ph-modal-backdrop').classList.remove('hidden');
}
window.closePhModal = function () {
  document.getElementById('ph-modal-backdrop').classList.add('hidden');
  document.getElementById('ph-modal-content').innerHTML = '';
};
document.getElementById('ph-modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'ph-modal-backdrop') window.closePhModal();
});

document.addEventListener('DOMContentLoaded', initPhAuth);
