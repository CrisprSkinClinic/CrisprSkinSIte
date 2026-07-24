// netlify/functions/generate-prescription-pdf.js
//
// Renders a saved prescription as a PDF using pdfkit (pure JS, no
// headless browser needed -- chosen over Puppeteer/chrome-aws-lambda
// for a much smaller function bundle and faster cold starts, which
// matters more here than pixel-perfect HTML rendering fidelity for a
// fairly simple, structured document like a prescription), then
// uploads it to the private derm-rx-prescriptions Supabase Storage
// bucket and records the storage path on the prescription row.
//
// The PDF is NEVER made public -- Supabase Storage buckets default to
// requiring the service-role key (used here) or a signed URL to
// read; no public URL is ever generated at upload time. Viewing/
// sharing goes through get-prescription-pdf-url.js, which mints a
// short-lived signed URL on demand, matching the same principle
// already applied to Drive-hosted lab reports/photos.

const { createServiceRoleClient } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");
const PDFDocument = require("pdfkit");

const STORAGE_BUCKET = "derm-rx-prescriptions";

function buildPdfBuffer(rx, doctor) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc.fontSize(18).font("Helvetica-Bold").text(doctor.name || "Doctor", { align: "center" });
    if (doctor.qualification) {
      doc.fontSize(10).font("Helvetica").fillColor("#555").text(doctor.qualification, { align: "center" });
    }
    if (doctor.reg_number) {
      doc.fontSize(9).fillColor("#888").text(`Reg. No: ${doctor.reg_number}`, { align: "center" });
    }
    doc.moveDown(0.5);
    doc.strokeColor("#000").lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);
    doc.fillColor("#000");

    // Patient info
    const dateStr = new Date(rx.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    doc.fontSize(11).font("Helvetica-Bold").text(`Patient: `, { continued: true }).font("Helvetica").text(rx.patient_name || "-");
    doc.font("Helvetica-Bold").text(`Age/Sex: `, { continued: true }).font("Helvetica").text(`${rx.patient_age || "-"}/${rx.patient_gender || "-"}`);
    doc.font("Helvetica-Bold").text(`Date: `, { continued: true }).font("Helvetica").text(dateStr);
    doc.moveDown(1);

    if (rx.complaints) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#4f46e5").text("COMPLAINTS");
      doc.font("Helvetica").fontSize(10).fillColor("#000").text(rx.complaints);
      doc.moveDown(0.5);
    }

    if (rx.diagnosis) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#4f46e5").text("DIAGNOSIS");
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text(rx.diagnosis);
      doc.moveDown(0.5);
    }

    const medicines = rx.medicines || [];
    if (medicines.length > 0) {
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#000").text("R", { continued: true }).fontSize(9).text("x", { baseline: "top" });
      doc.moveDown(0.3);
      const colX = [50, 230, 320, 400];
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#666");
      doc.text("Medicine", colX[0], doc.y, { continued: false, width: 170 });
      const headerY = doc.y - doc.currentLineHeight();
      doc.text("Dose", colX[1], headerY, { width: 80 });
      doc.text("Duration", colX[2], headerY, { width: 70 });
      doc.text("Instructions", colX[3], headerY, { width: 145 });
      doc.moveDown(0.5);
      doc.strokeColor("#ddd").moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);

      medicines.forEach((med) => {
        const rowY = doc.y;
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(med.name || "", colX[0], rowY, { width: 170 });
        doc.font("Helvetica").fontSize(10).text(med.dose || "", colX[1], rowY, { width: 80 });
        doc.text(med.duration || "", colX[2], rowY, { width: 70 });
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#555").text(med.instructions || "", colX[3], rowY, { width: 145 });
        doc.moveDown(0.6);
      });
      doc.fillColor("#000");
      doc.moveDown(0.5);
    }

    if (rx.lab_tests && rx.lab_tests.length > 0) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#4f46e5").text("INVESTIGATIONS ADVISED");
      doc.font("Helvetica").fontSize(10).fillColor("#000").text(rx.lab_tests.join(", "));
      doc.moveDown(0.5);
    }

    if (rx.advice) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#4f46e5").text("ADVICE");
      doc.font("Helvetica").fontSize(10).fillColor("#000").text(rx.advice);
      doc.moveDown(0.5);
    }

    if (rx.review_date) {
      const reviewStr = new Date(rx.review_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(10).text(`Next Review: ${reviewStr}`);
    }

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text(doctor.name || "Doctor", { align: "right" });

    doc.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { supabase, errorResponse: clientError } = createServiceRoleClient();
  if (clientError) return clientError;

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { accessToken, rxId } = payload || {};
  const { profile, errorResponse: authError } = await verifyStaffAuth(supabase, accessToken);
  if (authError) return authError;
  if (profile.role !== "doctor") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only doctor accounts can generate prescription PDFs." }) };
  }
  if (!rxId) {
    return { statusCode: 400, body: JSON.stringify({ error: "rxId is required." }) };
  }

  try {
    const { data: rxRows, error: rxError } = await supabase.rpc("get_derm_rx_by_id", { p_rx_id: rxId });
    if (rxError) throw rxError;
    if (!rxRows || rxRows.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "Prescription not found." }) };
    }
    const rx = rxRows[0];

    const { data: patientRows, error: patientError } = await supabase.rpc("get_patient_profile_decrypted", { p_patient_id: rx.patient_id });
    if (patientError) throw patientError;
    const patient = patientRows && patientRows[0];

    const { data: doctorRows, error: doctorError } = await supabase
      .from("doctors")
      .select("name, qualification, reg_number")
      .eq("id", rx.doctor_id)
      .single();
    if (doctorError) throw doctorError;

    const age = patient?.dob
      ? Math.floor((Date.now() - new Date(patient.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      : null;

    const pdfBuffer = await buildPdfBuffer(
      { ...rx, patient_name: patient?.name, patient_age: age, patient_gender: patient?.gender },
      doctorRows
    );

    const storagePath = `${rx.patient_id}/${rxId}.pdf`;
    const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (uploadError) throw uploadError;

    const { error: updateError } = await supabase.rpc("update_derm_rx_prescription_pdf", { p_rx_id: rxId, p_pdf_url: storagePath });
    if (updateError) throw updateError;

    return { statusCode: 200, body: JSON.stringify({ success: true, storagePath }) };
  } catch (error) {
    console.error("generate-prescription-pdf error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Failed to generate PDF." }) };
  }
};
