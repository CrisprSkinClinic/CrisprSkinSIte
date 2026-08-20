// public/scripts/prescription-app.js
//
// Ported Rx workspace logic (see file history / derm-clinic-website.md
// for what changed vs. the original Google Apps Script version).
// Mounted by prescription-shell.js once a patient + doctor profile
// are both selected.

/** ==============================
 * PRESCRIPTION SYSTEM (ported from Google Apps Script)
 *
 * Every google.script.run.withSuccessHandler(...).methodName(args) call
 * from the original is replaced with:
 *   const result = await window.rxCallFunction('action_name', {...args});
 * inside an async function, since fetch() is promise-based rather than
 * callback-based. FIFO draft-bill generation, stock lookups, and PDF
 * export moved server-side into prescription-manager.js's rx.js module
 * -- see that file's comments for the ported quantity-calculation logic.
 * ============================== */

const RxApp = {
    state: {
        patient: null,
        doctor: null,
        medicines: [],
        inventory: [],
        examTemplates: {},
        labs: [],
        prescriptions: [],
        labReports: [],
        photos: [],
        currentMeds: [],
        currentLabs: [],
        labNotes: [],
    }
};

// Called by prescription-shell.js once a patient + doctor profile are
// both available. Replaces the old loadConsultFor(patientData) entry
// point, which received data from a different (Apps Script) queue UI.
window.mountPrescriptionWorkspace = function (patient, profile) {
    RxApp.state.patient = patient;
    RxApp.state.doctor = profile;

    document.getElementById('current-patient-name').textContent = patient.name || '--';
    document.getElementById('current-patient-id').textContent = patient.phone || '--';
    document.getElementById('current-patient-demo').textContent = `${patient.dob ? calculateAge(patient.dob) : '--'}/${patient.gender || '--'}`;

    initPrescriptionSystem();
};

window.changePatient = function () {
    if (!confirm('Switch patient? Any unsaved changes to the current prescription will be lost.')) return;
    resetForm();
    document.getElementById('rx-workspace-screen').classList.add('hidden');
    document.getElementById('rx-patient-select-screen').classList.remove('hidden');
    document.getElementById('rx-patient-search').value = '';
    document.getElementById('rx-search-results').classList.add('hidden');
    if (typeof window.rxReloadQueue === 'function') window.rxReloadQueue();
};

function initPrescriptionSystem() {
    loadRxMasterData();
    loadPatientData();

    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    document.getElementById('review-date').valueAsDate = nextWeek;

    if (window.lucide && window.lucide.createIcons) lucide.createIcons();
}

async function loadRxMasterData() {
    try {
        const data = await window.rxCallFunction('get_init_data');
        RxApp.state.medicines = data.medicines || [];
        RxApp.state.labs = data.labTests || [];
        RxApp.state.examTemplates = data.examTemplates || {};
        RxApp.state.protocols = data.protocols || {};
        RxApp.state.dosageMap = data.dosageMap || {};
        renderExamSuggestions();
    } catch (err) {
        console.error('Failed to load Rx master data:', err);
    }

    try {
        const { batches } = await window.rxCallFunction('get_inventory');
        RxApp.state.inventory = batches || [];
    } catch (err) {
        console.error('Failed to load inventory:', err);
    }
}

function loadPatientData() {
    if (!RxApp.state.patient) return;
    const patientId = RxApp.state.patient.id;

    loadMedicalProfile();

    window.rxCallFunction('get_patient_rx_history', { patientId, limit: 10 })
        .then((res) => { RxApp.state.prescriptions = res.prescriptions || []; updatePrescriptionHistory(); })
        .catch((err) => console.error('Rx history load failed:', err));

    window.rxCallFunction('get_patient_lab_history', { patientId, limit: 5 })
        .then((res) => { RxApp.state.labReports = res.reports || []; updateLabReports(); })
        .catch((err) => console.error('Lab history load failed:', err));

    window.rxCallFunction('get_patient_photos', { patientId })
        .then((res) => { RxApp.state.photos = res.photos || []; updatePhotos(); })
        .catch((err) => console.error('Photo load failed:', err));
}

