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
  statsEl.innerHTML = statCard('Today', '…', ICONS.rupee) + statCard('Items in cart', phState.cart.length, ICONS.cart) + statCard('Sales today', '…', ICONS.receipt);
  try {
    const [{ lowStock }, { summary }] = await Promise.all([
      window.phCallFunction('get_low_stock'),
      window.phCallFunction('get_todays_pharmacy_summary'),
    ]);
    statsEl.innerHTML =
      statCard('Today', formatRupees(summary?.net_revenue || 0), ICONS.rupee) +
      statCard('Items in cart', phState.cart.length, ICONS.cart) +
      statCard('Sales today', summary?.sale_count || 0, ICONS.receipt) +
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
        <button class="w-full text-left px-4 py-3 hover:bg-champagne-50 transition" onclick="window.phSelectMedicine('${m.id}', '${escapePhAttr(m.name)}', ${m.gst_percent || 0})">
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

window.phSelectMedicine = async function (medicineId, medicineName, gstPercent = 0) {
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
      phState.selectedMedicine = { id: medicineId, name: medicineName, gstPercent, batches: [] };
      return;
    }
    phState.selectedMedicine = { id: medicineId, name: medicineName, gstPercent, batches };
    batchesEl.innerHTML = batches.map((b) => {
      const gstAmount = b.unit_price * b.to_dispense * (gstPercent / 100);
      return `
      <p class="text-xs text-charcoal/60">Batch <span class="font-semibold text-charcoal/80">${escapePhHtml(b.batch_number)}</span> — ${b.to_dispense} unit(s) @ ${formatRupees(b.unit_price)}${gstPercent > 0 ? ` <span class="text-charcoal/40">+ ${gstPercent}% GST (${formatRupees(gstAmount)})</span>` : ''} <span class="text-charcoal/40">(exp ${b.expiry_date})</span></p>
    `;
    }).join('');
  } catch (err) {
    batchesEl.innerHTML = `<p class="text-xs text-red-600">${escapePhHtml(err.message)}</p>`;
  }
};

