import { createScene } from "./scene.js";
import {
  addConsultation, createPatient, decideDoctorRegistration, getConsultations, getDoctorProfile,
  getDoctorRegistrations, getMetrics, getPatient, getHealth, getPatients, getPresets, getSchema,
  predict, saveDoctorProfile, updatePatient,
} from "./api.js";
import { probToCSS, riskLabel, pct } from "./colors.js";
import {
  currentUser, firebaseConfigured, initializeFirebaseAuth, logOut, registerWithEmail,
  rememberedDoctorId, rememberDoctorId, sendPasswordReset, signInWithEmail,
  signInWithGoogle, watchAuth,
} from "./auth.js";

const $ = (s, r = document) => r.querySelector(s);
const el = (t, props = {}, html = "") => Object.assign(Object.assign(document.createElement(t), props), html ? { innerHTML: html } : {});
const TARGET_LABEL = { cad: "Overall CAD", lad: "LAD", lcx: "LCX", rca: "RCA" };
const CHIP = (p) => `<span class="chip" style="background:${probToCSS(p)}">${riskLabel(p)}</span>`;

const state = {
  schema: [], values: {}, result: null, target: "cad", selected: null, scene: null,
  ctrl: null, metrics: null, user: null, profile: null, token: null, booted: false,
  patients: [], selectedPatient: null,
};

// ---------- form (generated from /api/schema, so new features need no UI code) ----------
function buildForm() {
  const host = $("#form"); host.innerHTML = "";
  const cats = [...new Set(state.schema.map(f => f.category))];
  cats.forEach((cat, i) => {
    const d = el("details", { open: i < 2 }); d.append(el("summary", {}, cat));
    const wrap = el("div", { className: "fields" });
    for (const f of state.schema.filter(x => x.category === cat)) wrap.append(field(f));
    d.append(wrap); host.append(d);
  });
}
function field(f) {
  const w = el("div", { className: "field" }), id = "f_" + f.name.replace(/\W/g, "_");
  const unit = f.unit ? ` <span class="muted">${f.unit}</span>` : "";
  const lab = el("label", { htmlFor: id }, `<span>${f.label}${unit}</span><b data-val="${f.name}"></b>`);
  w.append(lab);
  const set = (v) => { state.values[f.name] = Number(v); $(`[data-val="${f.name}"]`, w).textContent = display(f, v); schedule(); };
  if (f.options) {
    const s = el("select", { id }); for (const [k, v] of Object.entries(f.options)) s.append(el("option", { value: k }, v));
    s.value = String(Math.round(state.values[f.name])); s.oninput = () => set(s.value); w.append(s); w._sync = (v) => { s.value = String(Math.round(v)); $(`[data-val="${f.name}"]`, w).textContent = display(f, v); };
  } else {
    const step = (f.max - f.min) > 100 ? 1 : (f.max - f.min) > 10 ? 0.5 : 0.1;
    const lo = Math.floor(f.min - (f.max - f.min) * 0.05), hi = Math.ceil(f.max + (f.max - f.min) * 0.05);
    const row = el("div", { className: "num" });
    const r = el("input", { type: "range", min: lo, max: hi, step, value: state.values[f.name] });
    const n = el("input", { type: "number", id, step, value: state.values[f.name], "aria-label": f.label });
    r.oninput = () => { n.value = r.value; set(r.value); };
    n.oninput = () => { if (n.value !== "") { r.value = n.value; set(n.value); } };
    row.append(r, n); w.append(row);
    w._sync = (v) => { r.value = n.value = Number(v).toFixed(step < 1 ? 1 : 0); $(`[data-val="${f.name}"]`, w).textContent = ""; };
  }
  queueMicrotask(() => { $(`[data-val="${f.name}"]`, w).textContent = f.options ? display(f, state.values[f.name]) : ""; });
  w.dataset.name = f.name; return w;
}
const display = (f, v) => f.options ? (f.options[String(Math.round(v))] ?? v) : v;
function setAll(values) {
  for (const f of state.schema) {
    state.values[f.name] = values[f.name] ?? f.default;
    const w = $(`.field[data-name="${CSS.escape(f.name)}"]`); w?._sync?.(state.values[f.name]);
  }
  schedule(0);
}

