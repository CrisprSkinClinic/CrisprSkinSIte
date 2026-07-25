// public/scripts/pharmacy-app.js
//
// Auth shell + all UI logic for /pharmacy. Kept as one file (unlike
// /prescription's shell+app split) since this tool has no large
// ported legacy blob to keep separate -- everything here is new,
// written against pharmacy-manager.js's 17 actions (whoami +
// suppliers/medicines CRUD + inventory views + PO flow +
// sale/void/return).

const phState = {
  session: null,
  profile: null,
  cart: [], // { medicineId, medicineName, batchId, batchNumber, quantity, unitPrice, gstPercent }
  selectedMedicine: null, // { id, name, batches: [...] }
  recentSales: [], // { dispenseId, billId, total, patientName, items }
};

let phSupabaseClient = null;

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
    // whoami fails with 403 if the signed-in account is neither a
    // pharmacist nor a doctor -- surface that clearly and sign out
    // rather than leaving them on a broken screen.
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
  document.getElementById('ph-user-name').textContent =
    `${phState.profile?.full_name || ''} · ${phState.profile?.role || ''}`;
  switchPhTab('checkout');
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

// ---- Tabs ----
function switchPhTab(tab) {
  document.querySelectorAll('.ph-tab-panel').forEach((el) => el.classList.add('hidden'));
  document.getElementById(`ph-tab-${tab}`).classList.remove('hidden');
  document.querySelectorAll('.ph-tab-btn').forEach((el) => {
    const active = el.dataset.phTab === tab;
    el.classList.toggle('border-brand-700', active);
    el.classList.toggle('text-brand-900', active);
    el.classList.toggle('border-transparent', !active);
    el.classList.toggle('text-charcoal/50', !active);
  });
  if (tab === 'inventory') loadPhInventory('all');
  if (tab === 'purchasing') loadPhPurchaseOrders();
}
document.querySelectorAll('.ph-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchPhTab(btn.dataset.phTab));
});

// ---- Helpers ----
function escapePhHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function formatRupees(amount) {
  return '₹' + Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ==========================================================
// CHECKOUT TAB
// ==========================================================
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
      // list_medicines has no server-side search param -- filtering
      // client-side is fine at the clinic's current medicine-catalog
      // scale (same tradeoff noted in rx-queue.js's search_patients
      // for name search at small scale).
      const { medicines } = await window.phCallFunction('list_medicines');
      const matches = medicines.filter((m) => m.name.toLowerCase().includes(query)).slice(0, 8);
      if (matches.length === 0) {
        resultsEl.innerHTML = '<div class="p-4 text-sm text-charcoal/40 text-center">No matching medicines.</div>';
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
      resultsEl.innerHTML = `<div class="p-4 text-sm text-red-600">${err.message}</div>`;
      resultsEl.classList.remove('hidden');
    }
  }, 300);
});