document.getElementById('ph-med-qty').addEventListener('change', () => {
  if (phState.selectedMedicine) {
    window.phSelectMedicine(phState.selectedMedicine.id, phState.selectedMedicine.name, phState.selectedMedicine.gstPercent);
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
      gstPercent: med.gstPercent || 0,
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
  const subtotalRow = document.getElementById('ph-cart-subtotal-row');
  const gstRow = document.getElementById('ph-cart-gst-row');

  if (phState.cart.length === 0) {
    listEl.innerHTML = `<p id="ph-cart-empty" class="text-charcoal/30 text-sm text-center py-8">No items added yet.</p>`;
    totalEl.textContent = formatRupees(0);
    subtotalRow.classList.add('hidden');
    subtotalRow.classList.remove('flex');
    gstRow.classList.add('hidden');
    gstRow.classList.remove('flex');
    checkoutBtn.disabled = true;
    return;
  }

  const subtotal = phState.cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const gstTotal = phState.cart.reduce((sum, item) => sum + item.quantity * item.unitPrice * ((item.gstPercent || 0) / 100), 0);
  const grandTotal = subtotal + gstTotal;

  listEl.innerHTML = phState.cart.map((item, idx) => {
    const lineBase = item.quantity * item.unitPrice;
    const lineGst = lineBase * ((item.gstPercent || 0) / 100);
    return `
    <div class="flex items-center justify-between bg-champagne-50 rounded-lg px-3 py-2.5">
      <div>
        <p class="text-sm font-semibold text-brand-900">${escapePhHtml(item.medicineName)}</p>
        <p class="text-xs text-charcoal/50">Batch ${escapePhHtml(item.batchNumber)} &middot; ${item.quantity} &times; ${formatRupees(item.unitPrice)}${item.gstPercent > 0 ? ` &middot; GST ${item.gstPercent}%` : ''}</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-sm font-bold text-brand-900 tabular-nums">${formatRupees(lineBase + lineGst)}</span>
        <button onclick="window.phRemoveFromCart(${idx})" class="text-charcoal/30 hover:text-red-600 transition" aria-label="Remove">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  if (gstTotal > 0) {
    subtotalRow.classList.remove('hidden');
    subtotalRow.classList.add('flex');
    gstRow.classList.remove('hidden');
    gstRow.classList.add('flex');
    document.getElementById('ph-cart-subtotal').textContent = formatRupees(subtotal);
    document.getElementById('ph-cart-gst').textContent = formatRupees(gstTotal);
  } else {
    subtotalRow.classList.add('hidden');
    subtotalRow.classList.remove('flex');
    gstRow.classList.add('hidden');
    gstRow.classList.remove('flex');
  }
  totalEl.textContent = formatRupees(grandTotal);
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
      billNumber: result.bill_number,
      total: result.total_amount,
      patientName,
      patientPhone: patientPhone || null,
      paymentMode,
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
    window.phShowReceipt(result.dispense_id);
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
      <div class="flex items-center gap-3">
        <button onclick="window.phShowReceipt('${sale.dispenseId}')" class="text-xs font-semibold text-charcoal/50 hover:text-brand-900 transition">Receipt</button>
        <button onclick="window.phOpenPartialReturn('${sale.dispenseId}')" class="text-xs font-semibold text-brand-700 hover:text-brand-900 transition">Return</button>
        <button onclick="window.phVoidSale('${sale.dispenseId}')" class="text-xs font-semibold text-red-600 hover:text-red-800 transition">Void</button>
      </div>
    </div>`).join('');
}

// ---- Receipt ----
// Renders from the in-memory sale record (this session only, same
// scoping note as partial return) into a print-friendly view. Uses
// window.print() with a dedicated print stylesheet rather than a
// server-generated PDF, since the clinic already has a receipt
// printer workflow at the counter and this needs to be instant.
window.phShowReceipt = function (dispenseId) {
  const sale = phState.recentSales.find((s) => s.dispenseId === dispenseId);
  if (!sale) return showPhToast('Receipt not available for this sale.', 'error');

  const lineRows = sale.items.map((item) => `
    <tr>
      <td class="ph-receipt-cell">${escapePhHtml(item.medicineName)}<br><span class="ph-receipt-sub">Batch ${escapePhHtml(item.batchNumber)}</span></td>
      <td class="ph-receipt-cell ph-receipt-right">${item.quantity}</td>
      <td class="ph-receipt-cell ph-receipt-right">${formatRupees(item.unitPrice)}</td>
      <td class="ph-receipt-cell ph-receipt-right">${formatRupees(item.quantity * item.unitPrice * (1 + (item.gstPercent || 0) / 100))}</td>
    </tr>`).join('');

  const subtotal = sale.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const gstTotal = sale.total - subtotal;

  showPhModal(`
    <div class="p-6" id="ph-receipt-content">
      <div class="text-center mb-4">
        <p class="font-bold text-brand-900">CRISPR Skin and Hair Clinic — Pharmacy</p>
        <p class="text-xs text-charcoal/50">${escapePhHtml(sale.billNumber || '')}</p>
      </div>
      <div class="text-xs text-charcoal/60 mb-3 space-y-0.5">
        <p>Patient: ${escapePhHtml(sale.patientName)}${sale.patientPhone ? ' &middot; ' + escapePhHtml(sale.patientPhone) : ''}</p>
        <p>Payment: ${escapePhHtml(sale.paymentMode || '')}</p>
        <p>${new Date().toLocaleString('en-IN')}</p>
      </div>
      <table class="w-full text-xs mb-3" style="border-collapse: collapse;">
        <thead>
          <tr class="border-b border-champagne-300">
            <th class="ph-receipt-cell text-left">Item</th>
            <th class="ph-receipt-cell ph-receipt-right">Qty</th>
            <th class="ph-receipt-cell ph-receipt-right">Rate</th>
            <th class="ph-receipt-cell ph-receipt-right">Amount</th>
          </tr>
        </thead>
        <tbody>${lineRows}</tbody>
      </table>
      <div class="border-t border-champagne-300 pt-2 text-sm space-y-1">
        ${gstTotal > 0.01 ? `
          <div class="flex justify-between text-xs text-charcoal/50"><span>Subtotal</span><span>${formatRupees(subtotal)}</span></div>
          <div class="flex justify-between text-xs text-charcoal/50"><span>GST</span><span>${formatRupees(gstTotal)}</span></div>
        ` : ''}
        <div class="flex justify-between font-bold text-brand-900"><span>Total</span><span>${formatRupees(sale.total)}</span></div>
      </div>
    </div>
    <div class="px-6 pb-6 flex gap-2 print:hidden">
      <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Close</button>
      <button onclick="window.print()" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Print</button>
    </div>`);
};


window.phOpenPartialReturn = async function (dispenseId) {
  let items = [];
  try {
    const result = await window.phCallFunction('get_dispense_items', { dispenseId });
    items = result.items || [];
  } catch (err) {
    showPhToast('Error loading sale items: ' + err.message, 'error');
    return;
  }
  if (items.length === 0) {
    showPhToast('Nothing left to return on this sale.', 'info');
    return;
  }

  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-1">Partial Return</h3>
      <p class="text-xs text-charcoal/40 mb-4">Enter how many units of each item are being returned. Leave a field blank to skip it.</p>
      <div class="space-y-3 mb-2">
        ${items.map((item) => `
          <div class="flex items-center justify-between gap-3 border border-champagne-200 rounded-xl p-3">
            <div class="min-w-0">
              <p class="text-sm font-semibold text-brand-900 truncate">${escapePhHtml(item.medicine_name)}</p>
              <p class="text-xs text-charcoal/40">${item.quantity_returnable} of ${item.quantity_dispensed} still returnable &middot; ${formatRupees(item.unit_price)}/unit</p>
            </div>
            <input type="number" min="0" max="${item.quantity_returnable}" placeholder="Qty"
                   data-return-item-id="${item.item_id}" data-return-max="${item.quantity_returnable}"
                   class="w-20 shrink-0 border border-champagne-300 rounded-lg px-2 py-1.5 text-sm tabular-nums" />
          </div>`).join('')}
      </div>
      <input type="text" id="ph-return-reason" placeholder="Reason (optional)" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm mb-2" />
      <p id="ph-return-error" class="text-red-600 text-sm min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-2">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phConfirmPartialReturn('${dispenseId}')" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Process Return</button>
      </div>
    </div>`);
};

window.phConfirmPartialReturn = async function (dispenseId) {
  const errorEl = document.getElementById('ph-return-error');
  const inputs = Array.from(document.querySelectorAll('[data-return-item-id]'));
  const returnItems = [];

  for (const input of inputs) {
    const val = input.value.trim();
    if (val === '') continue;
    const qty = parseInt(val, 10);
    const max = parseInt(input.dataset.returnMax, 10);
    if (isNaN(qty) || qty <= 0) continue;
    if (qty > max) {
      errorEl.textContent = `Cannot return more than ${max} units of one of the items.`;
      return;
    }
    returnItems.push({ dispense_item_id: input.dataset.returnItemId, quantity_returned: qty });
  }

  if (returnItems.length === 0) {
    errorEl.textContent = 'Enter at least one quantity to return.';
    return;
  }

  try {
    await window.phCallFunction('return_pharmacy_sale_items', {
      originalDispenseId: dispenseId,
      returnItems,
      reason: document.getElementById('ph-return-reason').value.trim() || null,
    });
    closePhModal();
    loadPhCheckoutStats();
    showPhToast('Return processed and stock restored.', 'success');
  } catch (err) {
    errorEl.textContent = err.message;
  }
};

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

let phCurrentInvView = 'all';
document.querySelectorAll('.ph-inv-view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ph-inv-view-btn').forEach((b) => {
      b.classList.remove('bg-brand-700', 'text-white');
      b.classList.add('bg-champagne-100', 'text-brand-700');
    });
    btn.classList.remove('bg-champagne-100', 'text-brand-700');
    btn.classList.add('bg-brand-700', 'text-white');
    phCurrentInvView = btn.dataset.phInvView;
    document.getElementById('ph-new-medicine-btn-label').textContent = phCurrentInvView === 'suppliers' ? 'New Supplier' : 'New Medicine';
    loadPhInventory(phCurrentInvView);
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
    } else if (view === 'suppliers') {
      const { suppliers } = await window.phCallFunction('list_suppliers');
      if (!suppliers || suppliers.length === 0) {
        listEl.innerHTML = emptyState('No suppliers yet — add one to get started.', ICONS.box);
        return;
      }
      listEl.innerHTML = suppliers.map((s) => `
        <div class="px-5 py-4 flex items-center justify-between hover:bg-champagne-50/50 transition">
          <button onclick="window.phOpenSupplierEdit('${s.id}')" class="flex-1 text-left min-w-0">
            <p class="font-semibold text-brand-900 text-sm truncate">${escapePhHtml(s.name)}</p>
            <p class="text-xs text-charcoal/40 truncate">${[s.gstin, s.phone].filter(Boolean).map(escapePhHtml).join(' &middot; ') || 'No contact details yet'}</p>
          </button>
          ${phOverflowMenuHtml([
            { label: 'Edit', onclick: `window.phOpenSupplierEdit('${s.id}')` },
            { label: 'Merge into another supplier...', onclick: `window.phOpenMergeSupplier('${s.id}', '${escapePhAttr(s.name)}')` },
            { label: 'Deactivate', onclick: `window.phDeactivateSupplier('${s.id}', '${escapePhAttr(s.name)}')`, danger: true },
          ])}
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
          byMedicine[row.medicine_id] = { id: row.medicine_id, name: row.medicine_name, category: row.category, reorder: row.reorder_level, batches: [] };
        }
        if (row.batch_id) byMedicine[row.medicine_id].batches.push(row);
      });
      listEl.innerHTML = Object.values(byMedicine).map((m) => {
        const totalStock = m.batches.reduce((sum, b) => sum + (b.quantity_remaining || 0), 0);
        return `
          <div class="px-5 py-4 flex items-center justify-between hover:bg-champagne-50/50 transition">
            <button onclick="window.phOpenMedicineEdit('${m.id}')" class="flex-1 text-left min-w-0 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="font-semibold text-brand-900 text-sm truncate">${escapePhHtml(m.name)}</p>
                <p class="text-xs text-charcoal/40 truncate">${escapePhHtml(m.category || '')} &middot; ${m.batches.length} batch(es)</p>
              </div>
              ${stockChip(totalStock, m.reorder || 10)}
            </button>
            ${phOverflowMenuHtml([
              { label: 'Edit', onclick: `window.phOpenMedicineEdit('${m.id}')` },
              { label: 'Deactivate', onclick: `window.phDeactivateMedicine('${m.id}', '${escapePhAttr(m.name)}')`, danger: true },
            ])}
          </div>`;
      }).join('');
    }
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${escapePhHtml(err.message)}</p>`;
  }
}

window.phOpenMedicineEdit = async function (medicineId) {
  try {
    const { medicines } = await window.phCallFunction('list_medicines');
    const medicine = (medicines || []).find((m) => m.id === medicineId);
    if (!medicine) return showPhToast('Medicine not found.', 'error');
    openPhMedicineModal(medicine);
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

document.getElementById('ph-new-medicine-btn').addEventListener('click', () => {
  if (phCurrentInvView === 'suppliers') {
    openPhSupplierModal(null);
  } else {
    openPhMedicineModal(null);
  }
});

// ---- Supplier create/edit modal ----
window.phOpenSupplierEdit = async function (supplierId) {
  try {
    const { suppliers } = await window.phCallFunction('list_suppliers');
    const supplier = (suppliers || []).find((s) => s.id === supplierId);
    if (!supplier) return showPhToast('Supplier not found.', 'error');
    openPhSupplierModal(supplier);
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

function openPhSupplierModal(existingSupplier) {
  const isEdit = !!existingSupplier;
  const s = existingSupplier || {};
  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-1">${isEdit ? 'Edit Supplier' : 'New Supplier'}</h3>
      <p class="text-xs text-charcoal/40 mb-4">${isEdit ? escapePhHtml(s.name) : 'Fill in what you know — everything but the name is optional.'}</p>
      <div class="space-y-3">
        <input type="text" id="ph-new-sup-name" placeholder="Supplier name" value="${escapePhAttr(s.name || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-sup-contact" placeholder="Contact person" value="${escapePhAttr(s.contact_person || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <div class="grid grid-cols-2 gap-2">
          <input type="text" id="ph-new-sup-phone" placeholder="Phone" value="${escapePhAttr(s.phone || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="text" id="ph-new-sup-email" placeholder="Email" value="${escapePhAttr(s.email || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <input type="text" id="ph-new-sup-gstin" placeholder="GSTIN" value="${escapePhAttr(s.gstin || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="text" id="ph-new-sup-dl" placeholder="Drug license no." value="${escapePhAttr(s.dl_number || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        </div>
        <input type="text" id="ph-new-sup-address" placeholder="Address" value="${escapePhAttr(s.address || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <div class="grid grid-cols-3 gap-2">
          <input type="text" id="ph-new-sup-city" placeholder="City" value="${escapePhAttr(s.city || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="text" id="ph-new-sup-state" placeholder="State" value="${escapePhAttr(s.state || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="number" id="ph-new-sup-credit-days" placeholder="Credit days" value="${s.credit_days || ''}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        </div>
        <p class="text-[11px] font-bold text-charcoal/40 uppercase tracking-wide pt-1">Bank details</p>
        <input type="text" id="ph-new-sup-bank-name" placeholder="Bank name" value="${escapePhAttr(s.bank_name || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <div class="grid grid-cols-2 gap-2">
          <input type="text" id="ph-new-sup-bank-account" placeholder="Account number" value="${escapePhAttr(s.bank_account || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="text" id="ph-new-sup-bank-ifsc" placeholder="IFSC" value="${escapePhAttr(s.bank_ifsc || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        </div>
        <input type="text" id="ph-new-sup-upi" placeholder="UPI ID" value="${escapePhAttr(s.upi_id || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
      </div>
      <p id="ph-new-sup-error" class="text-red-600 text-sm mt-3 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-2">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phSaveSupplier(${isEdit ? `'${s.id}'` : 'null'})" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">${isEdit ? 'Save Changes' : 'Save'}</button>
      </div>
    </div>`);
}