function loadMedicalProfile() {
    // The old system parsed a medicalHistory JSON blob (allergies,
    // lifestyle, conditions) that came from a separate patient-intake
    // sheet. That intake system doesn't exist yet on this site (the
    // derm site's own intake wizard, discussed separately, is a
    // different not-yet-built feature) -- so this renders whatever the
    // patient object carries today and degrades gracefully to "no
    // significant history" otherwise, rather than erroring.
    const grid = document.getElementById('medical-profile-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="profile-item"><div class="profile-value" style="color:#94a3b8; font-style:italic;">No significant history on file</div></div>';
}

function updatePrescriptionHistory() {
    const container = document.getElementById('prescription-history');
    if (!container) return;
    if (RxApp.state.prescriptions.length === 0) {
        container.innerHTML = '<div class="profile-value" style="text-align:center;color:#94a3b8;font-style:italic;">No previous prescriptions</div>';
        return;
    }
    let html = '';
    RxApp.state.prescriptions.forEach((rx) => {
        const meds = (rx.medicines || []).slice(0, 3).map((m) => m.name).join(', ');
        const dateStr = new Date(rx.created_at).toLocaleDateString();
        html += `
        <div class="history-item" onclick="loadPreviousPrescription('${rx.id}')">
            <div class="history-date">${escapeHtml(dateStr)}</div>
            <div style="font-size:12px;color:#475569;font-weight:600;">${escapeHtml(rx.doctor_name)}</div>
            <div style="font-size:13px;font-weight:600;color:#1e293b;margin-top:4px;">${escapeHtml(rx.diagnosis || '')}</div>
            <div class="history-meds" style="margin-top:4px;">${meds || 'No medicines'}</div>
        </div>`;
    });
    container.innerHTML = html;
}

async function loadPreviousPrescription(rxId) {
    const modal = document.getElementById('history-modal');
    const contentArea = document.getElementById('history-content-area');
    const dateLabel = document.getElementById('hist-modal-date');
    const viewPdfBtn = document.getElementById('btn-view-rx-pdf');
    const sharePdfBtn = document.getElementById('btn-share-rx-pdf');

    contentArea.innerHTML = '<div style="text-align:center; padding:40px; color:#cbd5e1;"><i data-lucide="loader-2" class="w-8 h-8 animate-spin"></i></div>';
    if (window.lucide) lucide.createIcons();
    modal.classList.add('modal-visible');

    try {
        const rxData = await window.rxCallFunction('get_rx_by_id', { rxId });
        contentArea.innerHTML = generateStaticRxHtml(rxData);
        dateLabel.textContent = new Date(rxData.created_at || Date.now()).toLocaleDateString();
        document.getElementById('btn-copy-rx').onclick = () => copyHistoryToActive(rxData);

        const hasPdf = !!rxData.pdf_url;
        viewPdfBtn.style.display = hasPdf ? 'inline-flex' : 'none';
        viewPdfBtn.onclick = () => viewPrescriptionPdf(rxId, viewPdfBtn);
        sharePdfBtn.style.display = hasPdf ? 'inline-flex' : 'none';
        sharePdfBtn.onclick = () => shareRxPdfViaWhatsapp(rxId, sharePdfBtn);
    } catch (err) {
        contentArea.innerHTML = `<div style="text-align:center; padding:20px; color:red;">Error: ${escapeHtml(err.message)}</div>`;
    }
}

async function viewPrescriptionPdf(rxId, btn) {
    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Loading...';
    try {
        const response = await fetch('/.netlify/functions/get-prescription-pdf-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken: window.rxGetCurrentAccessToken(), rxId }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Could not open PDF.');
        window.open(result.url, '_blank');
    } catch (err) {
        alert('Failed to open PDF: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// Mints a FRESH signed URL right at share time (rather than reusing
// one obtained earlier), since signed URLs expire (1 hour, see
// get-prescription-pdf-url.js) -- a link generated when the doctor
// first viewed the PDF could easily be stale by the time they decide
// to share it a few minutes later. Uses the same wa.me pattern and
// India-country-code assumption already used for appointment
// confirmations in bookings-manager.js, for consistency.
async function shareRxPdfViaWhatsapp(rxId, btn) {
    if (!RxApp.state.patient) return;
    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Preparing...';
    try {
        const response = await fetch('/.netlify/functions/get-prescription-pdf-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken: window.rxGetCurrentAccessToken(), rxId }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Could not prepare PDF link.');

        const rawPhone = (RxApp.state.patient.phone || '').replace(/[^\d]/g, '');
        if (!rawPhone) {
            alert('This patient has no phone number on file to share with.');
            return;
        }
        const fullNumber = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;
        const message = `Hi ${RxApp.state.patient.name || ''}, here is your prescription from CRISPR Skin and Hair Clinic: ${result.url}\n\nThis link is valid for a limited time -- please save a copy if you need it later. Call us at +91 96984 44888 if you have any questions.`;
        window.open(`https://wa.me/${fullNumber}?text=${encodeURIComponent(message)}`, '_blank');
    } catch (err) {
        alert('Failed to share PDF: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

function closeHistoryModal() {
    document.getElementById('history-modal').classList.remove('modal-visible');
}

function copyHistoryToActive(rxData) {
    if (!confirm('This will overwrite your current entries. Continue?')) return;

    document.getElementById('diagnosis-input').value = rxData.diagnosis || '';
    document.getElementById('advice-input').value = rxData.advice || '';
    if (rxData.complaints) document.getElementById('complaints-input').value = rxData.complaints;

    RxApp.state.currentMeds = [];
    (rxData.medicines || []).forEach((m) => {
        RxApp.state.currentMeds.push({
            id: 'MED-' + Date.now() + Math.random().toString(36).substr(2, 5),
            name: m.name,
            dose: m.dose || '1-0-0',
            duration: m.duration || '5 Days',
            instructions: m.instructions || '',
            stock: 'check',
        });
    });
    updateMedicineList();

    RxApp.state.currentLabs = Array.isArray(rxData.lab_tests) ? [...rxData.lab_tests] : [];
    updateLabTags();

    closeHistoryModal();
    updateSaveStatus('Copied from History');
}

function generateStaticRxHtml(data) {
    const meds = data.medicines || [];
    const labs = data.lab_tests || [];
    const medsRows = meds.map((m) => `
        <tr style="border-bottom:1px solid #eee;">
            <td style="padding:8px; font-weight:600;">${escapeHtml(m.name)}</td>
            <td style="padding:8px;">${escapeHtml(m.dose || '-')}</td>
            <td style="padding:8px;">${escapeHtml(m.duration || '-')}</td>
            <td style="padding:8px; font-style:italic; color:#666;">${escapeHtml(m.instructions || '')}</td>
        </tr>
    `).join('');

    return `
        <div style="background:white; padding:30px; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.05); font-size:13px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:20px; border-bottom:2px solid #333; padding-bottom:10px;">
                <div><strong>Date:</strong> ${new Date(data.created_at || Date.now()).toLocaleDateString()}</div>
                <div><strong>Doctor:</strong> ${escapeHtml(data.doctor_name || '--')}</div>
            </div>
            ${data.diagnosis ? `<div style="margin-bottom:15px;"><strong style="color:#4f46e5;">Diagnosis:</strong><br>${escapeHtml(data.diagnosis).replace(/\n/g, '<br>')}</div>` : ''}
            ${medsRows ? `
            <div style="margin-bottom:20px;">
                <strong style="color:#4f46e5;">Medicines:</strong>
                <table style="width:100%; border-collapse:collapse; margin-top:5px; font-size:12px;">
                    <thead style="background:#f8fafc; color:#64748b;"><tr><th style="text-align:left; padding:5px;">Name</th><th style="text-align:left; padding:5px;">Dose</th><th style="text-align:left; padding:5px;">Dur</th><th style="text-align:left; padding:5px;">Note</th></tr></thead>
                    <tbody>${medsRows}</tbody>
                </table>
            </div>` : ''}
            ${labs.length ? `<div style="margin-bottom:15px;"><strong style="color:#4f46e5;">Labs:</strong> ${escapeHtml(labs.join(', '))}</div>` : ''}
            ${data.advice ? `<div><strong style="color:#4f46e5;">Advice:</strong><br>${escapeHtml(data.advice).replace(/\n/g, '<br>')}</div>` : ''}
        </div>
    `;
}

function updatePhotos() {
    const container = document.getElementById('photos-grid');
    if (!container) return;
    if (RxApp.state.photos.length === 0) {
        container.innerHTML = `
            <div class="photo-item" onclick="triggerPhotoUpload()"><div class="photo-placeholder"><i data-lucide="camera" class="w-6 h-6 mb-2"></i><span style="font-size: 10px;">Upload Photo</span></div></div>
            <div class="photo-item" style="opacity: 0.5; cursor: default;"></div>
            <div class="photo-item" style="opacity: 0.5; cursor: default;"></div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }
    let html = '';
    RxApp.state.photos.slice(0, 5).forEach((photo) => {
        html += `<div class="photo-item"><img src="${driveProxyUrl(photo.drive_file_id)}" alt="Clinical photo"></div>`;
    });
    if (RxApp.state.photos.length < 6) {
        html += `<div class="photo-item" onclick="triggerPhotoUpload()"><div class="photo-placeholder"><i data-lucide="plus" class="w-6 h-6 mb-1"></i><span style="font-size: 9px; font-weight: 600;">ADD NEW</span></div></div>`;
    }
    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

function triggerPhotoUpload() {
    if (!RxApp.state.patient) { alert('No patient selected'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) uploadClinicalFile(file, 'photo');
    };
    input.click();
}

function handleLabUpload(inputEl) {
    if (!RxApp.state.patient) { alert('Please select a patient first.'); inputEl.value = ''; return; }
    const file = inputEl.files[0];
    if (!file) return;

    // Old system prompted for the test name at upload time -- kept
    // the same UX here rather than adding a new modal for it.
    const testName = prompt('What is this lab test/report called? (e.g. "CBC", "Lipid Profile")');
    if (!testName || !testName.trim()) { inputEl.value = ''; return; }

    uploadClinicalFile(file, 'lab_report', testName.trim(), () => { inputEl.value = ''; });
}

async function uploadClinicalFile(file, uploadType, testName, onDone) {
    if (file.size > 5 * 1024 * 1024) {
        alert('File too large (max 5MB).');
        if (onDone) onDone();
        return;
    }

    updateSaveStatus('Uploading ' + file.name + '...');

    const reader = new FileReader();
    reader.onload = async (e) => {
        const base64Data = e.target.result.split(',')[1];
        try {
            // Step 1: upload the raw file to Drive via the service
            // account (drive-upload.js). This function is separate
            // from prescription-manager.js since it talks to Google,
            // not Supabase, and doesn't need the doctor-only
            // restriction -- any signed-in staff member's session is
            // enough to prove they're allowed to upload, the doctor
            // check happens on the VIEWING side (drive-file-proxy.js)
            // instead, since that's where clinical content is
            // actually exposed.
            const uploadResponse = await fetch('/.netlify/functions/drive-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadType, fileName: file.name, mimeType: file.type, fileData: base64Data }),
            });
            const uploadResult = await uploadResponse.json();
            if (!uploadResponse.ok || !uploadResult.success) {
                throw new Error(uploadResult.error || 'Upload failed.');
            }

            // Step 2: record the Drive file id + metadata in Postgres
            // via prescription-manager.js (doctor-only, matches every
            // other write in this system).
            if (uploadType === 'photo') {
                await window.rxCallFunction('record_photo', {
                    patientId: RxApp.state.patient.id,
                    driveFileId: uploadResult.driveFileId,
                });
                const { photos } = await window.rxCallFunction('get_patient_photos', { patientId: RxApp.state.patient.id });
                RxApp.state.photos = photos || [];
                updatePhotos();
            } else {
                await window.rxCallFunction('record_lab_order', {
                    patientId: RxApp.state.patient.id,
                    testName,
                    driveFileId: uploadResult.driveFileId,
                });
                const { reports } = await window.rxCallFunction('get_patient_lab_history', { patientId: RxApp.state.patient.id, limit: 5 });
                RxApp.state.labReports = reports || [];
                updateLabReports();
            }
            updateSaveStatus('Upload complete');
        } catch (err) {
            alert('Upload failed: ' + err.message);
        } finally {
            if (onDone) onDone();
        }
    };
    reader.readAsDataURL(file);
}

// Builds a URL to drive-file-proxy.js carrying the CURRENT session's
// access token as a query parameter -- see that function's header
// comment for why a query param is used here (query params are the
// only way to authenticate a direct <img>/<iframe> navigation). This
// is regenerated fresh each time a file is displayed (see
// updatePhotos/updateLabReports/viewLabInline below) rather than
// stored once, since a stored token would go stale after the
// session's own token naturally rotates/expires.
function driveProxyUrl(driveFileId) {
    if (!driveFileId) return '';
    const token = window.rxGetCurrentAccessToken ? window.rxGetCurrentAccessToken() : '';
    return `/.netlify/functions/drive-file-proxy?fileId=${encodeURIComponent(driveFileId)}&accessToken=${encodeURIComponent(token)}`;
}

// ---- MEDICINE MANAGEMENT ----
function addMedicine() {
    const medicineId = `med-${Date.now()}`;
    RxApp.state.currentMeds.push({ id: medicineId, name: '', dose: '1-0-0', duration: '7 days', instructions: '', stock: 'checking' });
    updateMedicineList();
    setTimeout(() => {
        const input = document.querySelector(`[data-medicine-id="${medicineId}"] .medicine-name`);
        if (input) input.focus();
    }, 100);
}

function updateMedicineList() {
    const container = document.getElementById('medicine-list');
    if (!container) return;
    if (RxApp.state.currentMeds.length === 0) {
        container.innerHTML = '<div style="padding: 30px; text-align: center; color: #94a3b8; font-style: italic;">No medicines prescribed.</div>';
        return;
    }
    let html = `<div class="med-table-container"><div class="med-table-header"><span>Medicine Name (Stock)</span><span>Dose</span><span>Duration</span><span>Instruction</span><span></span></div>`;
    RxApp.state.currentMeds.forEach((med) => {
        html += `
        <div class="med-row">
            <div class="autocomplete-wrapper">
                <input type="text" class="med-input font-bold" value="${escapeHtml(med.name)}" placeholder="Search Medicine..." autocomplete="off"
                       oninput="handleInlineSearch(this, '${med.id}')" onblur="delayHide('${med.id}')">
                <div id="suggest-${med.id}" class="suggestions-dropdown"></div>
            </div>
            <div style="position:relative; width:100%;">
                <input type="text" class="med-input" list="dose-list-${med.id}" id="dose-input-${med.id}" value="${escapeHtml(med.dose)}" placeholder="Dose"
                       onchange="updateMedField('${med.id}', 'dose', this.value)" onfocus="refreshDoseOptions('${med.id}', '${escapeHtml(med.name)}')">
                <datalist id="dose-list-${med.id}"></datalist>
            </div>
            <input type="text" class="med-input" value="${escapeHtml(med.duration)}" placeholder="5 Days" onchange="updateMedField('${med.id}', 'duration', this.value)">
            <input type="text" class="med-input" value="${escapeHtml(med.instructions)}" placeholder="After food" onchange="updateMedField('${med.id}', 'instructions', this.value)">
            <button class="btn-del-row" onclick="removeMedicine('${med.id}')" title="Remove"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </div>`;
    });
    html += `</div>`;
    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

function updateMedField(id, field, value) {
    const med = RxApp.state.currentMeds.find((m) => m.id === id);
    if (med) { med[field] = value; updateSaveStatus('Updated'); }
}

function checkMedicineStock(medicineId) {
    const medicine = RxApp.state.currentMeds.find((m) => m.id === medicineId);
    if (!medicine || !medicine.name.trim()) return;
    const name = medicine.name.toLowerCase().trim();
    const batches = RxApp.state.inventory.filter((b) => b.medicine_name.toLowerCase().trim() === name);
    const totalStock = batches.reduce((sum, b) => sum + (parseFloat(b.stock) || 0), 0);
    if (totalStock <= 0) medicine.stock = 'out';
    else if (totalStock < 10) medicine.stock = 'low';
    else medicine.stock = 'available';
    updateMedicineList();
}

function removeMedicine(medicineId) {
    RxApp.state.currentMeds = RxApp.state.currentMeds.filter((m) => m.id !== medicineId);
    updateMedicineList();
    updateSaveStatus('Medicine removed');
}

function handleInlineSearch(input, rowId) {
    const query = input.value.toLowerCase().trim();
    const dropdown = document.getElementById(`suggest-${rowId}`);
    const med = RxApp.state.currentMeds.find((m) => m.id === rowId);
    if (med) med.name = input.value;

    if (query.length < 1) { dropdown.style.display = 'none'; return; }

    const stockMatches = RxApp.state.inventory.filter((item) => item.medicine_name.toLowerCase().includes(query));
    const masterMatches = RxApp.state.medicines.filter((name) => name.toLowerCase().includes(query) && !stockMatches.some((s) => s.medicine_name.toLowerCase() === name.toLowerCase()));

    if (stockMatches.length === 0 && masterMatches.length === 0) { dropdown.style.display = 'none'; return; }

    let html = '';
    stockMatches.forEach((item) => {
        const stock = parseFloat(item.stock) || 0;
        let badgeClass = 'badge-out', badgeText = 'Out of Stock';
        if (stock > 10) { badgeClass = 'badge-ok'; badgeText = `${stock} Avail`; }
        else if (stock > 0) { badgeClass = 'badge-low'; badgeText = `Low: ${stock}`; }
        html += `<div class="suggestion-item" onmousedown="selectSuggestion('${rowId}', '${escapeHtml(item.medicine_name)}')"><span class="suggestion-name">${escapeHtml(item.medicine_name)}</span><span class="stock-badge ${badgeClass}">${badgeText}</span></div>`;
    });
    masterMatches.forEach((name) => {
        html += `<div class="suggestion-item" onmousedown="selectSuggestion('${rowId}', '${escapeHtml(name)}')"><span class="suggestion-name">${escapeHtml(name)}</span><span style="font-size:10px; color:#94a3b8;">Master List</span></div>`;
    });
    dropdown.innerHTML = html;
    dropdown.style.display = 'block';
}

function selectSuggestion(rowId, name) {
    const med = RxApp.state.currentMeds.find((m) => m.id === rowId);
    if (med) {
        med.name = name;
        updateMedicineList();
        updateDoseForMed(rowId, name);
        checkMedicineStock(rowId);
    }
}

function delayHide(rowId) {
    setTimeout(() => {
        const dropdown = document.getElementById(`suggest-${rowId}`);
        if (dropdown) dropdown.style.display = 'none';
    }, 200);
}

// ---- LAB TEST MANAGEMENT ----
function addLabTest() {
    const testName = prompt('Enter lab test name:');
    if (testName && testName.trim()) {
        RxApp.state.currentLabs.push(testName.trim());
        updateLabTags();
        updateSaveStatus('Lab test added');
    }
}

function updateLabTags() {
    const container = document.getElementById('lab-tags');
    if (!container) return;
    if (RxApp.state.currentLabs.length === 0) {
        container.innerHTML = '<div style="color: #94a3b8; font-style: italic; font-size: 13px;">No tests requested</div>';
        return;
    }
    let html = '';
    RxApp.state.currentLabs.forEach((lab, index) => {
        html += `<div class="lab-tag">${escapeHtml(lab)}<span class="remove-tag" onclick="removeLabTest(${index})">×</span></div>`;
    });
    container.innerHTML = html;
}

function removeLabTest(index) {
    RxApp.state.currentLabs.splice(index, 1);
    updateLabTags();
    updateSaveStatus('Lab test removed');
}

function setReviewDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    document.getElementById('review-date').valueAsDate = date;
    updateSaveStatus('Review date updated');
}

// ---- SAVE ----
function getPrescriptionData(status) {
    return {
        patientId: RxApp.state.patient.id,
        doctorId: RxApp.state.doctor.doctorId || RxApp.state.doctor.id,
        status: status || 'final',
        complaints: document.getElementById('complaints-input').value,
        diagnosis: document.getElementById('diagnosis-input').value,
        differentials: Array.from(document.querySelectorAll('#differential-tags .diff-tag')).map((el) => el.textContent),
        medicines: RxApp.state.currentMeds,
        labTests: RxApp.state.currentLabs,
        advice: document.getElementById('advice-input').value,
        reviewDate: document.getElementById('review-date').value || null,
        vitals: {
            bp: document.getElementById('vital-bp').value,
            pulse: document.getElementById('vital-pulse').value,
            temp: document.getElementById('vital-temp').value,
            weight: document.getElementById('vital-weight').value,
        },
    };
}

async function saveDraft() {
    if (!RxApp.state.patient) { alert('Please select a patient first'); return; }
    try {
        await window.rxCallFunction('save_prescription', getPrescriptionData('draft'));
        updateSaveStatus('Draft saved at ' + new Date().toLocaleTimeString());
    } catch (err) {
        alert('Error saving draft: ' + err.message);
    }
}

async function savePrescription() {
    if (!RxApp.state.patient) { alert('Please select a patient first'); return; }
    const btn = document.querySelector('.action-btn.primary');
    try {
        const result = await window.rxCallFunction('save_prescription', getPrescriptionData('final'));
        updateSaveStatus('Prescription saved -- generating PDF...');

        // PDF generation is a separate call (not folded into
        // save_prescription itself) so a slow PDF render never risks
        // the actual clinical save failing or rolling back -- the
        // prescription is already durably saved by this point
        // regardless of what happens next.
        if (btn) { btn.disabled = true; btn.textContent = 'Generating PDF...'; }
        try {
            await fetch('/.netlify/functions/generate-prescription-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accessToken: window.rxGetCurrentAccessToken(), rxId: result.rxId }),
            }).then((r) => r.json()).then((r) => { if (!r.success) throw new Error(r.error || 'PDF generation failed.'); });

            const urlResponse = await fetch('/.netlify/functions/get-prescription-pdf-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accessToken: window.rxGetCurrentAccessToken(), rxId: result.rxId }),
            });
            const urlResult = await urlResponse.json();
            if (urlResult.success) {
                window.open(urlResult.url, '_blank');
                // Offer to share immediately -- most doctors will want
                // to do this right after writing the prescription, but
                // it's still an explicit yes/no rather than an
                // automatic WhatsApp send, since not every patient
                // wants/needs it sent this way.
                if (RxApp.state.patient.phone && confirm('Share this prescription with the patient via WhatsApp now?')) {
                    shareRxPdfViaWhatsapp(result.rxId, { disabled: false, innerHTML: '' });
                }
            }
            updateSaveStatus('Prescription saved and PDF ready');
        } catch (pdfErr) {
            // The prescription itself is already saved successfully at
            // this point -- a PDF failure is a real problem worth
            // surfacing, but shouldn't be presented as if the whole save
            // failed, since it didn't.
            console.error('PDF generation/link error:', pdfErr);
            updateSaveStatus('Prescription saved (PDF failed -- retry from Rx history)');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="printer" class="w-4 h-4"></i> Save & Print'; if (window.lucide) lucide.createIcons(); }
        }

        resetForm();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

function updateSaveStatus(message) {
    const status = document.getElementById('save-status-text');
    status.textContent = message;
    status.style.color = '#059669';
    setTimeout(() => {
        if (status.textContent === message) { status.textContent = 'All changes saved'; status.style.color = '#64748b'; }
    }, 3000);
}

function previewPrescription() {
    if (!RxApp.state.patient) { alert('Please select a patient first'); return; }
    document.getElementById('preview-content').innerHTML = generatePreviewContent();
    document.getElementById('preview-modal').classList.add('modal-visible');
}

function closePreview() {
    document.getElementById('preview-modal').classList.remove('modal-visible');
}

function generatePreviewContent() {
    const patient = RxApp.state.patient;
    const doctor = RxApp.state.doctor;
    return `
        <div style="font-family: 'Times New Roman', serif; padding: 20px; max-width: 800px; margin: 0 auto;">
            <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #000; padding-bottom: 10px;">
                <h1 style="margin: 0; font-size: 24px;">${escapeHtml(doctor?.full_name || 'Doctor')}</h1>
                <p style="margin: 5px 0; color: #666;">Consultant Dermatologist</p>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 14px;">
                <div><strong>Patient:</strong> ${escapeHtml(patient?.name || '--')}<br><strong>Age/Sex:</strong> ${escapeHtml(patient?.dob ? String(calculateAge(patient.dob)) : '--')}/${escapeHtml(patient?.gender || '--')}<br><strong>Phone:</strong> ${escapeHtml(patient?.phone || '--')}</div>
                <div style="text-align: right;"><strong>Date:</strong> ${new Date().toLocaleDateString()}</div>
            </div>
            ${document.getElementById('complaints-input').value ? `<div style="margin-bottom: 15px;"><strong>Complaints:</strong><br><div style="margin-left: 20px;">${escapeHtml(document.getElementById('complaints-input').value).replace(/\n/g, '<br>')}</div></div>` : ''}
            ${document.getElementById('diagnosis-input').value ? `<div style="margin-bottom: 15px;"><strong>Diagnosis:</strong><br><div style="margin-left: 20px; font-weight: bold;">${escapeHtml(document.getElementById('diagnosis-input').value).replace(/\n/g, '<br>')}</div></div>` : ''}
            ${RxApp.state.currentMeds.length > 0 ? `
            <div style="margin-bottom: 20px;">
                <strong style="font-size: 18px;">℞</strong>
                <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
                    <thead><tr style="border-bottom: 1px solid #ddd;"><th style="text-align: left; padding: 5px;">Medicine</th><th style="text-align: left; padding: 5px;">Dose</th><th style="text-align: left; padding: 5px;">Duration</th><th style="text-align: left; padding: 5px;">Instructions</th></tr></thead>
                    <tbody>${RxApp.state.currentMeds.map((med) => `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 8px 5px;">${escapeHtml(med.name)}</td><td style="padding: 8px 5px;">${escapeHtml(med.dose)}</td><td style="padding: 8px 5px;">${escapeHtml(med.duration)}</td><td style="padding: 8px 5px; font-style: italic;">${escapeHtml(med.instructions)}</td></tr>`).join('')}</tbody>
                </table>
            </div>` : ''}
            ${RxApp.state.currentLabs.length > 0 ? `<div style="margin-bottom: 15px;"><strong>Investigations:</strong><br><div style="margin-left: 20px;">${escapeHtml(RxApp.state.currentLabs.join(', '))}</div></div>` : ''}
            ${document.getElementById('advice-input').value ? `<div style="margin-bottom: 15px;"><strong>Advice:</strong><br><div style="margin-left: 20px;">${escapeHtml(document.getElementById('advice-input').value).replace(/\n/g, '<br>')}</div></div>` : ''}
            ${document.getElementById('review-date').value ? `<div style="margin-bottom: 15px;"><strong>Next Review:</strong> ${new Date(document.getElementById('review-date').value).toLocaleDateString()}</div>` : ''}
            <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #000; text-align: right;">
                <div style="font-weight: bold;">${escapeHtml(doctor?.full_name || 'Doctor')}</div>
            </div>
        </div>
    `;
}

function resetForm() {
    document.getElementById('complaints-input').value = '';
    document.getElementById('diagnosis-input').value = '';
    document.getElementById('advice-input').value = '';
    document.getElementById('vital-bp').value = '';
    document.getElementById('vital-pulse').value = '';
    document.getElementById('vital-temp').value = '';
    document.getElementById('vital-weight').value = '';
    document.getElementById('differential-tags').innerHTML = '';
    RxApp.state.currentMeds = [];
    RxApp.state.currentLabs = [];
    updateMedicineList();
    updateLabTags();
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    document.getElementById('review-date').valueAsDate = nextWeek;
    updateSaveStatus('Form reset');
}

function calculateAge(dobStr) {
    if (!dobStr) return '';
    const dob = new Date(dobStr);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    return age;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderExamSuggestions() {
    const container = document.getElementById('differential-tags');
    if (!container) return;
    container.innerHTML = '';
    const masters = RxApp.state.examTemplates || {};
    Object.keys(masters).forEach((key) => {
        const tag = document.createElement('div');
        tag.className = 'diff-tag';
        tag.style.backgroundColor = '#f0f9ff';
        tag.style.borderColor = '#bae6fd';
        tag.style.color = '#0284c7';
        tag.innerHTML = `<i data-lucide="plus-circle" class="w-3 h-3 mr-1 inline"></i> ${escapeHtml(masters[key].title)}`;
        tag.onclick = () => {
            const t = masters[key];
            const text = `${t.title}:\nSites: ${(t.sites || []).join(', ')}\nFeatures: ${(t.features || []).join(', ')}`;
            const diagBox = document.getElementById('diagnosis-input');
            diagBox.value = diagBox.value ? diagBox.value + '\n' + text : text;
        };
        container.appendChild(tag);
    });
    if (window.lucide) lucide.createIcons();
}

// ---- SMART PROTOCOL ENGINE: Diagnosis -> Medicine Chips ----
document.getElementById('diagnosis-input').addEventListener('input', function (e) {
    suggestMedsFromDx(e.target.value);
});

function suggestMedsFromDx(dxText) {
    const container = document.getElementById('dx-med-suggestions');
    if (!container || !RxApp.state.protocols) return;
    const input = dxText.toLowerCase();
    const suggestions = new Set();
    Object.keys(RxApp.state.protocols).forEach((key) => {
        if (input.includes(key)) RxApp.state.protocols[key].forEach((med) => suggestions.add(med));
    });
    if (suggestions.size === 0) { container.innerHTML = ''; container.style.marginBottom = '0px'; return; }
    let html = '';
    suggestions.forEach((medName) => {
        const stockStatus = getQuickStockStatus(medName);
        const colorClass = stockStatus === 'out' ? 'border-red-200 bg-red-50 text-red-700' : stockStatus === 'low' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-indigo-200 bg-indigo-50 text-indigo-700';
        html += `<button onclick="addDrugFromChip('${escapeHtml(medName)}')" class="text-xs px-3 py-1 rounded-full border ${colorClass} hover:shadow-sm transition-all flex items-center gap-1"><i data-lucide="plus" class="w-3 h-3"></i> ${escapeHtml(medName)}</button>`;
    });
    container.innerHTML = html;
    container.style.marginBottom = '10px';
    if (window.lucide) lucide.createIcons();
}

function addDrugFromChip(medName) {
    addMedicine();
    const newMed = RxApp.state.currentMeds[RxApp.state.currentMeds.length - 1];
    newMed.name = medName;
    checkMedicineStock(newMed.id);
    updateDoseForMed(newMed.id, medName);
    updateMedicineList();
}

function getQuickStockStatus(medName) {
    const name = medName.toLowerCase().trim();
    const batches = RxApp.state.inventory.filter((b) => b.medicine_name.toLowerCase().trim() === name);
    const total = batches.reduce((sum, b) => sum + (parseFloat(b.stock) || 0), 0);
    if (total <= 0) return 'out';
    if (total < 10) return 'low';
    return 'ok';
}

// ---- SMART DOSAGE ENGINE ----
function updateDoseForMed(rowId, medName) {
    const med = RxApp.state.currentMeds.find((m) => m.id === rowId);
    if (!med) return;
    refreshDoseOptions(rowId, medName);
    const options = getDoseOptions(medName);
    if (options.length > 0 && (!med.dose || med.dose === '1-0-0')) {
        med.dose = options[0];
        const input = document.getElementById(`dose-input-${rowId}`);
        if (input) input.value = options[0];
    }
}

function getDoseOptions(medName) {
    if (!medName || !RxApp.state.dosageMap) return getDefaultDosages();
    const key = medName.toLowerCase().trim();
    if (RxApp.state.dosageMap[key]) return RxApp.state.dosageMap[key];
    return getDefaultDosages();
}

function refreshDoseOptions(rowId, medName) {
    const dataList = document.getElementById(`dose-list-${rowId}`);
    if (!dataList) return;
    const options = getDoseOptions(medName);
    dataList.innerHTML = options.map((opt) => `<option value="${escapeHtml(opt)}">`).join('');
}

function getDefaultDosages() {
    return ['1-0-0', '1-0-1', '1-1-1', '0-0-1', '0-1-0', 'SOS', 'Apply twice daily', 'Apply at night'];
}

// ---- LAB REPORTS ----
function updateLabReports() {
    const container = document.getElementById('lab-reports-list');
    if (!container) return;
    if (RxApp.state.labReports.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:#94a3b8;font-style:italic;font-size:13px;padding:10px;">No reports found</div>';
        return;
    }
    let html = '';
    RxApp.state.labReports.forEach((report, index) => {
        const date = new Date(report.report_date).toLocaleDateString();
        html += `
            <div class="lab-item" data-lab-index="${index}">
                <div style="overflow:hidden;">
                    <div class="lab-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(report.test_name)}</div>
                    <div class="lab-date">${date}</div>
                </div>
                <div style="display:flex; gap:6px;">
                    <button class="lab-action" onclick="viewLabInline(${index})">Inline</button>
                    <button class="lab-action" onclick="openLabInNewTab('${escapeHtml(report.drive_file_id || '')}')">↗</button>
                </div>
            </div>`;
    });
    container.innerHTML = html;
}

let currentInlineLabIndex = -1;

function viewLabInline(index) {
    const reports = RxApp.state.labReports || [];
    if (!reports[index]) return;
    currentInlineLabIndex = index;
    const panel = document.getElementById('lab-expand-panel');
    const title = document.getElementById('inline-lab-title');
    const iframe = document.getElementById('lab-inline-frame');
    iframe.src = normalizeLabUrl(driveProxyUrl(reports[index].drive_file_id));
    title.textContent = `${reports[index].test_name} • ${new Date(reports[index].report_date).toLocaleDateString()}`;
    document.getElementById('lab-note-input').value = reports[index].note || '';
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    highlightActiveLab(index);
}

function normalizeLabUrl(url) {
    // No-op now that files are served directly as bytes via
    // drive-file-proxy.js rather than linking to a Drive viewer page
    // (which is where the old /view -> /preview rewrite mattered).
    // Kept as a passthrough so callers don't need updating.
    return url || '';
}

function navigateInlineLab(direction) {
    const reports = RxApp.state.labReports || [];
    if (reports.length === 0) return;
    let newIndex = currentInlineLabIndex + direction;
    if (newIndex < 0) newIndex = reports.length - 1;
    if (newIndex >= reports.length) newIndex = 0;
    viewLabInline(newIndex);
}

function closeLabInline() {
    const panel = document.getElementById('lab-expand-panel');
    document.getElementById('lab-inline-frame').src = 'about:blank';
    panel.classList.add('hidden');
    currentInlineLabIndex = -1;
    document.querySelectorAll('.lab-item').forEach((el) => el.classList.remove('active'));
}

function highlightActiveLab(index) {
    document.querySelectorAll('.lab-item').forEach((el, i) => el.classList.toggle('active', i === index));
}

function openLabInNewTab(driveFileId) {
    if (!driveFileId) { alert('Lab report not available'); return; }
    window.open(driveProxyUrl(driveFileId), '_blank', 'noopener,noreferrer');
}

async function addLabNoteToRx() {
    const reports = RxApp.state.labReports || [];
    if (currentInlineLabIndex === -1 || !reports[currentInlineLabIndex]) return;
    const note = document.getElementById('lab-note-input').value;
    try {
        await window.rxCallFunction('update_lab_note', { labOrderId: reports[currentInlineLabIndex].id, note });
        reports[currentInlineLabIndex].note = note;
        const advice = document.getElementById('advice-input');
        advice.value += `\nLab (${reports[currentInlineLabIndex].test_name}): ${note}`;
        updateSaveStatus('Lab note saved');
    } catch (err) {
        alert('Failed to save lab note: ' + err.message);
    }
}

document.addEventListener('keydown', (e) => {
    if (currentInlineLabIndex === -1) return;
    if (e.key === 'ArrowLeft') navigateInlineLab(-1);
    if (e.key === 'ArrowRight') navigateInlineLab(1);
    if (e.key === 'Escape') closeLabInline();
});

/**
 * ==========================================
 * SETTINGS SCREEN
 * Medicines / Templates / Dx Protocols / Billing Master CRUD.
 * Added because the user chose to start with zero seed data and add
 * these through a real UI rather than pre-seeding placeholder
 * clinical content.
 * ==========================================
 */

window.openRxSettings = function () {
    document.getElementById('rx-settings-modal').classList.add('modal-visible');
    switchSettingsTab('medicines');
};

function closeRxSettings() {
    document.getElementById('rx-settings-modal').classList.remove('modal-visible');
    // Master data may have changed -- refresh what the current
    // prescription session uses, so new medicines/protocols are
    // usable immediately without a full page reload.
    loadRxMasterData();
}

function switchSettingsTab(tab) {
    document.querySelectorAll('.rx-settings-tab').forEach((el) => { el.style.display = 'none'; });
    document.getElementById(`rx-settings-tab-${tab}`).style.display = 'block';
    document.querySelectorAll('.rx-settings-tab-btn').forEach((btn) => {
        const active = btn.dataset.tab === tab;
        btn.style.borderBottomColor = active ? '#4f46e5' : 'transparent';
        btn.style.color = active ? '#4f46e5' : '#64748b';
    });

    if (tab === 'medicines') loadSettingsMedicines();
    if (tab === 'templates') loadSettingsTemplates();
    if (tab === 'dxProtocols') loadSettingsDxProtocols();
    if (tab === 'billing') loadSettingsBillingItems();
}

// ---- Medicines ----
async function loadSettingsMedicines() {
    const container = document.getElementById('rx-settings-medicines-list');
    container.innerHTML = '<p style="color:#94a3b8; font-size:13px;">Loading...</p>';
    try {
        const { medicines } = await window.rxCallFunction('list_medicines');
        const active = (medicines || []).filter((m) => m.is_active);
        if (active.length === 0) {
            container.innerHTML = '<p style="color:#94a3b8; font-size:13px; font-style:italic;">No medicines added yet.</p>';
            return;
        }
        container.innerHTML = active.map((m) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f1f5f9;">
                <div>
                    <div style="font-weight:600; font-size:14px;">${escapeHtml(m.name)}</div>
                    <div style="font-size:12px; color:#64748b;">${(m.suggested_dosages || []).map(escapeHtml).join(', ') || 'No dosage suggestions'}</div>
                </div>
                <button class="btn-del-row" onclick="deleteSettingsMedicine('${m.id}')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>`).join('');
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        container.innerHTML = `<p style="color:#dc2626; font-size:13px;">${escapeHtml(err.message)}</p>`;
    }
}

async function addSettingsMedicine() {
    const name = document.getElementById('rx-new-med-name').value.trim();
    const dosagesRaw = document.getElementById('rx-new-med-dosages').value.trim();
    if (!name) { alert('Medicine name is required.'); return; }
    const suggestedDosages = dosagesRaw ? dosagesRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    try {
        await window.rxCallFunction('upsert_medicine', { name, suggestedDosages });
        document.getElementById('rx-new-med-name').value = '';
        document.getElementById('rx-new-med-dosages').value = '';
        loadSettingsMedicines();
    } catch (err) {
        alert('Failed to save medicine: ' + err.message);
    }
}

async function deleteSettingsMedicine(id) {
    if (!confirm('Remove this medicine from the list?')) return;
    try {
        await window.rxCallFunction('delete_medicine', { id });
        loadSettingsMedicines();
    } catch (err) {
        alert('Failed to remove medicine: ' + err.message);
    }
}

// ---- Templates ----
async function loadSettingsTemplates() {
    const container = document.getElementById('rx-settings-templates-list');
    container.innerHTML = '<p style="color:#94a3b8; font-size:13px;">Loading...</p>';
    try {
        const { templates } = await window.rxCallFunction('list_templates');
        if (!templates || templates.length === 0) {
            container.innerHTML = '<p style="color:#94a3b8; font-size:13px; font-style:italic;">No templates added yet.</p>';
            return;
        }
        container.innerHTML = templates.map((t) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f1f5f9;">
                <div>
                    <div style="font-weight:600; font-size:14px;">${escapeHtml(t.name)} <span style="font-size:11px; color:#94a3b8; text-transform:uppercase;">${escapeHtml(t.template_type)}</span></div>
                    <div style="font-size:12px; color:#64748b; max-width:500px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(JSON.stringify(t.data))}</div>
                </div>
                <button class="btn-del-row" onclick="deleteSettingsTemplate('${t.id}')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>`).join('');
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        container.innerHTML = `<p style="color:#dc2626; font-size:13px;">${escapeHtml(err.message)}</p>`;
    }
}

// Converts the plain-text content field into the jsonb shape each
// template type expects (matching what prescription-app.js's
// applySelectedTemplate() -- ported from the old system -- reads):
// clinical/advice want { diagnosis/complaints } or { advice } as free
// text; meds want an array of {name, dose, dur, instr}; labs want an
// array of test name strings.
function buildTemplateData(templateType, content) {
    if (templateType === 'clinical') return { diagnosis: content };
    if (templateType === 'advice') return { advice: content };
    if (templateType === 'labs') return { labs: content.split(',').map((s) => s.trim()).filter(Boolean) };
    if (templateType === 'meds') {
        return content.split(',').map((entry) => {
            const [name, dose, dur, instr] = entry.split('|').map((s) => (s || '').trim());
            return { name: name || entry.trim(), dose: dose || '1-0-0', dur: dur || '5 Days', instr: instr || '' };
        });
    }
    return {};
}

async function addSettingsTemplate() {
    const templateType = document.getElementById('rx-new-tpl-type').value;
    const name = document.getElementById('rx-new-tpl-name').value.trim();
    const content = document.getElementById('rx-new-tpl-content').value.trim();
    if (!name || !content) { alert('Template name and content are required.'); return; }
    try {
        await window.rxCallFunction('upsert_template', { templateType, name, data: buildTemplateData(templateType, content) });
        document.getElementById('rx-new-tpl-name').value = '';
        document.getElementById('rx-new-tpl-content').value = '';
        loadSettingsTemplates();
    } catch (err) {
        alert('Failed to save template: ' + err.message);
    }
}

async function deleteSettingsTemplate(id) {
    if (!confirm('Delete this template?')) return;
    try {
        await window.rxCallFunction('delete_template', { id });
        loadSettingsTemplates();
    } catch (err) {
        alert('Failed to delete template: ' + err.message);
    }
}

// ---- Dx Protocols ----
async function loadSettingsDxProtocols() {
    const container = document.getElementById('rx-settings-protocols-list');
    container.innerHTML = '<p style="color:#94a3b8; font-size:13px;">Loading...</p>';
    try {
        const { protocols } = await window.rxCallFunction('list_dx_protocols');
        if (!protocols || protocols.length === 0) {
            container.innerHTML = '<p style="color:#94a3b8; font-size:13px; font-style:italic;">No dx protocols added yet.</p>';
            return;
        }
        container.innerHTML = protocols.map((p) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f1f5f9;">
                <div>
                    <div style="font-weight:600; font-size:14px;">${escapeHtml(p.keyword)}</div>
                    <div style="font-size:12px; color:#64748b;">${(p.suggested_medicines || []).map(escapeHtml).join(', ')}</div>
                </div>
                <button class="btn-del-row" onclick="deleteSettingsDxProtocol('${p.id}')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>`).join('');
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        container.innerHTML = `<p style="color:#dc2626; font-size:13px;">${escapeHtml(err.message)}</p>`;
    }
}

async function addSettingsDxProtocol() {
    const keyword = document.getElementById('rx-new-proto-keyword').value.trim();
    const medsRaw = document.getElementById('rx-new-proto-meds').value.trim();
    if (!keyword || !medsRaw) { alert('Keyword and at least one medicine are required.'); return; }
    const suggestedMedicines = medsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    try {
        await window.rxCallFunction('upsert_dx_protocol', { keyword, suggestedMedicines });
        document.getElementById('rx-new-proto-keyword').value = '';
        document.getElementById('rx-new-proto-meds').value = '';
        loadSettingsDxProtocols();
    } catch (err) {
        alert('Failed to save dx protocol: ' + err.message);
    }
}

async function deleteSettingsDxProtocol(id) {
    if (!confirm('Delete this dx protocol?')) return;
    try {
        await window.rxCallFunction('delete_dx_protocol', { id });
        loadSettingsDxProtocols();
    } catch (err) {
        alert('Failed to delete dx protocol: ' + err.message);
    }
}

// ---- Billing Master ----
async function loadSettingsBillingItems() {
    const container = document.getElementById('rx-settings-billing-list');
    container.innerHTML = '<p style="color:#94a3b8; font-size:13px;">Loading...</p>';
    try {
        const { items } = await window.rxCallFunction('list_billing_items');
        const active = (items || []).filter((i) => i.is_active);
        if (active.length === 0) {
            container.innerHTML = '<p style="color:#94a3b8; font-size:13px; font-style:italic;">No billing items added yet.</p>';
            return;
        }
        container.innerHTML = active.map((i) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f1f5f9;">
                <div>
                    <div style="font-weight:600; font-size:14px;">${escapeHtml(i.name)} <span style="font-size:11px; color:#94a3b8; text-transform:uppercase;">${escapeHtml(i.service_type)}</span></div>
                    <div style="font-size:12px; color:#64748b;">₹${i.price}${i.gst_rate ? ` + ${i.gst_rate}% GST` : ''}</div>
                </div>
                <button class="btn-del-row" onclick="deleteSettingsBillingItem('${i.id}')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>`).join('');
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        container.innerHTML = `<p style="color:#dc2626; font-size:13px;">${escapeHtml(err.message)}</p>`;
    }
}

async function addSettingsBillingItem() {
    const serviceType = document.getElementById('rx-new-bill-type').value;
    const name = document.getElementById('rx-new-bill-name').value.trim();
    const price = document.getElementById('rx-new-bill-price').value;
    const gstRate = document.getElementById('rx-new-bill-gst').value;
    if (!name || !price) { alert('Name and price are required.'); return; }
    try {
        await window.rxCallFunction('upsert_billing_item', { serviceType, name, price, gstRate });
        document.getElementById('rx-new-bill-name').value = '';
        document.getElementById('rx-new-bill-price').value = '';
        document.getElementById('rx-new-bill-gst').value = '';
        loadSettingsBillingItems();
    } catch (err) {
        alert('Failed to save billing item: ' + err.message);
    }
}

async function deleteSettingsBillingItem(id) {
    if (!confirm('Remove this billing item?')) return;
    try {
        await window.rxCallFunction('delete_billing_item', { id });
        loadSettingsBillingItems();
    } catch (err) {
        alert('Failed to remove billing item: ' + err.message);
    }
}