function escapePhAttr(text) {
  return (text || '').replace(/'/g, "\\'");
}

window.phSelectMedicine = async function (medicineId, medicineName) {
  document.getElementById('ph-med-results').classList.add('hidden');
  document.getElementById('ph-med-search').value = medicineName;
  const selectedEl = document.getElementById('ph-med-selected');
  const batchesEl = document.getElementById('ph-med-batches');
  selectedEl.classList.remove('hidden');
  document.getElementById('ph-med-selected-name').textContent = medicineName;
  batchesEl.innerHTML = '<p class="text-xs text-charcoal/40">Loading batches...</p>';

  try {
    const qty = parseInt(document.getElementById('ph-med-qty').value, 10) || 1;
    const { batches } = await window.phCallFunction('get_fifo_batches', { medicineId, quantity: qty });
    if (!batches || batches.length === 0) {
      batchesEl.innerHTML = '<p class="text-xs text-red-600">No stock available for this medicine.</p>';
      phState.selectedMedicine = { id: medicineId, name: medicineName, batches: [] };
      return;
    }
    phState.selectedMedicine = { id: medicineId, name: medicineName, batches };
    batchesEl.innerHTML = batches.map((b) => `
      <p class="text-xs text-charcoal/60">Batch ${escapePhHtml(b.batch_number)} — ${b.to_dispense} unit(s) @ ${formatRupees(b.unit_price)} <span class="text-charcoal/40">(exp ${b.expiry_date})</span></p>
    `).join('');
  } catch (err) {
    batchesEl.innerHTML = `<p class="text-xs text-red-600">${err.message}</p>`;
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

  // FIFO may split one requested quantity across multiple batches --
  // add one cart line per batch so execute_pharmacy_sale gets the
  // correct batch_id/quantity/unit_price per line.
  med.batches.forEach((b) => {
    phState.cart.push({
      medicineId: med.id,
      medicineName: med.name,
      batchId: b.batch_id,
      batchNumber: b.batch_number,
      quantity: b.to_dispense,
      unitPrice: b.unit_price,
      gstPercent: 0, // GST not tracked per-batch in medicine_batches; adjust here if a rate needs to be added later
    });
  });

  document.getElementById('ph-med-selected').classList.add('hidden');
  document.getElementById('ph-med-search').value = '';
  document.getElementById('ph-med-qty').value = 1;
  phState.selectedMedicine = null;
  renderPhCart();
});

function renderPhCart() {
  const listEl = document.getElementById('ph-cart-list');
  const emptyEl = document.getElementById('ph-cart-empty');
  const totalEl = document.getElementById('ph-cart-total');
  const checkoutBtn = document.getElementById('ph-checkout-btn');

  if (phState.cart.length === 0) {
    listEl.innerHTML = '';
    listEl.appendChild(emptyEl);
    emptyEl.classList.remove('hidden');
    totalEl.textContent = formatRupees(0);
    checkoutBtn.disabled = true;
    return;
  }

  const total = phState.cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  listEl.innerHTML = phState.cart.map((item, idx) => `
    <div class="flex items-center justify-between bg-champagne-50 rounded-lg px-3 py-2">
      <div>
        <p class="text-sm font-semibold text-brand-900">${escapePhHtml(item.medicineName)}</p>
        <p class="text-xs text-charcoal/50">Batch ${escapePhHtml(item.batchNumber)} &middot; ${item.quantity} &times; ${formatRupees(item.unitPrice)}</p>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-sm font-bold text-brand-900">${formatRupees(item.quantity * item.unitPrice)}</span>
        <button onclick="window.phRemoveFromCart(${idx})" class="text-charcoal/30 hover:text-red-600 transition text-lg leading-none">&times;</button>
      </div>
    </div>`).join('');
  totalEl.textContent = formatRupees(total);
  checkoutBtn.disabled = false;
}

window.phRemoveFromCart = function (idx) {
  phState.cart.splice(idx, 1);
  renderPhCart();
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
    document.getElementById('ph-cart-patient-name').value = '';
    document.getElementById('ph-cart-patient-phone').value = '';
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Complete Sale';
  }
});

function renderPhRecentSales() {
  const listEl = document.getElementById('ph-recent-sales');
  if (phState.recentSales.length === 0) {
    listEl.innerHTML = '<p class="text-charcoal/30 text-sm text-center py-4">No sales yet this session.</p>';
    return;
  }
  listEl.innerHTML = phState.recentSales.map((sale) => `
    <div class="flex items-center justify-between border border-champagne-200 rounded-lg px-4 py-3">
      <div>
        <p class="text-sm font-semibold text-brand-900">${escapePhHtml(sale.patientName)}</p>
        <p class="text-xs text-charcoal/50">${sale.items.length} item(s) &middot; ${formatRupees(sale.total)}</p>
      </div>
      <div class="flex gap-2">
        <button onclick="window.phVoidSale('${sale.dispenseId}')" class="text-xs font-semibold text-red-600 hover:text-red-800 transition">Void</button>
      </div>
    </div>`).join('');
}

window.phVoidSale = async function (dispenseId) {
  if (!confirm('Void this entire sale? This will restore stock and cannot be undone.')) return;
  try {
    await window.phCallFunction('void_pharmacy_sale', { originalDispenseId: dispenseId, reason: 'Voided from checkout screen' });
    phState.recentSales = phState.recentSales.filter((s) => s.dispenseId !== dispenseId);
    renderPhRecentSales();
  } catch (err) {
    alert('Error: ' + err.message);
  }
};