window.phSaveSupplier = async function (existingId) {
  const errorEl = document.getElementById('ph-new-sup-error');
  const name = document.getElementById('ph-new-sup-name').value.trim();
  if (!name) {
    errorEl.textContent = 'Supplier name is required.';
    return;
  }
  try {
    await window.phCallFunction('upsert_supplier_full', {
      id: existingId || null,
      name,
      contactPerson: document.getElementById('ph-new-sup-contact').value.trim() || null,
      phone: document.getElementById('ph-new-sup-phone').value.trim() || null,
      email: document.getElementById('ph-new-sup-email').value.trim() || null,
      gstin: document.getElementById('ph-new-sup-gstin').value.trim() || null,
      dlNumber: document.getElementById('ph-new-sup-dl').value.trim() || null,
      address: document.getElementById('ph-new-sup-address').value.trim() || null,
      city: document.getElementById('ph-new-sup-city').value.trim() || null,
      state: document.getElementById('ph-new-sup-state').value.trim() || null,
      creditDays: parseInt(document.getElementById('ph-new-sup-credit-days').value, 10) || 0,
      bankName: document.getElementById('ph-new-sup-bank-name').value.trim() || null,
      bankAccount: document.getElementById('ph-new-sup-bank-account').value.trim() || null,
      bankIfsc: document.getElementById('ph-new-sup-bank-ifsc').value.trim() || null,
      upiId: document.getElementById('ph-new-sup-upi').value.trim() || null,
    });
    closePhModal();
    loadPhInventory('suppliers');
    showPhToast(existingId ? `${name} updated.` : `${name} added.`, 'success');
  } catch (err) {
    errorEl.textContent = err.message;
  }
};