// ---------- prediction (debounced, cancels stale requests => live updates) ----------
let timer, ctl;
function schedule(delay = 300) { clearTimeout(timer); timer = setTimeout(run, delay); }
async function run() {
  ctl?.abort(); ctl = new AbortController();
  setStatus("Predicting…");
  try {
    state.result = await predict(state.values, ctl.signal, state.token);
    setStatus("Live · updated"); render();
    state.scene?.setProbabilities(state.result.probabilities);
  } catch (e) { if (e.name !== "AbortError") setStatus("API unreachable — is the backend running?", true); }
}
const setStatus = (t, err) => { const s = $("#status"); s.textContent = t; s.classList.toggle("err", !!err); };

// ---------- rendering ----------
function render() {
  const r = state.result, P = r.probabilities;
  const cad = P.cad, pos = cad >= 0.5;
  $("#cad-card").innerHTML = `<div class="lbl">Overall coronary artery disease</div>
    <div class="row"><span class="verdict" style="color:${probToCSS(cad)}">${pos ? "CAD likely" : "CAD unlikely"}</span><span class="p">${pct(cad)}</span></div>
    <div class="meter"><i style="width:${cad * 100}%;background:${probToCSS(cad)}"></i></div>
    <div class="muted small" style="margin-top:6px">Predicted probability of ≥50% narrowing in a major vessel · ${CHIP(cad)}</div>`;
  const rows = $("#vessel-rows"); rows.innerHTML = "";
  for (const v of ["lad", "lcx", "rca"]) {
    const b = el("button", { className: "vrow" + (state.selected === v.toUpperCase() ? " sel" : ""), title: "Select in 3D view" },
      `<span class="nm">${v.toUpperCase()}</span><span class="meter"><i style="width:${P[v] * 100}%;background:${probToCSS(P[v])}"></i></span><span class="v">${pct(P[v])} ${CHIP(P[v])}</span>`);
    b.onclick = () => state.scene.select(v.toUpperCase(), true);
    rows.append(b);
  }
  const seg = $("#target-seg"); seg.innerHTML = "";
  for (const t of Object.keys(TARGET_LABEL)) {
    const b = el("button", { className: t === state.target ? "on" : "" }, TARGET_LABEL[t]);
    b.onclick = () => { state.target = t; render(); }; seg.append(b);
  }
  drivers(); vesselCard();
}
function drivers() {
  const r = state.result, t = state.target, ex = r.explanations[t];
  $("#explain-note").textContent = `${TARGET_LABEL[t]} · model: ${r.model[t]}. Red bars push this patient's risk up, blue bars push it down (SHAP values), shown with each measurement's relative share of the explanation.`;
  const mx = Math.max(...ex.map(e => Math.abs(e.contribution))) || 1;
  $("#drivers").innerHTML = ex.map(e => {
    const w = Math.abs(e.contribution) / mx * 50, up = e.contribution > 0;
    const val = e.display ?? `${Number(e.value.toFixed(2))}${e.unit ? " " + e.unit : ""}`;
    return `<div class="drv"><div class="n" title="${e.label}">${e.label} <small>= ${val}</small></div><div class="s">${up ? "▲" : "▼"} ${(e.share * 100).toFixed(0)}%</div>
      <div class="diverge"><i style="${up ? `left:50%` : `right:50%`};width:${w}%;background:var(${up ? "--up" : "--down"})"></i></div></div>`;
  }).join("") + `<div class="axis"><span>◀ lowers risk</span><span>raises risk ▶</span></div>`;
}
function vesselCard() {
  const c = $("#vcard"), v = state.selected;
  if (!v || !state.result) { c.hidden = true; return; }
  const k = v.toLowerCase(), p = state.result.probabilities[k], info = state.scene.VESSELS[v];
  const top = state.result.explanations[k].slice(0, 3);
  c.hidden = false;
  c.innerHTML = `<button class="x" aria-label="Close">×</button><h4>${info.name}</h4><div class="sup">Supplies: ${info.supplies}</div>
    <div class="big"><b style="color:${probToCSS(p)}">${pct(p)}</b>${CHIP(p)}</div><div class="muted small">AI-predicted vessel stenosis probability · not a confirmed diagnosis</div>
    <ul>${top.map(e => `<li><span>${e.label}</span><span style="color:var(--${e.contribution > 0 ? "up" : "down"})">${e.contribution > 0 ? "▲ raises" : "▼ lowers"}</span></li>`).join("")}</ul>`;
  $(".x", c).onclick = () => state.scene.select(null);
}