// ==========================================================
// INVENTORY TAB
// ==========================================================
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
  listEl.innerHTML = '<p class="text-charcoal/30 text-sm text-center py-8">Loading...</p>';
  try {
    if (view === 'low') {
      const { lowStock } = await window.phCallFunction('get_low_stock');
      if (!lowStock || lowStock.length === 0) {
        listEl.innerHTML = '<p class="text-charcoal/30 text-sm text-center py-8">No medicines are currently low on stock.</p>';
        return;
      }
      listEl.innerHTML = lowStock.map((m) => `
        <div class="px-5 py-4 flex items-center justify-between">
          <div>
            <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(m.medicine_name)}</p>
            <p class="text-xs text-red-600">${m.total_stock} in stock &middot; reorder at ${m.reorder_level}</p>
          </div>
        </div>`).join('');
    } else if (view === 'expiring') {
      const { expiringBatches } = await window.phCallFunction('get_expiring_batches', { withinDays: 90 });
      if (!expiringBatches || expiringBatches.length === 0) {
        listEl.innerHTML = '<p class="text-charcoal/30 text-sm text-center py-8">No batches expiring within 90 days.</p>';
        return;
      }
      listEl.innerHTML = expiringBatches.map((b) => `
        <div class="px-5 py-4 flex items-center justify-between">
          <div>
            <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(b.medicine_name)}</p>
            <p class="text-xs text-charcoal/50">Batch ${escapePhHtml(b.batch_number)} &middot; ${b.quantity_remaining} remaining</p>
          </div>
          <span class="text-xs font-semibold text-red-600">Expires ${b.expiry_date}</span>
        </div>`).join('');
    } else {
      const { inventory } = await window.phCallFunction('get_inventory');
      if (!inventory || inventory.length === 0) {
        listEl.innerHTML = '<p class="text-charcoal/30 text-sm text-center py-8">No medicines yet — add one to get started.</p>';
        return;
      }
      // Group rows by medicine (one row per batch from the RPC).
      const byMedicine = {};
      inventory.forEach((row) => {
        if (!byMedicine[row.medicine_id]) {
          byMedicine[row.medicine_id] = { name: row.medicine_name, category: row.category, batches: [] };
        }
        if (row.batch_id) {
          byMedicine[row.medicine_id].batches.push(row);
        }
      });
      listEl.innerHTML = Object.values(byMedicine).map((m) => {
        const totalStock = m.batches.reduce((sum, b) => sum + (b.quantity_remaining || 0), 0);
        return `
          <div class="px-5 py-4">
            <div class="flex items-center justify-between">
              <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(m.name)}</p>
              <span class="text-sm font-bold text-brand-700">${totalStock} in stock</span>
            </div>
            <p class="text-xs text-charcoal/40">${escapePhHtml(m.category || '')} &middot; ${m.batches.length} batch(es)</p>
          </div>`;
      }).join('');
    }
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${err.message}</p>`;
  }
}

document.getElementById('ph-new-medicine-btn').addEventListener('click', () => {
  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-4">New Medicine</h3>
      <div class="space-y-3">
        <input type="text" id="ph-new-med-name" placeholder="Name" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="text" id="ph-new-med-generic" placeholder="Generic name" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <input type="text" id="ph-new-med-category" placeholder="Category" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <select id="ph-new-med-formulation" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm">
          <option value="tablet">Tablet</option>
          <option value="capsule">Capsule</option>
          <option value="syrup">Syrup</option>
          <option value="cream">Cream</option>
          <option value="ointment">Ointment</option>
          <option value="lotion">Lotion</option>
          <option value="injection">Injection</option>
          <option value="drops">Drops</option>
        </select>
        <select id="ph-new-med-unit" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm">
          <option value="strip">Strip</option>
          <option value="bottle">Bottle</option>
          <option value="tube">Tube</option>
          <option value="vial">Vial</option>
          <option value="piece">Piece</option>
        </select>
        <input type="number" id="ph-new-med-reorder" placeholder="Reorder level" value="10" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
      </div>
      <p id="ph-new-med-error" class="text-red-500 text-sm mt-2 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-4">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2 text-sm font-semibold">Cancel</button>
        <button onclick="window.phSaveNewMedicine()" class="flex-1 bg-brand-900 text-white rounded-lg py-2 text-sm font-bold">Save</button>
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
  } catch (err) {
    errorEl.textContent = err.message;
  }
};

// ==========================================================
// PURCHASE ORDERS TAB
// ==========================================================
async function loadPhPurchaseOrders() {
  const listEl = document.getElementById('ph-po-list');
  listEl.innerHTML = '<p class="text-charcoal/30 text-sm text-center py-8">Loading...</p>';
  try {
    const { purchaseOrders } = await window.phCallFunction('list_purchase_orders');
    if (!purchaseOrders || purchaseOrders.length === 0) {
      listEl.innerHTML = '<p class="text-charcoal/30 text-sm text-center py-8">No purchase orders yet.</p>';
      return;
    }
    const statusColors = { pending: 'bg-champagne-100 text-brand-700', partial: 'bg-blue-50 text-blue-700', paid: 'bg-green-50 text-green-700' };
    listEl.innerHTML = purchaseOrders.map((po) => `
      <div class="px-5 py-4 flex items-center justify-between">
        <div>
          <p class="font-semibold text-brand-900 text-sm">${escapePhHtml(po.po_number)}</p>
          <p class="text-xs text-charcoal/50">${formatRupees(po.total_amount)} &middot; ${po.invoice_number ? 'Invoice ' + escapePhHtml(po.invoice_number) : 'No invoice number'}</p>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${statusColors[po.payment_status] || 'bg-slate-100'}">${po.payment_status}</span>
          ${po.delivery_date ? '' : `<button onclick="window.phReceivePO('${po.id}', ${po.total_amount})" class="text-xs font-bold text-brand-700 hover:text-brand-900 transition">Receive</button>`}
        </div>
      </div>`).join('');
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-red-600 text-center py-8">${err.message}</p>`;
  }
}

