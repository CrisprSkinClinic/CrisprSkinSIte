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
    document.getElementById('rx-select-phone').value = '';
    document.getElementById('rx-select-status').textContent = '';
    document.getElementById('rx-select-found').classList.add('hidden');
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

    contentArea.innerHTML = '<div style="text-align:center; padding:40px; color:#cbd5e1;"><i data-lucide="loader-2" class="w-8 h-8 animate-spin"></i></div>';
    if (window.lucide) lucide.createIcons();
    modal.classList.add('modal-visible');

    try {
        const rxData = await window.rxCallFunction('get_rx_by_id', { rxId });
        contentArea.innerHTML = generateStaticRxHtml(rxData);
        dateLabel.textContent = new Date(rxData.created_at || Date.now()).toLocaleDateString();
        document.getElementById('btn-copy-rx').onclick = () => copyHistoryToActive(rxData);
    } catch (err) {
        contentArea.innerHTML = `<div style="text-align:center; padding:20px; color:red;">Error: ${escapeHtml(err.message)}</div>`;
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
        html += `<div class="photo-item"><img src="${photo.drive_file_url}" alt="Clinical photo"></div>`;
    });
    if (RxApp.state.photos.length < 6) {
        html += `<div class="photo-item" onclick="triggerPhotoUpload()"><div class="photo-placeholder"><i data-lucide="plus" class="w-6 h-6 mb-1"></i><span style="font-size: 9px; font-weight: 600;">ADD NEW</span></div></div>`;
    }
    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

function triggerPhotoUpload() {
    // Actual upload to Google Drive happens via a separate
    // drive-upload Netlify function (not yet built as of this port --
    // requires the Drive service account to be finalized first).
    alert('Photo upload is not yet connected -- this needs the Google Drive integration to be finished first.');
}

function handleLabUpload() {
    alert('Lab report upload is not yet connected -- this needs the Google Drive integration to be finished first.');
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
    try {
        const result = await window.rxCallFunction('save_prescription', getPrescriptionData('final'));
        updateSaveStatus('Prescription saved successfully');
        // PDF generation is a separate, not-yet-built step (private
        // Supabase Storage, per the explicit decision against public
        // Drive links) -- for now, the saved prescription is
        // confirmed via the on-screen status message, and can be
        // reviewed via Preview or the patient's Rx history.
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
                    <button class="lab-action" onclick="openLabInNewTab('${escapeHtml(report.drive_file_url || '')}')">↗</button>
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
    iframe.src = normalizeLabUrl(reports[index].drive_file_url);
    title.textContent = `${reports[index].test_name} • ${new Date(reports[index].report_date).toLocaleDateString()}`;
    document.getElementById('lab-note-input').value = reports[index].note || '';
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    highlightActiveLab(index);
}

function normalizeLabUrl(url) {
    if (!url) return '';
    return url.includes('/view') ? url.replace('/view', '/preview') : url;
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

function openLabInNewTab(url) {
    if (!url) { alert('Lab report not available'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
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