// ---------- model-performance tab ----------
function perfTab() {
  const m = state.metrics, host = $("#tab-perf"); if (!m) return;
  const f = (x) => x.toFixed(3);
  const sel = Object.entries(m.selected).map(([t, s]) => `<tr class="best"><td>${t.toUpperCase()}</td><td>${s.model}</td><td>${f(s.accuracy)}</td><td>${f(s.precision)}</td><td>${f(s.recall)}</td><td>${f(s.f1)}</td><td>${f(s.roc_auc)}</td></tr>`).join("");
  const bestBy = Object.fromEntries(Object.entries(m.selected).map(([t, s]) => [t.toUpperCase(), s.model]));
  const all = m.cv_all.map(r => `<tr class="${bestBy[r.target] === r.model ? "best" : ""}"><td>${r.target}</td><td>${r.model}</td><td>${f(r.accuracy)}</td><td>${f(r.precision)}</td><td>${f(r.recall)}</td><td>${f(r.f1)}</td><td>${f(r.roc_auc)}±${r.roc_auc_std.toFixed(2)}</td></tr>`).join("");
  const head = "<tr><th>Target</th><th>Model</th><th>Acc</th><th>Prec</th><th>Rec</th><th>F1</th><th>AUC</th></tr>";
  host.innerHTML = `<h3>Deployed models (calibrated, out-of-fold)</h3><p class="muted small">5-fold stratified cross-validated predictions on 303 patients; threshold 0.5.</p><table>${head}${sel}</table>
    <h3 style="margin-top:16px">Model comparison (5-fold × 3 repeats)</h3><p class="muted small">Mean over 15 folds. Highlighted = selected by ROC-AUC.</p><table>${head}${all}</table>
    <img src="/results/roc_curves.png" alt="ROC curves" onerror="this.remove()">`;
}