window.phReceivePO = async function (poId, totalAmount) {
  const paymentMode = prompt('Payment mode (cash / upi / card):', 'cash');
  if (!paymentMode) return;
  try {
    await window.phCallFunction('receive_purchase_order', { poId, paymentMode, amountPaid: totalAmount });
    loadPhPurchaseOrders();
  } catch (err) {
    alert('Error: ' + err.message);
  }
};

// New PO modal -- a lightweight single-item-at-a-time builder rather
// than a full dynamic-rows form, since receiving is the far more
// frequent action once a PO exists; this keeps the modal simple.
document.getElementById('ph-new-po-btn').addEventListener('click', async () => {
  let suppliers = [];
  try {
    const result = await window.phCallFunction('list_suppliers');
    suppliers = result.suppliers || [];
  } catch (err) {
    alert('Error loading suppliers: ' + err.message);
    return;
  }

  showPhModal(`
    <div class="p-6">
      <h3 class="text-lg font-bold text-brand-900 mb-4">New Purchase Order</h3>
      <div class="space-y-3">
        <select id="ph-new-po-supplier" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Select supplier...</option>
          ${suppliers.map((s) => `<option value="${s.id}">${escapePhHtml(s.name)}</option>`).join('')}
          <option value="__new__">+ Add new supplier</option>
        </select>
        <input type="text" id="ph-new-po-invoice" placeholder="Invoice number (optional)" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
        <div class="border-t border-champagne-200 pt-3">
          <p class="text-xs font-bold text-brand-700 uppercase tracking-wide mb-2">Line Item</p>
          <input type="text" id="ph-new-po-med-name" placeholder="Medicine name" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm mb-2" />
          <input type="text" id="ph-new-po-batch" placeholder="Batch number" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm mb-2" />
          <input type="date" id="ph-new-po-expiry" class="w-full border border-champagne-300 rounded-lg px-3 py-2 text-sm mb-2" />
          <div class="grid grid-cols-2 gap-2 mb-2">
            <input type="number" id="ph-new-po-qty" placeholder="Quantity" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
            <input type="number" id="ph-new-po-free" placeholder="Free qty" value="0" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div class="grid grid-cols-3 gap-2">
            <input type="number" id="ph-new-po-purchase-price" placeholder="Cost ₹" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
            <input type="number" id="ph-new-po-selling-price" placeholder="Sell ₹" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
            <input type="number" id="ph-new-po-gst" placeholder="GST %" class="border border-champagne-300 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
      </div>
      <p id="ph-new-po-error" class="text-red-500 text-sm mt-2 min-h-[1.25rem]"></p>
      <div class="flex gap-2 mt-4">
        <button onclick="closePhModal()" class="flex-1 border border-champagne-300 rounded-lg py-2 text-sm font-semibold">Cancel</button>
        <button onclick="window.phSaveNewPO()" class="flex-1 bg-brand-900 text-white rounded-lg py-2 text-sm font-bold">Create PO</button>
      </div>
    </div>`);

  document.getElementById('ph-new-po-supplier').addEventListener('change', async (e) => {
    if (e.target.value !== '__new__') return;
    const name = prompt('New supplier name:');
    if (!name) { e.target.value = ''; return; }
    try {
      const { id } = await window.phCallFunction('upsert_supplier', { name });
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      opt.selected = true;
      e.target.insertBefore(opt, e.target.lastElementChild);
    } catch (err) {
      alert('Error: ' + err.message);
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
    // Resolve or create the medicine by name first (PO items need a
    // medicine_id, and the pharmacist may be ordering something new).
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