// Opens the medicine modal either empty (new) or pre-filled (edit).
// existingMedicine is a row shape from list_medicines/get_medicines_with_wac
// (snake_case columns) or null for a brand-new medicine.
async function openPhMedicineModal(existingMedicine) {
  const isEdit = !!existingMedicine;
  let suppliers = [];
  try {
    const result = await window.phCallFunction('list_suppliers');
    suppliers = result.suppliers || [];
  } catch { /* supplier dropdown is optional, don't block the modal on it */ }

  const m = existingMedicine || {};
  const supplierOptions = suppliers.map((s) => `<option value="${s.id}" ${m.preferred_supplier_id === s.id ? 'selected' : ''}>${escapePhHtml(s.name)}</option>`).join('');

  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-1">${isEdit ? 'Edit Medicine' : 'New Medicine'}</h3>
      <p class="text-xs text-charcoal/40 mb-4">${isEdit ? escapePhHtml(m.name) : 'Fill in what you know — everything but the name is optional.'}</p>

      <div class="flex gap-1 mb-4 border-b border-champagne-200">
        <button type="button" data-med-modal-tab="basic" class="ph-med-modal-tab px-3 py-2 text-xs font-bold border-b-2 border-brand-700 text-brand-900">Basic</button>
        <button type="button" data-med-modal-tab="tax" class="ph-med-modal-tab px-3 py-2 text-xs font-bold border-b-2 border-transparent text-charcoal/40">Purchasing &amp; Tax</button>
      </div>

      <div data-med-modal-panel="basic" class="space-y-3">
        <input type="text" id="ph-new-med-name" placeholder="Name" value="${escapePhAttr(m.name || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-med-generic" placeholder="Generic name" value="${escapePhAttr(m.generic_name || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-med-manufacturer" placeholder="Manufacturer" value="${escapePhAttr(m.manufacturer || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <input type="text" id="ph-new-med-category" placeholder="Category" value="${escapePhAttr(m.category || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        <div class="grid grid-cols-2 gap-2">
          <select id="ph-new-med-formulation" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
            ${['tablet', 'capsule', 'syrup', 'cream', 'injection', 'drops', 'inhaler', 'powder', 'other'].map((f) =>
              `<option value="${f}" ${m.formulation === f ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}
          </select>
          <select id="ph-new-med-unit" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
            ${['strip', 'bottle', 'tube', 'vial', 'sachet', 'piece'].map((u) =>
              `<option value="${u}" ${m.unit === u ? 'selected' : ''}>${u[0].toUpperCase() + u.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <input type="number" id="ph-new-med-reorder" placeholder="Reorder level" value="${m.reorder_level ?? 10}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <select id="ph-new-med-schedule" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
            ${['NONE', 'H', 'H1', 'X', 'G'].map((s) => `<option value="${s}" ${m.drug_schedule === s ? 'selected' : ''}>Schedule ${s}</option>`).join('')}
          </select>
        </div>
      </div>

      <div data-med-modal-panel="tax" class="space-y-3 hidden">
        <div class="grid grid-cols-2 gap-2">
          <input type="text" id="ph-new-med-hsn" placeholder="HSN code" value="${escapePhAttr(m.hsn_code || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="number" id="ph-new-med-gst" placeholder="GST %" value="${m.gst_percent ?? ''}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        </div>
        <select id="ph-new-med-supplier" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
          <option value="">Preferred supplier (optional)</option>
          ${supplierOptions}
        </select>
        <div class="grid grid-cols-2 gap-2">
          <input type="text" id="ph-new-med-rep-name" placeholder="Rep name" value="${escapePhAttr(m.rep_name || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="text" id="ph-new-med-rep-phone" placeholder="Rep phone" value="${escapePhAttr(m.rep_phone || '')}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        </div>
        <p class="text-[11px] font-bold text-charcoal/40 uppercase tracking-wide pt-1">Scheme &amp; discount</p>
        <div class="grid grid-cols-3 gap-2">
          <input type="number" id="ph-new-med-scheme-buy" placeholder="Buy" value="${m.scheme_buy || ''}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="number" id="ph-new-med-scheme-free" placeholder="Free" value="${m.scheme_free || ''}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <input type="number" id="ph-new-med-brand-discount" placeholder="Disc %" value="${m.brand_discount || ''}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
        </div>
        <select id="ph-new-med-discount-type" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
          <option value="PTR" ${m.discount_type === 'PTR' ? 'selected' : ''}>Discount on PTR</option>
          <option value="MRP" ${m.discount_type === 'MRP' ? 'selected' : ''}>Discount on MRP</option>
        </select>
      </div>

      <p id="ph-new-med-error" class="text-red-600 text-sm mt-3 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-2">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phSaveMedicine(${isEdit ? `'${m.id}'` : 'null'})" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">${isEdit ? 'Save Changes' : 'Save'}</button>
      </div>
    </div>`);

  document.querySelectorAll('.ph-med-modal-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ph-med-modal-tab').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('border-brand-700', active);
        b.classList.toggle('text-brand-900', active);
        b.classList.toggle('border-transparent', !active);
        b.classList.toggle('text-charcoal/40', !active);
      });
      document.querySelectorAll('[data-med-modal-panel]').forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.medModalPanel !== btn.dataset.medModalTab);
      });
    });
  });
}

window.phSaveMedicine = async function (existingId) {
  const errorEl = document.getElementById('ph-new-med-error');
  const name = document.getElementById('ph-new-med-name').value.trim();
  if (!name) {
    errorEl.textContent = 'Name is required.';
    return;
  }
  try {
    await window.phCallFunction('upsert_medicine_full', {
      id: existingId || null,
      name,
      genericName: document.getElementById('ph-new-med-generic').value.trim() || null,
      manufacturer: document.getElementById('ph-new-med-manufacturer').value.trim() || null,
      category: document.getElementById('ph-new-med-category').value.trim() || null,
      formulation: document.getElementById('ph-new-med-formulation').value,
      unit: document.getElementById('ph-new-med-unit').value,
      reorderLevel: parseInt(document.getElementById('ph-new-med-reorder').value, 10) || 10,
      drugSchedule: document.getElementById('ph-new-med-schedule').value,
      hsnCode: document.getElementById('ph-new-med-hsn').value.trim() || null,
      gstPercent: parseFloat(document.getElementById('ph-new-med-gst').value) || 0,
      preferredSupplierId: document.getElementById('ph-new-med-supplier').value || null,
      repName: document.getElementById('ph-new-med-rep-name').value.trim() || null,
      repPhone: document.getElementById('ph-new-med-rep-phone').value.trim() || null,
      schemeBuy: parseFloat(document.getElementById('ph-new-med-scheme-buy').value) || 0,
      schemeFree: parseFloat(document.getElementById('ph-new-med-scheme-free').value) || 0,
      brandDiscount: parseFloat(document.getElementById('ph-new-med-brand-discount').value) || 0,
      discountType: document.getElementById('ph-new-med-discount-type').value,
    });
    closePhModal();
    loadPhInventory('all');
    loadPhInventoryStats();
    refreshPhBadges();
    showPhToast(existingId ? `${name} updated.` : `${name} added to inventory.`, 'success');
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
  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-1">Receive Purchase Order</h3>
      <p class="text-xs text-charcoal/40 mb-4">Confirm how this order was paid for.</p>
      <div class="space-y-3">
        <select id="ph-receive-po-payment-mode" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
          <option value="cash">Cash</option>
          <option value="upi">UPI</option>
          <option value="card">Card</option>
          <option value="other">Other / On Credit</option>
        </select>
        <div>
          <label class="text-xs font-semibold text-charcoal/50 mb-1 block">Amount paid</label>
          <input type="number" id="ph-receive-po-amount" value="${totalAmount}" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
          <p class="text-[11px] text-charcoal/40 mt-1">Invoice total is ${formatRupees(totalAmount)}. Enter less if this is a partial payment.</p>
        </div>
      </div>
      <p id="ph-receive-po-error" class="text-red-600 text-sm mt-3 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-2">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phConfirmReceivePO('${poId}')" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Confirm Receipt</button>
      </div>
    </div>`);
};

window.phConfirmReceivePO = async function (poId) {
  const errorEl = document.getElementById('ph-receive-po-error');
  const paymentMode = document.getElementById('ph-receive-po-payment-mode').value;
  const amountPaid = parseFloat(document.getElementById('ph-receive-po-amount').value) || 0;
  try {
    await window.phCallFunction('receive_purchase_order', { poId, paymentMode, amountPaid });
    closePhModal();
    loadPhPurchaseOrders();
    loadPhPoStats();
    refreshPhBadges();
    showPhToast('Purchase order received — stock updated.', 'success');
  } catch (err) {
    errorEl.textContent = err.message;
  }
};

let phPoLineItemCounter = 0;

function phPoLineItemRowHtml(rowId) {
  return `
    <div id="ph-po-line-${rowId}" class="border border-champagne-200 rounded-xl p-3 mb-2 relative">
      <button type="button" onclick="window.phRemovePoLineItem(${rowId})" class="absolute top-2 right-2 text-charcoal/30 hover:text-red-600 transition" aria-label="Remove line">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <input type="text" data-po-field="medName" placeholder="Medicine name" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm mb-2 pr-8" />
      <div class="grid grid-cols-2 gap-2 mb-2">
        <input type="text" data-po-field="batch" placeholder="Batch number" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="date" data-po-field="expiry" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
      </div>
      <div class="grid grid-cols-2 gap-2 mb-2">
        <input type="number" data-po-field="qty" placeholder="Quantity" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="number" data-po-field="free" placeholder="Free qty" value="0" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
      </div>
      <div class="grid grid-cols-3 gap-2">
        <input type="number" data-po-field="purchasePrice" placeholder="Cost ₹" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="number" data-po-field="sellingPrice" placeholder="Sell ₹" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="number" data-po-field="gst" placeholder="GST %" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
      </div>
    </div>`;
}

window.phAddPoLineItem = function () {
  const rowId = ++phPoLineItemCounter;
  document.getElementById('ph-po-line-items').insertAdjacentHTML('beforeend', phPoLineItemRowHtml(rowId));
};

window.phRemovePoLineItem = function (rowId) {
  const container = document.getElementById('ph-po-line-items');
  // Never let the last remaining line be removed -- a PO needs at
  // least one item, and re-adding one immediately after would just
  // confuse the flow.
  if (container.children.length <= 1) {
    showPhToast('A purchase order needs at least one line item.', 'info');
    return;
  }
  document.getElementById(`ph-po-line-${rowId}`)?.remove();
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

  phPoLineItemCounter = 0;
  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-4">New Purchase Order</h3>
      <div class="space-y-3 mb-3">
        <select id="ph-new-po-supplier" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm">
          <option value="">Select supplier...</option>
          ${suppliers.map((s) => `<option value="${s.id}">${escapePhHtml(s.name)}</option>`).join('')}
          <option value="__new__">+ Add new supplier</option>
        </select>
        <input type="text" id="ph-new-po-invoice" placeholder="Invoice number (optional)" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm" />
      </div>
      <div class="border-t border-champagne-200 pt-3">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs font-bold text-brand-700 uppercase tracking-wide">Line Items</p>
          <button type="button" onclick="window.phAddPoLineItem()" class="text-xs font-bold text-brand-700 hover:text-brand-900 transition flex items-center gap-1">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            Add Line
          </button>
        </div>
        <div id="ph-po-line-items" class="max-h-[40vh] overflow-y-auto pr-1"></div>
      </div>
      <p id="ph-new-po-error" class="text-red-600 text-sm mt-2 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-2">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phSaveNewPO()" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Create PO</button>
      </div>
    </div>`);

  window.phAddPoLineItem();

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

  if (!supplierId || supplierId === '__new__') {
    errorEl.textContent = 'Please select a supplier.';
    return;
  }

  const lineRows = Array.from(document.querySelectorAll('#ph-po-line-items > div'));
  const rawLines = lineRows.map((row) => ({
    medName: row.querySelector('[data-po-field="medName"]').value.trim(),
    batch: row.querySelector('[data-po-field="batch"]').value.trim(),
    expiry: row.querySelector('[data-po-field="expiry"]').value,
    qty: parseInt(row.querySelector('[data-po-field="qty"]').value, 10) || 0,
    free: parseInt(row.querySelector('[data-po-field="free"]').value, 10) || 0,
    purchasePrice: parseFloat(row.querySelector('[data-po-field="purchasePrice"]').value) || 0,
    sellingPrice: parseFloat(row.querySelector('[data-po-field="sellingPrice"]').value) || 0,
    gst: parseFloat(row.querySelector('[data-po-field="gst"]').value) || 0,
  }));

  const validLines = rawLines.filter((l) => l.medName);
  if (validLines.length === 0) {
    errorEl.textContent = 'At least one line item needs a medicine name.';
    return;
  }

  try {
    const { medicines } = await window.phCallFunction('list_medicines');
    const items = [];
    for (const line of validLines) {
      let medicine = medicines.find((m) => m.name.toLowerCase() === line.medName.toLowerCase());
      let medicineId;
      if (medicine) {
        medicineId = medicine.id;
      } else {
        const created = await window.phCallFunction('upsert_medicine', { name: line.medName });
        medicineId = created.id;
        medicines.push({ id: medicineId, name: line.medName }); // avoid re-creating if the same new name appears twice in this PO
      }
      items.push({
        medicine_id: medicineId,
        medicine_name: line.medName,
        batch_number: line.batch,
        expiry_date: line.expiry,
        quantity: line.qty,
        free_quantity: line.free,
        purchase_price: line.purchasePrice,
        selling_price: line.sellingPrice,
        gst_percent: line.gst,
      });
    }

    await window.phCallFunction('create_purchase_order', {
      supplierId,
      invoiceNumber: document.getElementById('ph-new-po-invoice').value.trim() || null,
      items,
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
    openPhInvoiceReviewModal(draft);
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

// Editable review step before an AI-extracted invoice is written to
// real stock -- addresses the audit finding that commit previously
// trusted the raw AI payload with no chance to fix a wrong qty/
// batch/price/name before it became a permanent stock movement.
function openPhInvoiceReviewModal(draft) {
  const aiData = draft.ai_data || {};
  const supplier = aiData.supplier || {};
  const invoice = aiData.invoice || {};
  const items = aiData.items || [];

  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-1">Review Invoice</h3>
      <p class="text-xs text-charcoal/40 mb-4">Check what the AI read before it's written to real stock — fix anything that looks wrong.</p>

      <p class="text-[11px] font-bold text-charcoal/40 uppercase tracking-wide mb-2">Supplier</p>
      <div class="grid grid-cols-2 gap-2 mb-4">
        <input type="text" id="ph-review-supplier-name" placeholder="Supplier name" value="${escapePhAttr(supplier.supplier_name || '')}" class="col-span-2 border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="text" id="ph-review-supplier-gstin" placeholder="GSTIN" value="${escapePhAttr(supplier.gstin || '')}" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="text" id="ph-review-supplier-phone" placeholder="Phone" value="${escapePhAttr(supplier.contact_phone || '')}" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
      </div>

      <p class="text-[11px] font-bold text-charcoal/40 uppercase tracking-wide mb-2">Invoice</p>
      <div class="grid grid-cols-2 gap-2 mb-4">
        <input type="text" id="ph-review-invoice-number" placeholder="Invoice number" value="${escapePhAttr(invoice.invoice_number || '')}" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="date" id="ph-review-invoice-date" value="${escapePhAttr(invoice.invoice_date || '')}" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="number" id="ph-review-invoice-total" placeholder="Grand total ₹" value="${invoice.grand_total ?? ''}" class="col-span-2 border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
      </div>

      <p class="text-[11px] font-bold text-charcoal/40 uppercase tracking-wide mb-2">Items</p>
      <div id="ph-review-items" class="space-y-2 max-h-[35vh] overflow-y-auto pr-1 mb-2">
        ${items.map((item, itemIdx) => (item.batches || [{}]).map((batch, batchIdx) => `
          <div class="border border-champagne-200 rounded-xl p-3" data-review-item-idx="${itemIdx}" data-review-batch-idx="${batchIdx}">
            <input type="text" data-review-field="product_name" placeholder="Medicine name" value="${escapePhAttr(item.product_name || '')}" class="w-full border border-champagne-300 rounded-lg px-2 py-1.5 text-sm mb-1.5" />
            <div class="grid grid-cols-2 gap-1.5 mb-1.5">
              <input type="text" data-review-field="batch_number" placeholder="Batch #" value="${escapePhAttr(batch.batch_number || '')}" class="border border-champagne-300 rounded-lg px-2 py-1.5 text-sm" />
              <input type="date" data-review-field="expiry_date" value="${escapePhAttr(batch.expiry_date || '')}" class="border border-champagne-300 rounded-lg px-2 py-1.5 text-sm" />
            </div>
            <div class="grid grid-cols-4 gap-1.5">
              <input type="number" data-review-field="qty_purchased" placeholder="Qty" value="${batch.qty_purchased ?? ''}" class="border border-champagne-300 rounded-lg px-2 py-1.5 text-sm" />
              <input type="number" data-review-field="free_qty" placeholder="Free" value="${batch.free_qty ?? 0}" class="border border-champagne-300 rounded-lg px-2 py-1.5 text-sm" />
              <input type="number" data-review-field="ptr" placeholder="Cost ₹" value="${batch.ptr ?? ''}" class="border border-champagne-300 rounded-lg px-2 py-1.5 text-sm" />
              <input type="number" data-review-field="mrp" placeholder="MRP ₹" value="${batch.mrp ?? ''}" class="border border-champagne-300 rounded-lg px-2 py-1.5 text-sm" />
            </div>
          </div>`).join('')).join('')}
      </div>

      <p id="ph-review-error" class="text-red-600 text-sm min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-2">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phConfirmCommitDraft('${draft.id}')" class="flex-1 bg-brand-900 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-brand-700 transition">Commit to Stock</button>
      </div>
    </div>`);
}

window.phConfirmCommitDraft = async function (draftId) {
  const errorEl = document.getElementById('ph-review-error');

  const supplier = {
    id: 'NEW',
    supplier_name: document.getElementById('ph-review-supplier-name').value.trim() || null,
    gstin: document.getElementById('ph-review-supplier-gstin').value.trim() || null,
    contact_phone: document.getElementById('ph-review-supplier-phone').value.trim() || null,
  };
  const invoice = {
    invoice_number: document.getElementById('ph-review-invoice-number').value.trim() || null,
    invoice_date: document.getElementById('ph-review-invoice-date').value || null,
    grand_total: parseFloat(document.getElementById('ph-review-invoice-total').value) || 0,
  };

  const itemRows = Array.from(document.querySelectorAll('#ph-review-items > div'));
  const items = itemRows.map((row) => {
    const field = (name) => row.querySelector(`[data-review-field="${name}"]`).value.trim();
    return {
      id: 'NEW',
      product_name: field('product_name'),
      batches: [{
        batch_number: field('batch_number'),
        expiry_date: field('expiry_date') || null,
        qty_purchased: parseInt(field('qty_purchased'), 10) || 0,
        free_qty: parseInt(field('free_qty'), 10) || 0,
        ptr: parseFloat(field('ptr')) || 0,
        mrp: parseFloat(field('mrp')) || 0,
        net_purchase_value: (parseInt(field('qty_purchased'), 10) || 0) * (parseFloat(field('ptr')) || 0),
      }],
    };
  }).filter((item) => item.product_name);

  if (items.length === 0) {
    errorEl.textContent = 'At least one item needs a medicine name.';
    return;
  }
  if (!supplier.supplier_name) {
    errorEl.textContent = 'Supplier name is required.';
    return;
  }

  try {
    await window.phCallFunction('commit_reviewed_invoice', {
      draft_id: draftId,
      supplier,
      invoice,
      items,
    });
    closePhModal();
    loadPhPendingApprovals();
    refreshPhBadges();
    showPhToast('Invoice committed — stock updated.', 'success');
  } catch (err) {
    errorEl.textContent = err.message;
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
      <div class="px-5 py-4 flex items-center justify-between">
        <div class="min-w-0">
          <p class="font-semibold text-brand-900 text-sm truncate">${escapePhHtml(r.rep_name)}</p>
          <p class="text-xs text-charcoal/50 truncate">${[r.company, r.division, r.phone].filter(Boolean).map(escapePhHtml).join(' &middot; ')}</p>
        </div>
        ${phOverflowMenuHtml([
          { label: 'Deactivate', onclick: `window.phDeactivateRep('${r.id}', '${escapePhAttr(r.rep_name)}')`, danger: true },
        ])}
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
// OVERFLOW MENU (⋮) — reused on medicine/supplier/rep rows for
// Edit/Deactivate/Merge actions that don't need their own button
// crowding the row.
// ==========================================================
let phOverflowMenuCounter = 0;
function phOverflowMenuHtml(items) {
  const menuId = `ph-overflow-${++phOverflowMenuCounter}`;
  const itemsHtml = items.map((item) => `
    <button onclick="document.getElementById('${menuId}').classList.add('hidden'); ${item.onclick}"
            class="w-full text-left px-4 py-2 text-sm ${item.danger ? 'text-red-600 hover:bg-red-50' : 'text-charcoal/70 hover:bg-champagne-50'} transition">
      ${escapePhHtml(item.label)}
    </button>`).join('');
  return `
    <div class="relative shrink-0">
      <button onclick="event.stopPropagation(); window.phToggleOverflowMenu('${menuId}')" class="p-1.5 text-charcoal/30 hover:text-charcoal/60 hover:bg-champagne-100 rounded-lg transition">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
      </button>
      <div id="${menuId}" class="hidden absolute right-0 top-full mt-1 bg-white rounded-xl shadow-xl border border-champagne-200 py-1 min-w-[180px] z-20">
        ${itemsHtml}
      </div>
    </div>`;
}
window.phToggleOverflowMenu = function (menuId) {
  const menu = document.getElementById(menuId);
  const wasHidden = menu.classList.contains('hidden');
  document.querySelectorAll('[id^="ph-overflow-"]').forEach((m) => m.classList.add('hidden'));
  if (wasHidden) menu.classList.remove('hidden');
};
document.addEventListener('click', () => {
  document.querySelectorAll('[id^="ph-overflow-"]').forEach((m) => m.classList.add('hidden'));
});

// ---- Deactivate actions ----
window.phDeactivateMedicine = async function (id, name) {
  const confirmed = await showPhConfirm(`Deactivate ${name}?`, 'It will be hidden from inventory and checkout, but its history is kept.');
  if (!confirmed) return;
  try {
    await window.phCallFunction('deactivate_medicine', { id });
    loadPhInventory('all');
    loadPhInventoryStats();
    showPhToast(`${name} deactivated.`, 'success');
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

window.phDeactivateSupplier = async function (id, name) {
  const confirmed = await showPhConfirm(`Deactivate ${name}?`, 'It will no longer appear when creating purchase orders.');
  if (!confirmed) return;
  try {
    await window.phCallFunction('deactivate_supplier', { id });
    loadPhInventory('suppliers');
    showPhToast(`${name} deactivated.`, 'success');
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

window.phDeactivateRep = async function (id, name) {
  const confirmed = await showPhConfirm(`Deactivate ${name}?`, 'They will be removed from the active reps list.');
  if (!confirmed) return;
  try {
    await window.phCallFunction('deactivate_medical_rep', { id });
    loadPhReps();
    showPhToast(`${name} deactivated.`, 'success');
  } catch (err) {
    showPhToast(err.message, 'error');
  }
};

// ---- Merge duplicate supplier ----
window.phOpenMergeSupplier = async function (duplicateId, duplicateName) {
  let suppliers = [];
  try {
    const result = await window.phCallFunction('list_suppliers');
    suppliers = (result.suppliers || []).filter((s) => s.id !== duplicateId);
  } catch (err) {
    showPhToast('Error loading suppliers: ' + err.message, 'error');
    return;
  }
  if (suppliers.length === 0) {
    showPhToast('No other suppliers to merge into.', 'info');
    return;
  }

  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-1">Merge Supplier</h3>
      <p class="text-xs text-charcoal/50 mb-4">
        Every medicine and purchase order pointing to <span class="font-semibold text-charcoal/70">${escapePhHtml(duplicateName)}</span>
        will be moved to the supplier you pick below, and <span class="font-semibold text-charcoal/70">${escapePhHtml(duplicateName)}</span> will be deleted. This can't be undone.
      </p>
      <select id="ph-merge-target-supplier" class="w-full border border-champagne-300 rounded-lg px-3 py-2.5 text-sm mb-2">
        <option value="">Merge into...</option>
        ${suppliers.map((s) => `<option value="${s.id}">${escapePhHtml(s.name)}</option>`).join('')}
      </select>
      <p id="ph-merge-error" class="text-red-600 text-sm min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-2">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2.5 text-sm font-semibold hover:bg-champagne-50 transition">Cancel</button>
        <button onclick="window.phConfirmMergeSupplier('${duplicateId}', '${escapePhAttr(duplicateName)}')" class="flex-1 bg-red-600 text-white rounded-lg py-2.5 text-sm font-bold hover:bg-red-700 transition">Merge &amp; Delete</button>
      </div>
    </div>`);
};

window.phConfirmMergeSupplier = async function (duplicateId, duplicateName) {
  const errorEl = document.getElementById('ph-merge-error');
  const masterId = document.getElementById('ph-merge-target-supplier').value;
  if (!masterId) {
    errorEl.textContent = 'Please choose a supplier to merge into.';
    return;
  }
  try {
    await window.phCallFunction('merge_duplicate_suppliers', { duplicateId, masterId });
    closePhModal();
    loadPhInventory('suppliers');
    showPhToast(`${duplicateName} merged and removed.`, 'success');
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