// ---------- authenticated patient management ----------
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const formValue = (form, name) => form.elements.namedItem(name).value.trim();
const authToken = async () => {
  const user = currentUser();
  if (!user) throw new Error("Your session ended. Please sign in again.");
  state.token = await user.getIdToken();
  return state.token;
};
function showNotice(message, error = false) {
  const notice = $("#app-notice");
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.hidden = !message;
}
function fillPatientForm(patient, editMode = false) {
  const form = $("#patient-form");
  form.elements.namedItem("record_id").value = patient?.id ?? "";
  for (const field of ["patient_code", "name", "date_of_birth", "age", "sex", "contact", "medical_history"]) {
    form.elements.namedItem(field).value = patient?.[field] ?? "";
  }
  for (const field of ["consultation_date", "symptoms", "diagnosis", "test_results", "treatment", "notes"]) {
    form.elements.namedItem(field).value = "";
  }
  form.elements.namedItem("include_ai_prediction").checked = false;
  form.elements.namedItem("consultation_date").value = new Date().toISOString().slice(0, 10);
  form.elements.namedItem("patient_code").disabled = Boolean(patient);
  $("#patient-form-title").textContent = patient ? `Patient: ${patient.name}` : "Add patient and consultation";
  form.querySelector('[type="submit"]').hidden = Boolean(patient) || !isMaster();
  $("#save-consultation").hidden = !patient;
  $("#update-patient").hidden = !patient;
  $("#view-history").hidden = !patient;
  $("#update-patient").dataset.editMode = String(editMode);
  state.selectedPatient = patient ?? null;
}
const isMaster = () => state.profile?.role === "master";
function patientDetailsFromForm(form) {
  const ageText = formValue(form, "age");
  return {
    patient_code: formValue(form, "patient_code"),
    name: formValue(form, "name"),
    date_of_birth: formValue(form, "date_of_birth") || null,
    age: ageText ? Number(ageText) : null,
    sex: formValue(form, "sex"),
    contact: formValue(form, "contact"),
    medical_history: formValue(form, "medical_history"),
  };
}
function consultationFromForm(form) {
  return {
    consultation_date: formValue(form, "consultation_date"),
    symptoms: formValue(form, "symptoms"),
    diagnosis: formValue(form, "diagnosis"),
    test_results: formValue(form, "test_results"),
    treatment: formValue(form, "treatment"),
    notes: formValue(form, "notes"),
    ai_prediction: form.elements.namedItem("include_ai_prediction").checked && state.result ? {
      probabilities: state.result.probabilities,
      model: state.result.model,
      inputs: { ...state.values },
      generated_at: new Date().toISOString(),
      disclaimer: "AI-generated estimate; not a confirmed clinical diagnosis.",
    } : null,
  };
}
async function loadPatientRows(search = "") {
  const token = await authToken();
  $("#patients-loading").hidden = false;
  try {
    state.patients = await getPatients(token, search);
    renderPatientRows();
    return state.patients;
  } finally {
    $("#patients-loading").hidden = true;
  }
}
function renderPatientRows() {
  const tbody = $("#patient-table-body");
  tbody.innerHTML = state.patients.map((patient) => `<tr>
    <td>${escapeHTML(patient.patient_code)}</td><td>${escapeHTML(patient.name)}</td>
    <td>${escapeHTML(patient.latest_consultation_date)}</td><td>${escapeHTML(patient.latest_diagnosis)}</td>
    <td class="table-actions"><button data-action="view" data-id="${escapeHTML(patient.id)}">View</button>
    <button data-action="edit" data-id="${escapeHTML(patient.id)}">Edit</button>
    <button data-action="history" data-id="${escapeHTML(patient.id)}">History</button></td></tr>`).join("");
  $("#patient-empty").hidden = state.patients.length > 0;
}
async function loadDashboard() {
  const patients = await loadPatientRows();
  $("#patient-count").textContent = String(patients.length);
  $("#consultation-count").textContent = String(patients.reduce((n, patient) => n + Number(patient.consultation_count ?? 0), 0));
  $("#recent-patients").innerHTML = patients.slice(0, 5).map((patient) =>
    `<button class="recent-record" data-patient-id="${escapeHTML(patient.id)}"><strong>${escapeHTML(patient.name)}</strong><span>${escapeHTML(patient.latest_consultation_date)} · ${escapeHTML(patient.latest_diagnosis)}</span></button>`
  ).join("") || `<p class="muted">No patient records yet.</p>`;
}
async function loadDoctorRegistrations() {
  const registrations = await getDoctorRegistrations(await authToken());
  const tbody = $("#doctor-registration-body");
  tbody.innerHTML = registrations.map((doctor) => `<tr>
    <td>${escapeHTML(doctor.full_name)}</td><td>${escapeHTML(doctor.email)}</td>
    <td>${escapeHTML(doctor.doctor_id)}</td><td>${escapeHTML(doctor.status)}</td>
    <td class="table-actions">${doctor.status !== "approved" ? `
      <button data-doctor-action="approved" data-uid="${escapeHTML(doctor.uid)}">Approve</button>
      <button data-doctor-action="rejected" data-uid="${escapeHTML(doctor.uid)}">Reject</button>` : "—"}</td></tr>`).join("");
  $("#doctor-registration-empty").hidden = registrations.length > 0;
}
async function showHistory(patientId) {
  const patient = await getPatient(await authToken(), patientId);
  const consultations = await getConsultations(state.token, patientId);
  $("#history-patient-name").textContent = patient.name;
  $("#consultation-list").innerHTML = consultations.map((item) => `<details class="consultation">
    <summary>${escapeHTML(item.consultation_date)} — ${escapeHTML(item.diagnosis || "Consultation")}</summary>
    <dl><dt>Symptoms</dt><dd>${escapeHTML(item.symptoms)}</dd><dt>Test results</dt><dd>${escapeHTML(item.test_results)}</dd>
    <dt>Treatment</dt><dd>${escapeHTML(item.treatment)}</dd><dt>Doctor's notes</dt><dd>${escapeHTML(item.notes)}</dd>
    ${item.ai_prediction ? `<dt>Saved AI estimate</dt><dd>${escapeHTML(JSON.stringify(item.ai_prediction.probabilities ?? {}))}<br><small>AI output; not a confirmed diagnosis.</small></dd>` : ""}</dl>
    </details>`).join("") || `<p class="muted">No consultation history recorded.</p>`;
  $("#patient-history").hidden = false;
  showPage("patients");
  $("#patient-history").scrollIntoView({ behavior: "smooth", block: "start" });
}
function showPage(page) {
  if (page === "doctor-approvals" && !isMaster()) return;
  if (page === "patient-form" && !isMaster() && !state.selectedPatient) return;
  for (const name of ["risk", "dashboard", "patient-form", "patients", "profile"]) {
    $(`#page-${name}`).hidden = name !== page;
  }
  $("#page-doctor-approvals").hidden = page !== "doctor-approvals";
  document.querySelectorAll(".app-nav [data-page]").forEach((button) => {
    button.classList.toggle("on", button.dataset.page === page);
  });
  if (page === "risk") {
    requestAnimationFrame(() => state.scene?.resize());
  } else if (page === "dashboard") {
    loadDashboard().catch((error) => showNotice(error.message, true));
  } else if (page === "patients") {
    loadPatientRows($("#patient-search").value).catch((error) => showNotice(error.message, true));
  } else if (page === "doctor-approvals") {
    loadDoctorRegistrations().catch((error) => showNotice(error.message, true));
  } else if (page === "profile") {
    const user = state.user, profile = state.profile;
    $("#profile-details").innerHTML = `<dl class="profile-list"><dt>Name</dt><dd>${escapeHTML(profile.full_name)}</dd>
      <dt>Email</dt><dd>${escapeHTML(user.email)}</dd><dt>Role</dt><dd>${escapeHTML(profile.role)}</dd>
      ${profile.role === "doctor" ? `<dt>Doctor ID</dt><dd>${escapeHTML(profile.doctor_id)}</dd>
      <dt>Approval</dt><dd>${escapeHTML(profile.status)}</dd>` : ""}</dl>`;
  }
}
async function refreshSelectedPatient() {
  const patient = await getPatient(await authToken(), state.selectedPatient.id);
  fillPatientForm(patient, true);
}
function bindPatientUI() {
  document.querySelectorAll(".app-nav [data-page]").forEach((button) => {
    button.onclick = () => showPage(button.dataset.page);
  });
  $("#patient-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!isMaster()) {
      showNotice("Only the master can add patient records.", true);
      return;
    }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const patient = patientDetailsFromForm(form);
    if (patient.age === null && !patient.date_of_birth) {
      showNotice("Enter either patient age or date of birth.", true);
      return;
    }
    if (form.elements.namedItem("include_ai_prediction").checked && !state.result) {
      showNotice("Run an AI risk assessment before attaching its estimate.", true);
      return;
    }
    try {
      const created = await createPatient(await authToken(), {
        ...patient, consultation: consultationFromForm(form),
      });
      showNotice(`Patient record ${created.patient_code} and consultation saved.`);
      fillPatientForm(null);
      await loadPatientRows();
    } catch (error) { showNotice(error.message, true); }
  };
  $("#save-consultation").onclick = async () => {
    if (!$("#patient-form").reportValidity() || !state.selectedPatient) return;
    if ($("#patient-form").elements.namedItem("include_ai_prediction").checked && !state.result) {
      showNotice("Run an AI risk assessment before attaching its estimate.", true);
      return;
    }
    try {
      await addConsultation(await authToken(), state.selectedPatient.id, consultationFromForm($("#patient-form")));
      showNotice("New consultation saved; previous history is preserved.");
      await refreshSelectedPatient();
      await showHistory(state.selectedPatient.id);
    } catch (error) { showNotice(error.message, true); }
  };
  $("#update-patient").onclick = async () => {
    const form = $("#patient-form");
    if (!form.reportValidity() || !state.selectedPatient) return;
    const patient = patientDetailsFromForm(form);
    if (patient.age === null && !patient.date_of_birth) {
      showNotice("Enter either patient age or date of birth.", true);
      return;
    }
    try {
      await updatePatient(await authToken(), state.selectedPatient.id, patient);
      showNotice("Patient details updated.");
      await loadPatientRows();
    } catch (error) { showNotice(error.message, true); }
  };
  $("#clear-patient-form").onclick = () => {
    $("#patient-form").reset();
    $("#patient-history").hidden = true;
    fillPatientForm(null);
    showNotice("");
  };
  $("#view-history").onclick = () => state.selectedPatient && showHistory(state.selectedPatient.id)
    .catch((error) => showNotice(error.message, true));
  $("#patient-search").oninput = () => {
    clearTimeout(window.patientSearchTimer);
    window.patientSearchTimer = setTimeout(() => loadPatientRows($("#patient-search").value)
      .catch((error) => showNotice(error.message, true)), 250);
  };
  $("#patient-table-body").onclick = async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    try {
      const patient = await getPatient(await authToken(), button.dataset.id);
      if (button.dataset.action === "history") {
        await showHistory(patient.id);
      } else {
        fillPatientForm(patient, button.dataset.action === "edit");
        showPage("patient-form");
      }
    } catch (error) { showNotice(error.message, true); }
  };
  $("#recent-patients").onclick = (event) => {
    const button = event.target.closest("[data-patient-id]");
    if (button) showHistory(button.dataset.patientId).catch((error) => showNotice(error.message, true));
  };
  $("#doctor-registration-body").onclick = async (event) => {
    const button = event.target.closest("button[data-doctor-action]");
    if (!button) return;
    button.disabled = true;
    try {
      await decideDoctorRegistration(await authToken(), button.dataset.uid, button.dataset.doctorAction);
      showNotice(`Doctor registration ${button.dataset.doctorAction}.`);
      await loadDoctorRegistrations();
    } catch (error) {
      button.disabled = false;
      showNotice(error.message, true);
    }
  };
}

// ---------- authenticated app startup ----------
async function bootApplication(user, profile) {
  state.user = user;
  state.profile = profile;
  state.token = await user.getIdToken();
  $("#auth-screen").hidden = true;
  $("#app-shell").hidden = false;
  const displayName = profile.full_name || user.displayName || user.email;
  $("#doctor-label").textContent = `${displayName} · ${user.email} · ${profile.role}`;
  $("#doctor-avatar").textContent = Array.from(displayName.trim())[0]?.toLocaleUpperCase() ?? "?";
  document.querySelector('[data-page="doctor-approvals"]').hidden = !isMaster();
  document.querySelector('[data-page="patient-form"]').hidden = !isMaster();
  $("#page-dashboard h2").textContent = isMaster() ? "Master dashboard" : "Doctor dashboard";
  $("#page-dashboard>p").textContent = isMaster()
    ? "Patient records and doctor registrations managed by the master account."
    : "Records and consultations assigned to your approved doctor account.";
  $("#page-profile h2").textContent = isMaster() ? "Master profile" : "Doctor profile";
  if (state.booted) {
    showPage("risk");
    return;
  }
  try {
    [state.schema, state.presets, state.metrics] = await Promise.all([
      getSchema(), getPresets(state.token), getMetrics().catch(() => null),
    ]);
  } catch (e) {
    $("#app-shell").hidden = true;
    $("#auth-screen").hidden = false;
    setAuthMessage("Unable to load CardioScope3D. Check that the backend is running and configured.", true);
    return;
  }
  for (const f of state.schema) state.values[f.name] = f.default;
  buildForm(); perfTab();
  bindPatientUI();
  const pb = $("#presets");
  const reset = el("button", {}, "Median patient"); reset.onclick = () => setAll({}); pb.append(reset);
  for (const [name, vals] of Object.entries(state.presets)) { const b = el("button", {}, name.replace(" example", "")); b.onclick = () => setAll(vals); pb.append(b); }
  document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === t));
    $("#tab-risk").hidden = t.dataset.tab !== "risk"; $("#tab-perf").hidden = t.dataset.tab !== "perf";
  });
  $("#viewbar").onclick = (e) => {
    if (e.target.dataset.v === "reset") state.scene.setView("front");
    else if (e.target.dataset.v) state.scene.setView(e.target.dataset.v);
  };
  const tip = $("#tip");
  state.scene = await createScene($("#c"), {
    onModelStatus(status, message) {
      const node = $("#model-status");
      node.dataset.state = status;
      $("#model-status-text").textContent = message;
    },
    onSelect(v) { state.selected = v; if (v) state.target = v.toLowerCase(); else if (state.target !== "cad") state.target = "cad"; if (state.result) render(); },
    onHover(v, e) {
      if (!v || !e) { tip.hidden = true; return; }
      const r = $(".stage").getBoundingClientRect(), p = state.result?.probabilities[v.toLowerCase()];
      tip.hidden = false; tip.style.left = e.clientX - r.left + 14 + "px"; tip.style.top = e.clientY - r.top + 14 + "px";
      tip.innerHTML = `<b>${v}</b>${p != null ? ` · AI prediction ${pct(p)} (${riskLabel(p)})` : " · No prediction yet"}`;
    },
  });
  state.booted = true;
  setAll(state.presets["Low-risk example"] ?? {});
  showPage("risk");
}

// ---------- authentication and doctor approval ----------
function setAuthMessage(text, isError = false) {
  const node = $("#auth-error");
  node.textContent = text;
  node.classList.toggle("error", isError);
  node.hidden = !text;
}
function firebaseErrorMessage(error) {
  const known = {
    "auth/email-already-in-use": "An account already exists for this email.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/weak-password": "Use a password with at least 8 characters, including upper- and lowercase letters and a number.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/unauthorized-domain": "Add this site to the authorized domains in Firebase Authentication settings.",
  };
  return known[error.code] ?? error.message ?? "Authentication failed. Please try again.";
}
function showAuthMode(mode) {
  $("#login-form").hidden = mode !== "login";
  $("#register-form").hidden = mode !== "register";
  $("#doctor-onboarding").hidden = mode !== "onboarding";
  $("#approval-wait").hidden = mode !== "pending";
  $("#google-login").hidden = mode === "onboarding" || mode === "pending";
  setAuthMessage("");
}
async function handleAuthState(user) {
  if (!user) {
    state.user = null;
    state.profile = null;
    state.token = null;
    state.result = null;
    state.values = {};
    state.patients = [];
    state.selectedPatient = null;
    $("#app-shell").hidden = true;
    $("#auth-screen").hidden = false;
    if (state.scene) { state.scene.dispose?.(); state.scene = null; }
    state.booted = false;
    if ($("#auth-config-warning")) $("#auth-config-warning").hidden = firebaseConfigured;
    showAuthMode("login");
    return;
  }
  if (!user.emailVerified) {
    $("#auth-screen").hidden = false;
    $("#app-shell").hidden = true;
    showAuthMode("login");
    setAuthMessage("Verify your email using the link sent by Firebase, then sign in again.", true);
    return;
  }
  $("#auth-screen").hidden = false;
  $("#app-shell").hidden = true;
  try {
    const token = await user.getIdToken();
    const profile = await getDoctorProfile(token);
    if (profile?.role === "master") {
      await bootApplication(user, profile);
      return;
    }
    if (!profile?.doctor_id) {
      showAuthMode("onboarding");
      $("#doctor-onboarding").elements.namedItem("full_name").value = user.displayName ?? "";
      $("#doctor-onboarding").elements.namedItem("doctor_id").value = rememberedDoctorId();
      return;
    }
    if (profile.status !== "approved") {
      showAuthMode("pending");
      $("#approval-message").textContent = profile.status === "rejected"
        ? "Your doctor registration was rejected. Contact the master administrator if you believe this is an error."
        : "Your registration is submitted for approval. Patient records and AI prediction remain unavailable until the master approves your doctor profile.";
      return;
    }
    await bootApplication(user, profile);
  } catch (error) {
    showAuthMode("login");
    setAuthMessage(error.message, true);
  }
}
function bindAuthUI() {
  $("#show-register").onclick = () => showAuthMode("register");
  $("#show-login").onclick = () => showAuthMode("login");
  $("#login-form").onsubmit = async (event) => {
    event.preventDefault();
    setAuthMessage("");
    try {
      const form = event.currentTarget;
      const user = await signInWithEmail(form.elements.email.value.trim(), form.elements.password.value);
      if (!user.emailVerified) {
        await logOut();
        setAuthMessage("Verify your email using the link sent by Firebase, then sign in again.", true);
      }
    } catch (error) { setAuthMessage(firebaseErrorMessage(error), true); }
  };
  $("#register-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = form.elements.password.value;
    if (password !== form.elements.confirm_password.value) {
      setAuthMessage("Password and confirmation do not match.", true);
      return;
    }
    if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      setAuthMessage("Password must be at least 8 characters and include upper- and lowercase letters and a number.", true);
      return;
    }
    try {
      rememberDoctorId(form.elements.doctor_id.value);
      await registerWithEmail({
        fullName: form.elements.full_name.value.trim(),
        email: form.elements.email.value.trim(),
        password,
      });
      showAuthMode("login");
      setAuthMessage("Account created. Verify your email, then sign in and submit your doctor registration for approval.");
    } catch (error) { setAuthMessage(firebaseErrorMessage(error), true); }
  };
  $("#google-login").onclick = async () => {
    try { await signInWithGoogle(); }
    catch (error) { setAuthMessage(firebaseErrorMessage(error), true); }
  };
  $("#forgot-password").onclick = async () => {
    const email = $("#login-form").elements.email.value.trim();
    if (!email) { setAuthMessage("Enter your email address first.", true); return; }
    try {
      await sendPasswordReset(email);
      setAuthMessage("If an account exists for that email, Firebase has sent a password-reset link.");
    } catch (error) { setAuthMessage(firebaseErrorMessage(error), true); }
  };
  $("#doctor-onboarding").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const profile = await saveDoctorProfile(await authToken(), {
        full_name: form.elements.full_name.value.trim(),
        doctor_id: form.elements.doctor_id.value.trim(),
      });
      state.profile = profile;
      await handleAuthState(currentUser());
    } catch (error) { setAuthMessage(error.message, true); }
  };
  const logout = async () => {
    try { await logOut(); window.location.reload(); }
    catch (error) { setAuthMessage(firebaseErrorMessage(error), true); }
  };
  $("#logout").onclick = logout;
  $("#pending-logout").onclick = logout;
  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    button.onclick = () => {
      const input = button.parentElement.querySelector("input");
      input.type = input.type === "password" ? "text" : "password";
      button.textContent = input.type === "password" ? "Show" : "Hide";
    };
  });
}

async function checkBackendConnection() {
  const status = $("#backend-status");
  status.dataset.state = "connecting";
  status.textContent = "Connecting to CardioScope3D backend…";
  try {
    const health = await getHealth();
    const count = Array.isArray(health.targets) ? health.targets.length : 0;
    status.dataset.state = "connected";
    status.textContent = `Backend connected · ${count} prediction models available.`;
  } catch {
    status.dataset.state = "offline";
    status.textContent = "Backend unavailable · start FastAPI at http://127.0.0.1:8000.";
  }
}

async function start() {
  bindAuthUI();
  checkBackendConnection();
  if (!firebaseConfigured) {
    $("#auth-config-warning").hidden = false;
    $("#google-login").disabled = true;
    $("#login-form").querySelector('[type="submit"]').disabled = true;
    $("#register-form").querySelector('[type="submit"]').disabled = true;
    return;
  }
  try {
    const auth = await initializeFirebaseAuth();
    watchAuth((user) => { handleAuthState(user); });
  } catch (error) {
    setAuthMessage(error.message, true);
  }
}
start();
